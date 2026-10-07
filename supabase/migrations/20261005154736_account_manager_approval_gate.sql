alter table private.accounts add column management_mode text not null default 'exclusive' check(management_mode in ('exclusive','shared'));
alter table private.accounts add constraint shared_account_has_no_exclusive_owner check(management_mode<>'shared' or owner is null);

-- Pure inspection: no probing financial writes and no sequence consumption.
create function private.finance_approval_inspect(event_v bigint,action_v jsonb,virtual_v jsonb default '{}') returns jsonb
language plpgsql stable security invoker set search_path='' as $$
declare e private.events%rowtype;d private.agent_drafts%rowtype;p private.proposals%rowtype;t private.transactions%rowtype;
 a jsonb:=action_v;owners jsonb:='{}';members jsonb;items jsonb:='[]';i jsonb;r jsonb;patch jsonb;
 source_kind text:='event';source_id text:=event_v::text;rev integer:=1;cmd text;name_v text;key_v text;ac private.accounts%rowtype;
 amount_v bigint;day_v date;signature_v text;financial boolean:=false;old_action jsonb;new_virtual jsonb:=virtual_v;
begin
 select * into strict e from private.events where id=event_v;
 if jsonb_typeof(a) is distinct from 'object' then raise exception 'action required';end if;
 if a->>'type'='pro' then
  cmd:=a->>'command';
  if cmd='confirm' then
   select * into p from private.proposals where id=(a->>'target')::bigint and actor=e.actor;
   if not found or p.state<>'pending' or p.expires_at<=now() then raise exception 'proposal expired or unavailable';end if;
   source_kind:='proposal';source_id:=p.id::text;a:=p.action||jsonb_build_object('type','pro');cmd:=a->>'command';
  end if;
  if cmd in ('correct','undo') then
   r:=private.finance_mutation_permission((a->>'target')::bigint,e.actor);
   if r is not null then return jsonb_build_object('valid',false,'issues',jsonb_build_array(r),'operation',action_v);end if;
   select * into strict t from private.transactions where id=(a->>'target')::bigint;
   if t.reverses is not null or exists(select 1 from private.transactions where reverses=t.id) then raise exception 'movement already changed';end if;
   select action into strict old_action from private.events where id=t.event_id;
   items:=jsonb_build_array(jsonb_build_object('type','reverse','target',t.id::text,'reason','Corrección'));
   if cmd='correct' then
    r:=private.finance_correction_patch(old_action,a);if r->>'status'<>'valid' then return jsonb_build_object('valid',false,'issues',jsonb_build_array(r),'operation',action_v);end if;
    items:=items||jsonb_build_array((old_action-'{confirm_duplicate,pending_event_id,_draft_id,_draft_revision,_response_draft_ids}'::text[])||(r->'patch'));
   end if;
   financial:=true;
  elsif cmd='account' then
   items:=jsonb_build_array((a-'command')||jsonb_build_object('type','account','owner',coalesce(a->>'owner',e.actor)));
   new_virtual:=virtual_v||jsonb_build_object(a->>'name',jsonb_build_object('owner',coalesce(a->>'owner',e.actor),'kind',a->>'kind'));
   for i in select value from jsonb_array_elements(coalesce(a->'linked_drafts','[]')) loop
    select * into d from private.agent_drafts where id=(i->>'draft_id')::bigint and actor=e.actor;
    if not found or d.state<>'pending' or d.revision is distinct from (i->>'revision')::integer or d.fields is distinct from i->'fields' then raise exception 'linked draft changed';end if;
    if a->>'name' is distinct from d.fields->>'account' and a->>'name' is distinct from d.fields->>'other' then raise exception 'unrelated linked movement';end if;
    -- Incomplete linked drafts remain pending after account creation, as before.
    if coalesce(d.fields->>'kind','')<>'' and coalesce(d.fields->>'amount_cop','')<>'' and coalesce(d.fields->>'account','')<>'' and coalesce(d.fields->>'payer','')<>'' and coalesce(d.fields->>'date','')<>'' and coalesce(d.fields->>'scope','')<>''
     and (d.fields->>'kind' not in ('transfer','borrow','lend','repayment','collection') or coalesce(d.fields->>'other','')<>'') then
     items:=items||jsonb_build_array((d.fields-'amount_cop')||jsonb_build_object('type','post','amount',private.cop_cents(d.fields->>'amount_cop')::text,'_draft_id',d.id::text,'_draft_revision',d.revision));
    end if;
   end loop;
   financial:=true;
  end if;
 elsif a->>'type'='batch_post' then
  items:=a->'items';if jsonb_typeof(items) is distinct from 'array' or jsonb_array_length(items) not between 2 and 8 then raise exception 'invalid movement group';end if;
  if (select count(distinct x->>'_draft_id') from jsonb_array_elements(items)x)<>jsonb_array_length(items) then raise exception 'repeated draft';end if;
  financial:=true;
 elsif a->>'type'='post' then
  financial:=true;
  if a->>'_draft_id' is not null then
   select * into d from private.agent_drafts where id=(a->>'_draft_id')::bigint and actor=e.actor;
   if not found or d.state<>'pending' or d.revision is distinct from (a->>'_draft_revision')::integer then raise exception 'draft changed or unavailable';end if;
   for key_v in select unnest(array['kind','account','other','payer','date','scope','beneficiary','counterparty']) loop
    if a->>key_v is distinct from d.fields->>key_v then raise exception 'action differs from stored draft';end if;
   end loop;
   if a->>'amount' is distinct from private.cop_cents(d.fields->>'amount_cop')::text or coalesce(a->>'memo','') is distinct from coalesce(d.fields->>'memo','') then raise exception 'action differs from stored draft';end if;
   if a->>'kind' in ('income','expense','refund') and a->>'category' is distinct from d.fields->>'category' then raise exception 'action differs from stored draft';end if;
   r:=private.finance_draft_issues(d.id);if jsonb_array_length(r)>0 then return jsonb_build_object('valid',false,'issues',r,'operation',action_v);end if;
   source_kind:='draft';source_id:=d.id::text;rev:=d.revision;
  end if;
  if coalesce(a->>'amount','')!~'^[0-9]+$' then raise exception 'invalid amount';end if;
  amount_v:=(a->>'amount')::bigint;day_v:=(a->>'date')::date;
  if amount_v<=0 or amount_v>100000000000000 or day_v is null or day_v<date '2000-01-01' or day_v>current_date+1 then raise exception 'invalid amount or date';end if;
  if coalesce(a->>'kind','') not in ('income','expense','refund','transfer','borrow','lend','repayment','collection') or coalesce(a->>'scope','') not in ('family','personal') then raise exception 'invalid operation or scope';end if;
  if not exists(select 1 from private.members where id=a->>'payer') or (a->>'scope'='personal' and not exists(select 1 from private.members where id=coalesce(a->>'beneficiary',a->>'payer'))) then raise exception 'unknown household person';end if;
  if a->>'kind' in ('income','expense','refund') and coalesce(a->>'category','')='' then raise exception 'category required';end if;
  for name_v in select a->>'account' union select a->>'other' where a->>'kind' in ('transfer','borrow','lend','repayment','collection') loop
   select * into ac from private.accounts where name=name_v and not internal;
   if not found then
    if new_virtual ? coalesce(name_v,'') then ac.owner:=new_virtual->name_v->>'owner';ac.kind:=new_virtual->name_v->>'kind';ac.name:=name_v;ac.management_mode:='exclusive';
    else raise exception 'unknown account';end if;
   end if;
   if ac.owner is null and ac.management_mode<>'shared' then raise exception 'Asigna un responsable a la cuenta antes de registrarla';end if;
   if ac.parent_account_id is not null and ac.owner is distinct from (select owner from private.accounts where id=ac.parent_account_id) then raise exception 'inconsistent pocket owner';end if;
   owners:=owners||jsonb_build_object(name_v,ac.owner);
   if name_v=a->>'account' then
    if (a->>'kind' in ('income','refund','borrow','collection','lend','repayment') and ac.kind<>'asset') or (a->>'kind' in ('expense','transfer') and ac.kind not in ('asset','liability')) then raise exception 'invalid source kind';end if;
   else
    if name_v=a->>'account' or (a->>'kind'='transfer' and ac.kind not in ('asset','liability')) or (a->>'kind' in ('borrow','repayment') and ac.kind<>'liability') or (a->>'kind' in ('lend','collection') and ac.kind<>'receivable') then raise exception 'invalid destination kind';end if;
   end if;
  end loop;
  if a->>'kind' in ('transfer','borrow','lend','repayment','collection') and (a->>'other' is null or a->>'other'=a->>'account') then raise exception 'other account required';end if;
  signature_v:=md5(concat_ws('|',a->>'kind',day_v::text,amount_v::text,a->>'account',coalesce(a->>'other',''),nullif(left(a->>'category',80),''),a->>'scope',a->>'payer',coalesce(a->>'beneficiary',a->>'payer')));
  if coalesce((a->>'confirm_duplicate')::boolean,false) then
   if not exists(select 1 from private.events pe where pe.id=(a->>'pending_event_id')::bigint and pe.actor=e.actor and pe.state='pending' and pe.created_at>now()-interval '48 hours' and pe.action=a-'{confirm_duplicate,pending_event_id}'::text[]) then raise exception 'duplicate confirmation unavailable';end if;
  elsif exists(select 1 from private.transactions tt where tt.duplicate_key=signature_v and tt.reverses is null and not exists(select 1 from private.transactions rr where rr.reverses=tt.id)) then
   return jsonb_build_object('valid',false,'issues',jsonb_build_array(jsonb_build_object('code','duplicate','message','Uno de estos movimientos podría estar registrado. Revisemos cuál es adicional antes de registrar.')),'operation',action_v);
  end if;
 elsif a->>'type'='account' then
  financial:=true;
  if not exists(select 1 from private.members where id=a->>'owner') or coalesce(a->>'kind','') not in ('asset','liability','receivable') or length(coalesce(a->>'name','')) not between 1 and 64 or exists(select 1 from private.accounts where name=a->>'name') then raise exception 'invalid new account';end if;
  if coalesce(a->>'amount','')!~'^[0-9]+$' or (a->>'amount')::numeric>100000000000000 or a->>'date' is null then raise exception 'invalid opening amount or date';end if;
  day_v:=(a->>'date')::date;owners:=jsonb_build_object(a->>'name',a->>'owner');
 elsif a->>'type'='reverse' then
  financial:=true;
  r:=private.finance_mutation_permission((a->>'target')::bigint,e.actor);if r is not null then return jsonb_build_object('valid',false,'issues',jsonb_build_array(r),'operation',action_v);end if;
  if exists(select 1 from private.transactions where reverses=(a->>'target')::bigint) or nullif(a->>'reason','') is null then raise exception 'invalid reversal';end if;
  select coalesce(jsonb_object_agg(account_row.name,account_row.owner),'{}') into owners from private.entries en join private.accounts account_row on account_row.id=en.account_id where en.transaction_id=(a->>'target')::bigint and not account_row.internal;
 end if;
 for i in select value from jsonb_array_elements(items) loop
  r:=private.finance_approval_inspect(event_v,i,new_virtual);
  if r->>'valid' is distinct from 'true' then return r;end if;
  owners:=owners||(r->'account_owners');
 end loop;
 select coalesce(jsonb_agg(x.owner order by x.owner),'[]') into members from (select distinct value#>>'{}' owner from jsonb_each(owners) where value<>'null'::jsonb and value#>>'{}'<>e.actor) x;
 return jsonb_build_object('valid',true,'financial',financial,'issues','[]'::jsonb,'operation',action_v-'{_response_draft_ids,_approval_id,confirm_owner}'::text[],'account_owners',owners,'required_members',members,'fingerprint',md5((action_v-'{_response_draft_ids,_approval_id,confirm_owner}'::text[])::text),'source_kind',source_kind,'source_id',source_id,'source_revision',rev);
end $$;

create function private.finance_approval_authorized(actor_v text,account_v text,owner_v text) returns boolean language sql stable security invoker set search_path='' as $$
 select exists(select 1 from private.approval_executions x join private.approval_requests r on r.id=x.request_id
 where x.event_id::text=current_setting('finance.approval_execution',true) and r.reporter=actor_v and x.fingerprint=r.fingerprint
 and r.state='pending' and r.expires_at>now() and r.account_owners->>account_v=owner_v
 and not exists(select 1 from jsonb_array_elements_text(r.required_members)m where not exists(select 1 from private.approval_decisions d where d.request_id=r.id and d.member_id=m and d.decision='confirm')))
$$;
create function private.finance_approval_entry_guard() returns trigger language plpgsql security invoker set search_path='' as $$
declare ac private.accounts%rowtype;actor_v text;
begin
 if not (select manager_confirmations_enabled from private.household where id=1) then return new;end if;
 select * into strict ac from private.accounts where id=new.account_id;
 if ac.internal then return new;end if;
 select actor into strict actor_v from private.transactions where id=new.transaction_id;
 if ac.owner is null and ac.management_mode<>'shared' then raise exception 'account manager required' using errcode='42501';end if;
 if ac.owner is not null and ac.owner<>actor_v and not private.finance_approval_authorized(actor_v,ac.name,ac.owner) then raise exception 'account manager approval required' using errcode='42501';end if;
 return new;
end $$;
create trigger approval_guard_before_entry before insert on private.entries for each row execute function private.finance_approval_entry_guard();

create function private.finance_approval_settle(event_v bigint,action_v jsonb,result_v jsonb) returns jsonb language plpgsql security invoker set search_path='' as $$
begin
 update private.events set action=action_v,result=result_v,state='done' where id=event_v;
 insert into private.outbox(event_id,message,result,response_subjects,response_session)
 values(event_v,result_v->>'message',result_v,
 case when action_v->>'_draft_id' is not null then jsonb_build_array(action_v->>'_draft_id') else null end,
 (select session_id from private.conversation_turns where event_id=event_v))
 on conflict(event_id) do update set result=excluded.result,message=excluded.message;
 return result_v;
end $$;
create function private.finance_approval_gate(event_v bigint,action_v jsonb) returns jsonb language plpgsql security invoker set search_path='' as $$
declare inspection jsonb;r jsonb;actor_v text;row_v record;
begin
 if not (select manager_confirmations_enabled from private.household where id=1) then return null;end if;
 perform 1 from private.household where id=1 for update;
 select actor,result into actor_v,r from private.events where id=event_v for update;
 if r is not null then return r;end if;
 inspection:=private.finance_approval_inspect(event_v,action_v);
 if inspection->>'valid' is distinct from 'true' then return private.finance_approval_settle(event_v,action_v,jsonb_build_object('status','clarify','message',inspection->'issues'->0->>'message'));end if;
 if jsonb_array_length(inspection->'required_members')=0 then return null;end if;
 if not exists(select 1 from jsonb_each(inspection->'account_owners') x where x.value<>'null'::jsonb and x.value#>>'{}'<>actor_v and not private.finance_approval_authorized(actor_v,x.key,x.value#>>'{}')) then return null;end if;
 r:=private.finance_approval_request(event_v,inspection);
 return private.finance_approval_settle(event_v,action_v,jsonb_build_object('status','approval_pending','request_id',r->>'id','approval_requests',jsonb_build_array(r),'ledger_changed',false,'message','Pendiente de confirmar por el responsable de la cuenta. Todavía no registré este movimiento.'));
end $$;

alter function public.finance_api(text,jsonb) rename to finance_api_approval_previous;
create function public.finance_api(op text,data jsonb default '{}') returns jsonb language plpgsql security invoker set search_path='' as $$
declare r jsonb;
begin
 if op='apply' then r:=private.finance_approval_gate((data->>'id')::bigint,data->'action');if r is not null then return r;end if;end if;
 return public.finance_api_approval_previous(op,data);
end $$;
alter function public.finance_pro(text,jsonb) rename to finance_pro_approval_previous;
create function public.finance_pro(op text,data jsonb default '{}') returns jsonb language plpgsql security invoker set search_path='' as $$
declare r jsonb;
begin
 if op='act' then r:=private.finance_approval_gate((data->>'id')::bigint,data->'action'||jsonb_build_object('type','pro'));if r is not null then return r;end if;end if;
 return public.finance_pro_approval_previous(op,data);
end $$;
alter function public.finance_agent(text,jsonb) rename to finance_agent_approval_previous;
create function public.finance_agent(op text,data jsonb default '{}') returns jsonb language plpgsql security invoker set search_path='' as $$
declare r jsonb;ev private.events%rowtype;a jsonb;inspection jsonb;item jsonb;ri jsonb;receipts jsonb:='[]';pending jsonb:='[]';child bigint;
begin
 if op<>'apply' or not (select manager_confirmations_enabled from private.household where id=1) then return public.finance_agent_approval_previous(op,data);end if;
 perform 1 from private.household where id=1 for update;
 select * into strict ev from private.events where id=(data->>'id')::bigint for update;
 if ev.result is not null then return ev.result;end if;
 a:=data->'action';inspection:=private.finance_approval_inspect(ev.id,a);
 if inspection->>'valid' is distinct from 'true' then return private.finance_approval_settle(ev.id,a,jsonb_build_object('status','clarify','message',inspection->'issues'->0->>'message'));end if;
 if a->>'type'='batch_post' and jsonb_array_length(inspection->'required_members')>0 then
  for item in select value from jsonb_array_elements(a->'items') loop
   child:=nextval('private.child_event_seq');insert into private.events(id,actor,parent_event_id,action) values(child,ev.actor,ev.id,item);
   ri:=public.finance_agent('apply',jsonb_build_object('id',child,'action',item));
   if ri->>'status'='ok' then receipts:=receipts||jsonb_build_array(ri);
   elsif ri->>'status'='approval_pending' then pending:=pending||(ri->'approval_requests');
   else raise exception 'movement group changed during application';end if;
   delete from private.outbox where event_id=child;
  end loop;
  return private.finance_approval_settle(ev.id,a,jsonb_build_object('status',case when jsonb_array_length(receipts)>0 then 'ok' else 'approval_pending' end,'receipts',receipts,'approval_requests',pending,'message','Registré los movimientos autorizados; los demás esperan confirmación de su responsable.'));
 end if;
 r:=private.finance_approval_gate(ev.id,a);if r is not null then return r;end if;
 return public.finance_agent_approval_previous(op,data);
end $$;
revoke all on function private.finance_approval_inspect(bigint,jsonb,jsonb),private.finance_approval_authorized(text,text,text),private.finance_approval_entry_guard(),private.finance_approval_settle(bigint,jsonb,jsonb),private.finance_approval_gate(bigint,jsonb),public.finance_api(text,jsonb),public.finance_pro(text,jsonb),public.finance_agent(text,jsonb) from public,anon,authenticated;
grant execute on function private.finance_approval_inspect(bigint,jsonb,jsonb),private.finance_approval_authorized(text,text,text),private.finance_approval_entry_guard(),private.finance_approval_settle(bigint,jsonb,jsonb),private.finance_approval_gate(bigint,jsonb),public.finance_api(text,jsonb),public.finance_pro(text,jsonb),public.finance_agent(text,jsonb) to service_role;
