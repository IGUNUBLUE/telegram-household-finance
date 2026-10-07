alter table private.approval_requests add column blocked_members jsonb not null default '[]';
create unique index approval_card_update_once on private.outbox(approval_notice_id) where purpose='approval_card_update';
create function private.finance_approval_reserve(request_v bigint,member_v text,round_v integer) returns void language plpgsql security invoker set search_path='' as $$
declare n bigint;b bigint;
begin
 insert into private.approval_notices(request_id,member_id,round) values(request_v,member_v,round_v) on conflict do nothing returning id into n;
 if n is null then return;end if;
 insert into private.outbox(message,result,purpose,approval_notice_id) values('Confirmación pendiente',jsonb_build_object('status','approval_notice','request_id',request_v::text),'approval_notice',n) returning id into b;
 update private.approval_notices set outbox_id=b where id=n;
end $$;
create function private.finance_approval_cards(request_v bigint) returns void language sql security invoker set search_path='' as $$
 insert into private.outbox(message,result,purpose,approval_notice_id,chat_id,target_thread_id,target_message_id)
 select 'Solicitud finalizada',jsonb_build_object('status','approval_card_update','request_id',r.id::text,'state',r.state),'approval_card_update',n.id,n.chat_id,n.thread_id,n.telegram_message_id
 from private.approval_requests r join private.approval_notices n on n.request_id=r.id
 where r.id=request_v and r.state<>'pending' and n.telegram_message_id is not null
 on conflict(approval_notice_id) where purpose='approval_card_update' do nothing
$$;
create function private.finance_approval_schedule() returns trigger language plpgsql security invoker set search_path='' as $$
declare m text;
begin
 if tg_op='INSERT' then
  if new.state='pending' and (select manager_confirmations_enabled from private.household where id=1) then
   for m in select jsonb_array_elements_text(new.required_members) loop perform private.finance_approval_reserve(new.id,m,1);end loop;
  end if;
 elsif new.state<>'pending' then
  update private.approval_notices set state='cancelled' where request_id=new.id and state='queued';
  perform private.finance_approval_cards(new.id);
 end if;
 return new;
end $$;
create trigger approval_schedule after insert or update of state on private.approval_requests for each row execute function private.finance_approval_schedule();

alter function public.finance_approval(text,jsonb) rename to finance_approval_resolution_previous;
create function public.finance_approval(op text,data jsonb default '{}') returns jsonb language plpgsql security invoker set search_path='' as $$
declare n private.approval_notices%rowtype;b private.outbox%rowtype;q private.approval_requests%rowtype;r jsonb;m text;last_n private.approval_notices%rowtype;group_v text;private_v text;thread_v bigint;
begin
 if op not in ('due','notice_context','begin_notice','notice_result','notice_fallback','notice_unavailable') then return public.finance_approval_resolution_previous(op,data);end if;
 perform 1 from private.household where id=1 for update;
 select group_id into group_v from private.household where id=1;
 if not(select manager_confirmations_enabled from private.household where id=1) then return jsonb_build_object('send',false);end if;
 if op='due' then
  for q in select * from private.approval_requests where state='pending' order by id limit 100 loop
   r:=private.finance_approval_refresh(q.id);if r->>'state'<>'pending' then continue;end if;
   for m in select jsonb_array_elements_text(q.required_members) loop
    if q.blocked_members ? m or exists(select 1 from private.approval_decisions where request_id=q.id and member_id=m) then continue;end if;
    select * into last_n from private.approval_notices where request_id=q.id and member_id=m order by round desc limit 1;
    if not found then perform private.finance_approval_reserve(q.id,m,1);
    elsif last_n.round<3 and last_n.begin_at is not null and last_n.begin_at<=now()-interval '1 hour' then perform private.finance_approval_reserve(q.id,m,last_n.round+1);end if;
   end loop;
  end loop;
  return jsonb_build_object('ok',true);
 end if;
 if op in ('notice_result','notice_fallback') then
  select * into n from private.approval_notices where id=(data->>'notice_id')::bigint for update;
  if not found or n.token is distinct from data->>'token' then return jsonb_build_object('ok',false,'send',false);end if;
 else
  select * into b from private.outbox where id=(data->>'outbox_id')::bigint for update;
  if not found or b.delivery_token is distinct from data->>'token' or b.sent_at is not null or b.lease_until<=now() then return jsonb_build_object('ok',false,'send',false);end if;
  select * into strict n from private.approval_notices where id=b.approval_notice_id for update;
 end if;
 select * into strict q from private.approval_requests where id=n.request_id for update;
 if op='notice_result' then
  if n.state='reserved' and data->>'outcome' in ('sent','uncertain','undeliverable') then
   update private.approval_notices set state=data->>'outcome',telegram_message_id=(data->>'telegram_message_id')::bigint where id=n.id;
   perform private.finance_approval_cards(q.id);
  end if;
  return jsonb_build_object('ok',true);
 end if;
 if op='notice_unavailable' then
  update private.approval_requests set blocked_members=blocked_members||jsonb_build_array(n.member_id) where id=q.id and not(blocked_members ? n.member_id);
  update private.approval_notices set state='cancelled' where request_id=q.id and member_id=n.member_id and state='queued';return jsonb_build_object('ok',true);
 end if;
 r:=private.finance_approval_refresh(q.id);
 if r->>'state'<>'pending' or q.blocked_members ? n.member_id or exists(select 1 from private.approval_decisions where request_id=q.id and member_id=n.member_id) then
  update private.approval_notices set state='cancelled' where id=n.id and state='queued';return jsonb_build_object('send',false);
 end if;
 if op='notice_context' then return jsonb_build_object('send',n.state='queued','member_id',n.member_id,'group_id',group_v);end if;
 if op='notice_fallback' then
  if n.state<>'reserved' or n.chat_id=group_v or n.fallback then return jsonb_build_object('send',false);end if;
  update private.approval_private_chats set enabled=false,updated_at=now() where member_id=n.member_id;
  thread_v:=(select thread_id from private.events where id=q.origin_event);
  update private.approval_notices set chat_id=group_v,thread_id=thread_v,fallback=true where id=n.id returning * into n;
 else
  if n.state<>'queued' then
   update private.approval_notices set state='uncertain' where id=n.id and state='reserved';return jsonb_build_object('send',false);
  end if;
  if n.round>1 then select chat_id into private_v from private.approval_private_chats where member_id=n.member_id and enabled;end if;
  thread_v:=case when private_v is null then (select thread_id from private.events where id=q.origin_event) end;
  update private.approval_notices set state='reserved',begin_at=now(),token=data->>'token',chat_id=coalesce(private_v,group_v),thread_id=thread_v where id=n.id returning * into n;
 end if;
 return jsonb_build_object('send',true,'notice_id',n.id::text,'round',n.round,'member_id',n.member_id,'member_name',(select name from private.members where id=n.member_id),'request',r,'route',jsonb_build_object('chat_id',n.chat_id,'thread_id',n.thread_id));
end $$;

alter function public.finance_queue(text,jsonb) rename to finance_queue_approval_previous;
create function public.finance_queue(op text,data jsonb default '{}') returns jsonb language plpgsql security invoker set search_path='' as $$
declare r jsonb;b private.outbox%rowtype;
begin
 r:=public.finance_queue_approval_previous(op,data);
 if op='outbox' and r ? 'id' then
  select * into strict b from private.outbox where id=(r->>'id')::bigint;
  if b.purpose is not null then r:=r||jsonb_build_object('chatId',coalesce(b.chat_id,(select group_id from private.household where id=1)),'threadId',b.target_thread_id,'messageId',b.target_message_id,'purpose',b.purpose,'approvalNoticeId',b.approval_notice_id::text,'reactionMessageId',null,'editTarget',null);end if;
 end if;
 return r;
end $$;
revoke all on function private.finance_approval_reserve(bigint,text,integer),private.finance_approval_cards(bigint),private.finance_approval_schedule(),public.finance_approval(text,jsonb),public.finance_queue(text,jsonb) from public,anon,authenticated;
grant execute on function private.finance_approval_reserve(bigint,text,integer),private.finance_approval_cards(bigint),private.finance_approval_schedule(),public.finance_approval(text,jsonb),public.finance_queue(text,jsonb) to service_role;

-- Preserve financial details shown to the owner even for proposal confirmation.
alter table private.approval_requests add column effective_action jsonb;
do $$declare src text;needle text:=$n$'operation',action_v-'{_response_draft_ids,_approval_id,confirm_owner}'::text[]$n$;begin
 src:=pg_get_functiondef('private.finance_approval_inspect(bigint,jsonb,jsonb)'::regprocedure);
 if position(needle in src)=0 then raise exception 'missing inspection details target';end if;
 execute replace(src,needle,needle||$n$,'effective_operation',a$n$);
end $$;
create function private.finance_approval_details() returns trigger language plpgsql security invoker set search_path='' as $$
begin new.effective_action:=private.finance_approval_inspect(new.origin_event,new.action)->'effective_operation';return new;end $$;
create trigger approval_details before insert on private.approval_requests for each row execute function private.finance_approval_details();

-- Validate response subjects before the gate, including deferred financial work.
do $$declare src text;needle text:=$n$a:=data->'action';inspection:=$n$;begin
 src:=pg_get_functiondef('public.finance_agent(text,jsonb)'::regprocedure);
 if position(needle in src)=0 then raise exception 'missing agent response validation target';end if;
 execute replace(src,needle,$n$a:=data->'action';
 if a ? '_response_draft_ids' and (jsonb_typeof(a->'_response_draft_ids')<>'array' or jsonb_array_length(a->'_response_draft_ids')>20) then raise exception 'invalid response subjects';end if;
 if exists(select 1 from jsonb_array_elements(coalesce(a->'_response_draft_ids','[]')) x where jsonb_typeof(x)<>'string' or not exists(select 1 from private.agent_drafts d where d.id::text=x#>>'{}' and d.actor=ev.actor)) then raise exception 'foreign response subjects';end if;
 inspection:=$n$);
end $$;
alter function public.finance_worker_context(text,jsonb) rename to finance_worker_context_approval_previous;
create function public.finance_worker_context(op text,data jsonb default '{}') returns jsonb language plpgsql security invoker set search_path='' as $$
declare r jsonb;begin
 r:=public.finance_worker_context_approval_previous(op,data);
 if data ? 'id' and (select manager_confirmations_enabled from private.household where id=1) then r:=r||jsonb_build_object('approvals',public.finance_approval('context',data));end if;
 return r;
end $$;
alter function public.finance_approval(text,jsonb) rename to finance_approval_notifications_previous;
create function public.finance_approval(op text,data jsonb default '{}') returns jsonb language plpgsql security invoker set search_path='' as $$
declare e private.events%rowtype;r jsonb;group_v text;chat_v text;
begin
 if op not in ('list','help','target','transcription') then return public.finance_approval_notifications_previous(op,data);end if;
 perform 1 from private.household where id=1 for update;
 select * into strict e from private.events where id=(data->>'id')::bigint for update;
 select group_id into group_v from private.household where id=1;chat_v:=coalesce(e.payload->>'chatId',group_v);
 if chat_v<>group_v and (e.payload->>'chatType' is distinct from 'private' or chat_v<>e.actor) then raise exception 'invalid approval route';end if;
 if op='transcription' then
  if e.turn_token is distinct from data->>'token' or e.turn_until<=now() or e.state<>'working' then raise exception 'invalid transcription lease';end if;
  update private.events set payload=jsonb_set(payload,'{text}',to_jsonb(left(data->>'text',4000))) where id=e.id;return jsonb_build_object('ok',true);
 end if;
 if op='target' then return coalesce((select private.finance_approval_json(id) from private.approval_requests where id=(data->>'request_id')::bigint and required_members ? e.actor),jsonb_build_object('found',false));end if;
 if e.result is not null then return e.result;end if;
 if op='list' then r:=jsonb_build_object('status','approval_list','received',public.finance_approval('context',data)->'received');
 else r:=jsonb_build_object('status','clarify','message','Aquí puedes confirmar o rechazar solicitudes con sus botones o respondiendo a su aviso. Escribe pendientes para consultarlas. Para registrar o consultar dinero, usa el grupo.');end if;
 update private.events set state='done',result=r where id=e.id;
 insert into private.outbox(event_id,message,result,chat_id,target_thread_id,target_message_id,purpose) values(e.id,coalesce(r->>'message','Solicitudes pendientes'),r,chat_v,e.thread_id,e.message_id,'approval_ack');return r;
end $$;
revoke all on function private.finance_approval_details(),public.finance_worker_context(text,jsonb),public.finance_approval(text,jsonb) from public,anon,authenticated;
grant execute on function private.finance_approval_details(),public.finance_worker_context(text,jsonb),public.finance_approval(text,jsonb) to service_role;
-- A separated movement retains its parent's forum route.
do $$declare src text;needle text:=$n$insert into private.events(id,actor,parent_event_id,action) values(child,ev.actor,ev.id,item);$n$;begin
 src:=pg_get_functiondef('public.finance_agent(text,jsonb)'::regprocedure);
 if position(needle in src)=0 then raise exception 'missing split event route target';end if;
 execute replace(src,needle,$n$insert into private.events(id,actor,parent_event_id,action,message_id,thread_id) values(child,ev.actor,ev.id,item,ev.message_id,ev.thread_id);$n$);
end $$;
create or replace function private.finance_approval_settle(event_v bigint,action_v jsonb,result_v jsonb) returns jsonb language plpgsql security invoker set search_path='' as $$
declare subjects jsonb;actor_v text;
begin
 select actor into strict actor_v from private.events where id=event_v;
 select coalesce(jsonb_agg(d.id::text order by d.id::text),'[]') into subjects from private.agent_drafts d
 where d.actor=actor_v and (coalesce(action_v->'_response_draft_ids','[]') ? d.id::text or d.origin_event=event_v
 or exists(select 1 from jsonb_each(d.sources)s where s.value#>>'{}'=event_v::text)
 or d.id::text=action_v->>'_draft_id'
 or exists(select 1 from jsonb_array_elements(coalesce(action_v->'items','[]'))i where i->>'_draft_id'=d.id::text));
 update private.events set action=action_v,result=result_v,state='done' where id=event_v;
 insert into private.outbox(event_id,message,result,response_subjects,response_session) values(event_v,result_v->>'message',result_v,subjects,(select session_id from private.conversation_turns where event_id=event_v))
 on conflict(event_id) do update set result=excluded.result,message=excluded.message,response_subjects=excluded.response_subjects,response_session=excluded.response_session;
 return result_v;
end $$;
