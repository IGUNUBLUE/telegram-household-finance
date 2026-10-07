-- Presentation metadata is separate from immutable accounting results.
alter table private.outbox add column response_subjects jsonb,
 add column response_session bigint,
 add column superseded_by bigint references private.outbox(id),
 add column edit_target bigint,
 add column edit_mode text check(edit_mode in ('replace','resolve')),
 add column edit_done boolean not null default false;

create function private.finance_same_response_subjects(left_id bigint,right_id bigint) returns boolean
language sql stable security invoker set search_path='' as $$
 select coalesce(a.response_subjects=b.response_subjects and jsonb_array_length(a.response_subjects)>0
  and a.response_session=b.response_session and ae.actor=be.actor
  and ae.thread_id is not distinct from be.thread_id
  and (ae.created_at,ae.id)<(be.created_at,be.id),false)
 from private.outbox a join private.events ae on ae.id=a.event_id,
 private.outbox b join private.events be on be.id=b.event_id where a.id=left_id and b.id=right_id
$$;
create function private.finance_question_response(response_id bigint) returns boolean
language sql stable security invoker set search_path='' as $$
 select coalesce(b.result->>'status'='clarify' and jsonb_array_length(b.response_subjects)>0
  and not (b.result ?| array['receipt','receipts','transaction_id','proposal_id','account_created'])
  and not exists(select 1 from private.transactions t join private.events e on e.id=t.event_id
    where e.id=b.event_id or e.parent_event_id=b.event_id),false)
 from private.outbox b where b.id=response_id
$$;
create function private.finance_defer_question(response_id bigint) returns boolean
language sql stable security invoker set search_path='' as $$
 select coalesce(private.finance_question_response(b.id) and b.created_at>now()-interval '45 seconds'
  and b.delivery_part=0 and exists(select 1 from private.events newer
   where newer.actor=e.actor and newer.thread_id is not distinct from e.thread_id
    and (newer.created_at,newer.id)>(e.created_at,e.id) and newer.parent_event_id is null
    and (newer.state in ('new','working') or newer.turn_until>now()) and coalesce(newer.payload->>'callback','')=''
    and (nullif(newer.payload->>'replyTo','') is null
      or newer.payload->>'replyTo'=e.message_id::text
      or newer.payload->>'replyTo'=b.telegram_message_id::text)),false)
 from private.outbox b left join private.events e on e.id=b.event_id where b.id=response_id
$$;
revoke all on function private.finance_same_response_subjects(bigint,bigint),private.finance_question_response(bigint),private.finance_defer_question(bigint) from public,anon,authenticated;
grant execute on function private.finance_same_response_subjects(bigint,bigint),private.finance_question_response(bigint),private.finance_defer_question(bigint) to service_role;

alter function public.finance_queue(text,jsonb) rename to finance_queue_v1;
create function public.finance_queue(op text,data jsonb default '{}') returns jsonb
language plpgsql security invoker set search_path='' as $$
declare ev private.events%rowtype;o private.outbox%rowtype;previous private.outbox%rowtype;newer_id bigint;ok_v boolean;
begin
 if op not in ('outbox','delivery_check','edit_done') then return public.finance_queue_v1(op,data);end if;
 -- Match the existing writer order; no locks survive the RPC/network boundary.
 perform 1 from private.household where id=1 for update;
 if op='delivery_check' then
  select * into o from private.outbox where id=(data->>'id')::bigint for update;
  ok_v:=found and o.delivery_token=data->>'token' and o.lease_until>now() and o.sent_at is null and o.superseded_by is null;
  if ok_v and o.delivery_part=0 and private.finance_question_response(o.id) then
   select n.id into newer_id from private.outbox n join private.events ne on ne.id=n.event_id
    where private.finance_same_response_subjects(o.id,n.id) and (ne.turn_until is null or ne.turn_until<=now()) and n.superseded_by is null
    order by ne.created_at desc,ne.id desc limit 1;
   if found then
    update private.outbox set superseded_by=newer_id,delivery_token=null,lease_until=null where id=o.id;
    return jsonb_build_object('deliver',false);
   end if;
  end if;
  if ok_v and private.finance_defer_question(o.id) then
   update private.outbox set delivery_token=null,lease_until=null where id=o.id;
   return jsonb_build_object('deliver',false);
  end if;
  return jsonb_build_object('deliver',coalesce(ok_v,false));
 elsif op='edit_done' then
  update private.outbox set edit_done=true where id=(data->>'id')::bigint and delivery_token=data->>'token' and lease_until>now() and sent_at is null and superseded_by is null;
  return jsonb_build_object('ok',found);
 end if;

 -- Suppress only undelivered, single-question responses demonstrably superseded
 -- by the exact same actor/conversation/draft set. Keep every accounting receipt.
 update private.outbox b set superseded_by=(select n.id from private.outbox n join private.events ne on ne.id=n.event_id
   where private.finance_same_response_subjects(b.id,n.id) and (ne.turn_until is null or ne.turn_until<=now())
    and n.response_subjects is not null and n.superseded_by is null
   order by ne.created_at desc,ne.id desc limit 1)
 where b.sent_at is null and b.delivery_part=0 and b.superseded_by is null
  and (b.lease_until is null or b.lease_until<now()) and private.finance_question_response(b.id)
  and exists(select 1 from private.outbox n join private.events ne on ne.id=n.event_id
   where private.finance_same_response_subjects(b.id,n.id) and (ne.turn_until is null or ne.turn_until<=now()) and n.response_subjects is not null and n.superseded_by is null);

 update private.outbox set lease_until=now()+interval '3 minutes',delivery_token=gen_random_uuid()::text,delivery_attempts=delivery_attempts+1
 where id=(select b.id from private.outbox b left join private.events e on e.id=b.event_id
  where b.sent_at is null and b.superseded_by is null and b.retry_at<=now()
   and (b.lease_until is null or b.lease_until<now())
   and not exists(select 1 from private.events active where active.id=b.event_id and active.turn_until>now())
   and not private.finance_defer_question(b.id)
   and not exists(select 1 from private.outbox busy join private.events be on be.id=busy.event_id
    where be.actor=e.actor and busy.id<>b.id and busy.sent_at is null and busy.lease_until>now())
  order by b.id for update of b skip locked limit 1) returning * into o;
 if not found then return '{}';end if;
 select * into ev from private.events where id=o.event_id;
 if o.edit_target is null and o.response_subjects is not null and o.delivery_part=0 then
  select b.* into previous from private.outbox b join private.events e on e.id=b.event_id
   where b.sent_at is not null and b.telegram_message_id is not null and b.delivery_part=1
    and private.finance_question_response(b.id)
    and private.finance_same_response_subjects(b.id,o.id)
    and not exists(select 1 from private.outbox later where later.sent_at is not null and private.finance_same_response_subjects(b.id,later.id))
   order by e.created_at desc,e.id desc limit 1;
  if found and (private.finance_question_response(o.id) or
   (o.result->>'status'='ok' and not exists(select 1 from private.agent_drafts d where o.response_subjects ? d.id::text and d.state='pending'))) then
   update private.outbox set edit_target=previous.telegram_message_id,
    edit_mode=case when private.finance_question_response(o.id) then 'replace' else 'resolve' end where id=o.id returning * into o;
   update private.outbox set superseded_by=o.id where id=previous.id;
  end if;
 end if;
 return jsonb_build_object('id',o.id,'token',o.delivery_token,'part',o.delivery_part,'telegram_message_id',o.telegram_message_id,
  'event_id',o.event_id,'message',o.message,'result',o.result,'messageId',ev.message_id,'threadId',ev.thread_id,
  'reactionMessageId',ev.reaction_message_id,'editTarget',o.edit_target,'editMode',o.edit_mode,'editDone',o.edit_done,
  'supersededReactionIds',(with recursive previous_responses as (
    select b.id,b.event_id from private.outbox b where b.superseded_by=o.id
    union select b.id,b.event_id from private.outbox b join previous_responses p on b.superseded_by=p.id
   )select coalesce(jsonb_agg(distinct e.reaction_message_id),'[]') from previous_responses p join private.events e on e.id=p.event_id where e.reaction_message_id is not null));
end $$;
revoke all on function public.finance_queue(text,jsonb) from public,anon,authenticated;
grant execute on function public.finance_queue(text,jsonb) to service_role;

-- Persist subjects in the SAME transaction as financial results and outbox.
-- Derive identity from owned drafts, their event provenance and validated
-- actions/children; no presentation-only network call can lose this metadata.
alter function public.finance_agent(text,jsonb) rename to finance_agent_v7;
create function public.finance_agent(op text,data jsonb default '{}') returns jsonb
language plpgsql security invoker set search_path='' as $$
declare r jsonb;ev private.events%rowtype;ids jsonb;explicit_ids jsonb;
begin
 if op='apply' then
  select * into ev from private.events where id=(data->>'id')::bigint;
  explicit_ids:=coalesce(data->'action'->'_response_draft_ids','[]');
  if jsonb_typeof(explicit_ids) is distinct from 'array' or jsonb_array_length(explicit_ids)>20
   or exists(select 1 from jsonb_array_elements(explicit_ids)i where jsonb_typeof(i)<>'string' or not exists(select 1 from private.agent_drafts d where d.id::text=i#>>'{}' and d.actor=ev.actor)) then raise exception 'invalid or foreign response subject';end if;
 end if;
 r:=public.finance_agent_v7(op,data);
 if op='apply' then
  select * into ev from private.events where id=(data->>'id')::bigint;
  select coalesce(jsonb_agg(d.id::text order by d.id::text),'[]') into ids from private.agent_drafts d
   where d.actor=ev.actor and (explicit_ids ? d.id::text or d.origin_event=ev.id
    or exists(select 1 from jsonb_each(d.sources)s where s.value#>>'{}'=ev.id::text)
    or d.id::text=ev.action->>'_draft_id'
    or exists(select 1 from jsonb_array_elements(coalesce(ev.action->'items','[]'))i where i->>'_draft_id'=d.id::text)
    or exists(select 1 from jsonb_array_elements(coalesce(r->'linked_pending','[]'))i where i#>>'{}'=d.id::text)
    or exists(select 1 from private.transactions t join private.events child on child.id=t.event_id
      where t.id=d.transaction_id and child.parent_event_id=ev.id));
  update private.outbox set response_subjects=ids,response_session=(select session_id from private.conversation_turns where event_id=ev.id)
   where event_id=ev.id and response_subjects is null and sent_at is null;
 end if;
 return r;
end $$;
revoke all on function public.finance_agent(text,jsonb) from public,anon,authenticated;
grant execute on function public.finance_agent(text,jsonb) to service_role;
