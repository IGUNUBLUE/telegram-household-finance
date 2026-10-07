create table private.agent_drafts(
 id bigint generated always as identity primary key,
 actor text not null references private.members(id),
 origin_event bigint not null unique references private.events(id),
 state text not null default 'pending' check(state in ('pending','completed','cancelled')),
 revision integer not null default 1,
 fields jsonb not null default '{}', sources jsonb not null default '{}',
 transaction_id bigint references private.transactions(id),
 created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create index agent_drafts_actor_state on private.agent_drafts(actor,state,updated_at desc);
create table private.agent_draft_receipts(event_id bigint not null references private.events(id),fingerprint text not null,result jsonb not null,primary key(event_id,fingerprint));
create table private.agent_traces(event_id bigint primary key references private.events(id),model text not null,metrics jsonb not null,created_at timestamptz not null default now());
DO $$ declare t text;begin foreach t in array array['agent_drafts','agent_draft_receipts','agent_traces'] loop execute format('alter table private.%I enable row level security',t);execute format('grant all on private.%I to service_role',t);end loop;end $$;
grant usage,select on sequence private.agent_drafts_id_seq to service_role;
create function public.finance_agent(op text,data jsonb default '{}') returns jsonb language plpgsql security invoker set search_path='' as $$
declare ev private.events%rowtype;d private.agent_drafts%rowtype;r jsonb;patch jsonb;before_v jsonb;fingerprint_v text;key_v text;act jsonb;a jsonb;cmd text;actor_v text;t private.transactions%rowtype;row_v record;aid bigint;batch bigint;cash bigint;reserved_v bigint;committed bigint;due_day date;
begin
 if op='apply' then perform 1 from private.household where id=1 for update;end if;
 select * into ev from private.events where id=(data->>'id')::bigint for update;
 if not found then raise exception 'unknown event';end if;
 if op='query' then
  a:=data->'action';cmd:=a->>'command';actor_v:=ev.actor;
 if cmd='pending' then
  r:=jsonb_build_object('status','pending_list','items',(select coalesce(jsonb_agg(jsonb_build_object('id',cc.id,'text',(select ct.text from private.conversation_turns ct where ct.session_id=cc.id order by created_at limit 1))),'[]') from private.conversations cc where actor=actor_v and state='open' and expires_at>now()));
 elsif cmd='preferences' then
  r:=jsonb_build_object('status','preferences','data',public.finance_pro('context',data));
 elsif cmd='detail' then
  select * into t from private.transactions where id=(a->>'target')::bigint;
  if not found then raise exception 'unknown transaction';end if;
  r:=jsonb_build_object('status','detail','transaction',to_jsonb(t),'entries',(select jsonb_agg(jsonb_build_object('account',ac.name,'delta',e.delta::text)) from private.entries e join private.accounts ac on ac.id=e.account_id where e.transaction_id=t.id),'corrections',(select coalesce(jsonb_agg(jsonb_build_object('id',id,'reason',memo)),'[]') from private.transactions where reverses=t.id));
 elsif cmd='planning' then
  due_day:=(a->>'to')::date;if due_day is null then raise exception 'date required';end if;
  select coalesce(sum(e.delta),0) into cash from private.entries e join private.accounts ac on ac.id=e.account_id where ac.kind='asset';
  select coalesce(sum(reserved),0) into reserved_v from private.goals;
  select coalesce(sum(amount),0) into committed from private.commitments where state='open' and due<=due_day;
  r:=jsonb_build_object('status','planning','planning',jsonb_build_object('cash',cash::text,'reserved',reserved_v::text,'committed',committed::text,'available',(cash-reserved_v-committed)::text,'to',due_day,'commitments',(select coalesce(jsonb_agg(jsonb_build_object('id',id,'label',label,'amount',amount::text,'due',due,'project',project)),'[]') from private.commitments where state='open'),'goals',(select coalesce(jsonb_agg(jsonb_build_object('id',id,'label',label,'target',target::text,'reserved',reserved::text,'project',project)),'[]') from private.goals),'unknown_accounts',(select coalesce(jsonb_agg(name),'[]') from private.accounts where not internal and not balance_known),'debt',(select coalesce(-sum(e.delta),0)::text from private.entries e join private.accounts ac on ac.id=e.account_id where ac.kind='liability')));
 elsif cmd='projects' then
  r:=jsonb_build_object('status','projects','items',(select coalesce(jsonb_agg(x),'[]') from (select coalesce(tp.project,'sin asignar') project,coalesce(sum(e.delta) filter(where ac.kind='expense'),0)::text expense,coalesce(-sum(e.delta) filter(where ac.kind='income'),0)::text income from private.transactions tt join private.entries e on e.transaction_id=tt.id join private.accounts ac on ac.id=e.account_id left join private.transaction_projects tp on tp.transaction_id=coalesce(tt.reverses,tt.id) where tt.date between (a->>'from')::date and (a->>'to')::date group by 1) x));
 elsif cmd='reconcile' then
  select * into row_v from private.statement_batches where id=(a->>'target')::bigint;
  if not found then raise exception 'unknown statement';end if;aid:=row_v.account_id;batch:=row_v.id;
  r:=jsonb_build_object('status','reconcile','batch_id',batch,'rows',(select coalesce(jsonb_agg(jsonb_build_object('id',sl.id,'date',sl.date,'delta',sl.delta::text,'memo',sl.memo,'matched',sl.matched_transaction,'candidates',(select coalesce(jsonb_agg(x),'[]') from (select tt.id,tt.memo from private.transactions tt join private.entries ee on ee.transaction_id=tt.id where ee.account_id=aid and ee.delta=sl.delta and tt.date=sl.date and tt.reverses is null and tt.kind<>'opening' and not exists(select 1 from private.transactions rr where rr.reverses=tt.id) and not exists(select 1 from private.statement_lines ll where ll.matched_transaction=tt.id and ll.account_id=aid) limit 6) x)) order by sl.line_no),'[]') from private.statement_lines sl where sl.batch_id=batch));
  r:=r||jsonb_build_object('ledger_unmatched',(select coalesce(jsonb_agg(x),'[]') from (select tt.id,tt.date,ee.delta::text,tt.memo from private.transactions tt join private.entries ee on ee.transaction_id=tt.id where ee.account_id=aid and tt.kind<>'opening' and tt.reverses is null and tt.date between (select min(date) from private.statement_lines where batch_id=batch) and (select max(date) from private.statement_lines where batch_id=batch) and not exists(select 1 from private.transactions rr where rr.reverses=tt.id) and not exists(select 1 from private.statement_lines ll where ll.matched_transaction=tt.id and ll.account_id=aid)) x));
  if cmd='reconciliation_export' then r:=r||jsonb_build_object('status','reconciliation_export');end if;

 else raise exception 'unsupported read tool';end if;return r;
 elsif op='search' then
  return jsonb_build_object('movements',(select coalesce(jsonb_agg(x),'[]') from (
   select t.id::text,t.date,t.kind,t.memo,t.category,t.scope,t.payer,coalesce(e.action->>'amount','0') amount_cents,e.action->>'account' account
   from private.transactions t join private.events e on e.id=t.event_id
   where t.kind<>'opening' and t.reverses is null and not exists(select 1 from private.transactions rr where rr.reverses=t.id)
   and (data->>'query' is null or t.memo ilike '%'||(data->>'query')||'%' or e.action->>'account' ilike '%'||(data->>'query')||'%')
   and (data->>'from' is null or t.date>=(data->>'from')::date) and (data->>'to' is null or t.date<=(data->>'to')::date)
   order by t.id desc limit 30)x));
 elsif op='context' then
  return jsonb_build_object('drafts',(select coalesce(jsonb_agg(to_jsonb(x) order by x.updated_at desc),'[]') from (select id::text,revision,fields,sources,state,origin_event,updated_at from private.agent_drafts where actor=ev.actor and state='pending' order by updated_at desc limit 20)x));
 elsif op='draft_get' then
  select * into d from private.agent_drafts where id=(data->>'draft_id')::bigint and actor=ev.actor;
  if not found then raise exception 'draft unavailable';end if;
  return jsonb_build_object('draft',to_jsonb(d)||jsonb_build_object('id',d.id::text));
 elsif op in ('draft_save','draft_cancel') then
  if ev.result is not null then raise exception 'event already settled';end if;
  fingerprint_v:=md5(op||data::text);
  select result into r from private.agent_draft_receipts where event_id=ev.id and fingerprint=fingerprint_v;
  if found then return r;end if;
  patch:=coalesce(data->'fields','{}');
  if jsonb_typeof(patch)<>'object' or length(patch::text)>4000 then raise exception 'invalid draft fields';end if;
  for key_v in select jsonb_object_keys(patch) loop
   if key_v<>all(array['kind','amount_cop','account','other','payer','beneficiary','date','category','scope','memo']) then raise exception 'unsupported draft field';end if;
   if patch->key_v<>'null'::jsonb and (jsonb_typeof(patch->key_v)<>'string' or length(patch->>key_v)>240) then raise exception 'invalid draft value';end if;
  end loop;
  if nullif(data->>'draft_id','') is null and op='draft_save' then
   if exists(select 1 from private.agent_drafts where origin_event=ev.id) then raise exception 'draft already created by this event; retrieve it and use its revision';end if;
   if (select count(*) from private.agent_drafts where actor=ev.actor and state='pending')>=20 then raise exception 'too many pending drafts';end if;
   insert into private.agent_drafts(actor,origin_event,fields,sources) values(ev.actor,ev.id,jsonb_strip_nulls(patch),(select coalesce(jsonb_object_agg(k,ev.id),'{}') from jsonb_object_keys(patch)k)) returning * into d;
  else
   select * into d from private.agent_drafts where id=(data->>'draft_id')::bigint and actor=ev.actor for update;
   if not found or d.state<>'pending' then raise exception 'draft unavailable';end if;
   if d.revision is distinct from (data->>'revision')::integer then raise exception 'draft changed; retrieve latest revision';end if;
   before_v:=to_jsonb(d);
   update private.agent_drafts set fields=jsonb_strip_nulls(fields||patch),sources=sources||(select coalesce(jsonb_object_agg(k,ev.id),'{}') from jsonb_object_keys(patch)k),revision=revision+1,updated_at=now(),state=case when op='draft_cancel' then 'cancelled' else 'pending' end where id=d.id returning * into d;
  end if;
  r:=jsonb_build_object('status','draft_saved','ledger_changed',false,'draft',to_jsonb(d)||jsonb_build_object('id',d.id::text));
  insert into private.agent_draft_receipts values(ev.id,fingerprint_v,r);
  insert into private.pro_audit(actor,event_id,operation,before_value,after_value) values(ev.actor,ev.id,op,before_v,to_jsonb(d));
  return r;
 elsif op='apply' then
  if ev.result is not null then return ev.result;end if;
  act:=data->'action';
  if act->>'_draft_id' is not null then
   select * into d from private.agent_drafts where id=(act->>'_draft_id')::bigint and actor=ev.actor for update;
   if not found or d.state<>'pending' or d.revision is distinct from (act->>'_draft_revision')::integer or act->>'type'<>'post' then raise exception 'draft changed or unavailable';end if;
   for key_v in select unnest(array['kind','account','other','payer','date','scope']) loop
    if act->>key_v is distinct from d.fields->>key_v then raise exception 'action differs from stored draft';end if;
   end loop;
   if act->>'amount' is distinct from (((d.fields->>'amount_cop')::bigint)*100)::text or coalesce(act->>'memo','') is distinct from coalesce(d.fields->>'memo','') then raise exception 'action differs from stored draft';end if;
   if act->>'kind' in ('income','expense','refund') and act->>'category' is distinct from d.fields->>'category' then raise exception 'action differs from stored draft';end if;
   if act->>'scope'='personal' and act->>'beneficiary' is distinct from d.fields->>'beneficiary' then raise exception 'action differs from stored draft';end if;
  end if;
  r:=public.finance_api('apply',data);
  if act->>'type'='post' and r->>'status'='ok' then
   r:=r||jsonb_build_object('receipt',jsonb_build_object('kind',act->>'kind','amount',act->>'amount','account',act->>'account','other',act->>'other','memo',act->>'memo','scope',act->>'scope'));
   update private.events set result=r where id=ev.id;update private.outbox set result=r where event_id=ev.id;
  end if;
  if d.id is not null and r->>'status'='ok' and r->>'transaction_id' is not null then
   update private.agent_drafts set state='completed',transaction_id=(r->>'transaction_id')::bigint,revision=revision+1,updated_at=now() where id=d.id;
   insert into private.pro_audit(actor,event_id,operation,before_value,after_value) values(ev.actor,ev.id,'draft_completed',to_jsonb(d),jsonb_build_object('transaction_id',r->'transaction_id'));
  end if;
  return r;
 elsif op='narrate' then
  if ev.result is null then raise exception 'cannot narrate uncommitted result';end if;
  if length(coalesce(data->>'text','')) not between 1 and 1200 then raise exception 'invalid narration';end if;
  if ev.result->>'narration' is not null then return ev.result;end if;
  r:=ev.result||jsonb_build_object('narration',data->>'text');
  update private.outbox set result=r where event_id=ev.id and sent_at is null;
  if found then update private.events set result=r where id=ev.id;else r:=ev.result;end if;
  return r;
 elsif op='trace' then
  insert into private.agent_traces(event_id,model,metrics) values(ev.id,'gpt-6-luna',jsonb_build_object('rounds',data->'rounds','elapsed_ms',data->'elapsed_ms','input_tokens',data->'input_tokens','output_tokens',data->'output_tokens','tools',data->'tools')) on conflict(event_id) do nothing;
  return '{}';
 end if;
 raise exception 'unknown agent operation';
end $$;
revoke all on function public.finance_agent(text,jsonb) from public,anon,authenticated;
grant execute on function public.finance_agent(text,jsonb) to service_role;
