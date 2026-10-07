create table private.recurring_rules(
 id bigint generated always as identity primary key, actor text not null references private.members(id),
 label text not null check(length(label) between 1 and 120), amount_cop bigint not null check(amount_cop>0 and amount_cop<=1000000000000),
 account text not null references private.accounts(name),category text not null,scope text not null check(scope in ('family','personal')),
 day int not null check(day between 1 and 31),next_due date not null,enabled boolean not null default true,origin_event bigint unique references private.events(id)
);
create table private.recurring_occurrences(
 id bigint generated always as identity primary key,rule_id bigint not null references private.recurring_rules(id),due date not null,template jsonb not null,
 state text not null default 'pending' check(state in ('pending','paid','skipped')),draft_id bigint unique references private.agent_drafts(id),
 transaction_id bigint unique references private.transactions(id),unique(rule_id,due)
);
create table private.monthly_reviews(actor text not null references private.members(id),month date not null,checks jsonb not null default '{}',snapshot jsonb,reviewed_at timestamptz,primary key(actor,month));
create table private.monthly_notices(month date primary key);
DO $$declare t text;begin foreach t in array array['recurring_rules','recurring_occurrences','monthly_reviews','monthly_notices'] loop execute format('alter table private.%I enable row level security',t);execute format('grant all on private.%I to service_role',t);end loop;end $$;
grant usage,select on sequence private.recurring_rules_id_seq,private.recurring_occurrences_id_seq to service_role;
create function public.finance_routines(op text,data jsonb default '{}') returns jsonb language plpgsql security invoker set search_path='' as $$
declare ev private.events%rowtype;a jsonb;cmd text;r jsonb;rr private.recurring_rules%rowtype;oc private.recurring_occurrences%rowtype;mv private.monthly_reviews%rowtype;v record;d date;m date;end_d date;n bigint;fields jsonb;accounts_v jsonb;report_v jsonb;budgets_v jsonb;pending_v jsonb;fingerprint text;balance_v bigint;observed bigint;issues int;
begin
 perform 1 from private.household where id=1 for update;
 if op='due' then
  d:=(data->>'today')::date;
  update private.recurring_occurrences o set state='pending',transaction_id=null,draft_id=null where o.state='paid' and exists(select 1 from private.transactions t where t.reverses=o.transaction_id);
  for rr in select * from private.recurring_rules where enabled and next_due<=d order by id limit 50 for update loop
   insert into private.recurring_occurrences(rule_id,due,template) values(rr.id,rr.next_due,to_jsonb(rr)) on conflict do nothing returning id into n;
   if found then
    insert into private.outbox(message,result) values('Recurrente',jsonb_build_object('status','reminder','occurrence_id',n::text,'message',(select name from private.members where id=rr.actor)||', ¿ya pagaste '||rr.label||' de '||to_char(rr.next_due,'YYYY-MM')||'? Importe previsto: $'||rr.amount_cop||' COP, desde '||rr.account||'. Dime si ya lo pagaste, si cambió el monto o si este mes no aplica. Aún no registré un gasto.'));
   end if;
   m:=(date_trunc('month',rr.next_due)+interval '1 month')::date;
   update private.recurring_rules set next_due=m+(least(rr.day,extract(day from (m+interval '1 month - 1 day')))::int-1) where id=rr.id;
  end loop;
  -- One invitation per month, only on its first day; no historical notification flood.
  if extract(day from d)=1 and extract(hour from now() at time zone 'America/Bogota')>=8 then
   m:=(date_trunc('month',d)-interval '1 month')::date;
   insert into private.monthly_notices values(m) on conflict do nothing;
   if found then insert into private.outbox(message,result) values('Cierre mensual',jsonb_build_object('status','reminder','month',m,'message','¿Revisamos cómo terminó '||to_char(m,'YYYY-MM')||'? Podemos comprobar saldos, pendientes y presupuestos. Dime «revisemos el mes pasado» cuando tengas un momento.'));end if;
  end if;
  return jsonb_build_object('ok',true);
 end if;
 select * into ev from private.events where id=(data->>'id')::bigint for update;
 if not found then raise exception 'unknown event';end if;
 if op='context' then
  return jsonb_build_object('recurring_rules',(select coalesce(jsonb_agg(to_jsonb(x)),'[]') from (select id::text,label,amount_cop::text,account,category,scope,day,next_due,enabled from private.recurring_rules where actor=ev.actor order by id)x),
   'recurring_pending',(select coalesce(jsonb_agg(to_jsonb(x)),'[]') from (select o.id::text,o.template->>'label' label,o.due,o.draft_id::text,o.template->>'amount_cop' amount_cop,o.template->>'account' account from private.recurring_occurrences o join private.recurring_rules r on r.id=o.rule_id where r.actor=ev.actor and o.state='pending' order by o.due limit 24)x),
   'recurring_reply',(select jsonb_build_object('id',o.id::text,'due',o.due,'label',o.template->>'label','state',o.state) from private.outbox b join private.recurring_occurrences o on o.id::text=b.result->>'occurrence_id' join private.recurring_rules qr on qr.id=o.rule_id where b.telegram_message_id=(ev.payload->>'replyTo')::bigint and qr.actor=ev.actor order by b.id desc limit 1),
   'monthly_review',(select jsonb_build_object('month',month,'reviewed_at',reviewed_at) from private.monthly_reviews where actor=ev.actor order by month desc limit 1));
 end if;
 if op='prepare' then
  if ev.result is not null then raise exception 'event already settled';end if;
  select o.* into oc from private.recurring_occurrences o join private.recurring_rules r on r.id=o.rule_id where o.id=(data->>'occurrence')::bigint and r.actor=ev.actor for update of o;
  if not found or oc.state<>'pending' then raise exception 'recurrence unavailable';end if;
  select * into rr from jsonb_populate_record(null::private.recurring_rules,oc.template);
  if oc.draft_id is not null then
   r:=public.finance_agent('draft_get',jsonb_build_object('id',ev.id,'draft_id',oc.draft_id::text));
   if r->'draft'->>'state'='pending' then return r;end if;
   if r->'draft'->>'state'='completed' then raise exception 'already registered';end if;
  end if;
  d:=(data->>'date')::date;if d is null or d>(now() at time zone 'America/Bogota')::date then raise exception 'actual payment date required';end if;
  fields:=jsonb_build_object('kind','expense','amount_cop',rr.amount_cop::text,'account',rr.account,'category',rr.category,'scope',rr.scope,'payer',ev.actor,'memo',rr.label,'date',d::text);
  if rr.scope='personal' then fields:=fields||jsonb_build_object('beneficiary',ev.actor);end if;
  r:=public.finance_agent('draft_save',jsonb_build_object('id',ev.id,'fields',fields));
  update private.recurring_occurrences set draft_id=(r->'draft'->>'id')::bigint where id=oc.id;
  return r;
 end if;
 if op in ('review','check') or (op='act' and data->'action'->>'command'='close_finish') then
  a:=case when op='act' then data->'action' else data end;m:=(a->>'month')::date;
  if m is null or extract(day from m)<>1 or m>=date_trunc('month',now() at time zone 'America/Bogota')::date then raise exception 'choose a completed month';end if;
  end_d:=(m+interval '1 month - 1 day')::date;
  insert into private.monthly_reviews(actor,month) values(ev.actor,m) on conflict do nothing;
  select * into mv from private.monthly_reviews where actor=ev.actor and month=m for update;
  -- Balances are as of month end, unlike the current-balance general report.
  select coalesce(jsonb_agg(jsonb_build_object('name',x.name,'kind',x.kind,'balance_known',x.balance_known,'balance',x.balance::text,'version',x.version,'checked',coalesce(mv.checks->x.name->>'version'=x.version and mv.checks->x.name->>'balance'=x.balance::text and x.balance_known,false),'observed',mv.checks->x.name->>'balance','difference',case when x.balance_known and mv.checks->x.name->>'balance' is not null then ((mv.checks->x.name->>'balance')::bigint-x.balance)::text else null end) order by x.name),'[]') into accounts_v
  from (select ac.name,ac.kind,(ac.balance_known and exists(select 1 from private.transactions ot join private.events oe on oe.id=ot.event_id where ot.kind='opening' and oe.action->>'name'=ac.name and ot.date<=end_d and not exists(select 1 from private.transactions rev where rev.reverses=ot.id))) balance_known,(case when ac.kind='liability' then -1 else 1 end)*coalesce(sum(e.delta) filter(where t.date<=end_d),0) balance,
   md5(coalesce(string_agg(t.id::text||':'||e.delta::text,',' order by t.id,e.id) filter(where t.date<=end_d),'')||ac.balance_known::text) version
   from private.accounts ac left join private.entries e on e.account_id=ac.id left join private.transactions t on t.id=e.transaction_id where not ac.internal group by ac.id)x;
  if op='check' then
   select value into r from jsonb_array_elements(accounts_v) where value->>'name'=data->>'account';if r is null then raise exception 'unknown account';end if;
   if coalesce(data->>'balance_cop','')!~'^-?[0-9]{1,13}$' then raise exception 'invalid observed balance';end if;
   observed:=(data->>'balance_cop')::bigint*100;
   update private.monthly_reviews set checks=checks||jsonb_build_object(data->>'account',jsonb_build_object('balance',observed::text,'version',r->>'version','event_id',ev.id)) where actor=ev.actor and month=m;
   return public.finance_routines('review',jsonb_build_object('id',ev.id,'month',m));
  end if;
  report_v:=public.finance_api('report',jsonb_build_object('from',m,'to',end_d,'scope','all','actor',ev.actor))-'balances'-'budgets';
  select coalesce(jsonb_agg(jsonb_build_object('category',b.category,'scope',b.scope,'owner',b.owner,'limit',b.limit_cents::text,'spent',coalesce(s.spent,0)::text,'remaining',(b.limit_cents-coalesce(s.spent,0))::text)),'[]') into budgets_v
  from private.budgets b left join lateral(select sum(e.delta) spent from private.transactions t join private.entries e on e.transaction_id=t.id join private.accounts ac on ac.id=e.account_id where ac.kind='expense' and t.date between m and end_d and t.scope=b.scope and t.category=b.category and (b.scope='family' or t.beneficiary=b.owner))s on true where b.month=m;
  pending_v:=jsonb_build_object('drafts',(select count(*) from private.agent_drafts ad where ad.actor=ev.actor and ad.state='pending' and (ad.fields->>'date' is null or ad.fields->>'date'<=end_d::text)),
   'recurrences',(select count(*) from private.recurring_occurrences o join private.recurring_rules r on r.id=o.rule_id where r.actor=ev.actor and o.state='pending' and o.due<=end_d),
   'proposals',(select count(*) from private.proposals where actor=ev.actor and state='pending' and expires_at>now()),
   'statement_lines',(select count(*) from private.statement_lines l join private.statement_batches b on b.id=l.batch_id where b.actor=ev.actor and l.date between m and end_d and l.matched_transaction is null));
  select count(*) into issues from jsonb_array_elements(accounts_v) x where not (x->>'checked')::boolean;
  issues:=issues+(pending_v->>'drafts')::int+(pending_v->>'recurrences')::int+(pending_v->>'proposals')::int+(pending_v->>'statement_lines')::int;
  fingerprint:=md5(jsonb_build_object('report',report_v,'accounts',accounts_v,'budgets',budgets_v,'pending',pending_v)::text);
  r:=jsonb_build_object('month',m,'through',end_d,'report',report_v,'accounts',accounts_v,'budgets',budgets_v,'pending',pending_v,'issues',issues,'fingerprint',fingerprint,'state',coalesce(mv.snapshot->>'state','in_progress'),'changed_since_review',mv.snapshot is not null and mv.snapshot->>'fingerprint'<>fingerprint);
  if op='act' then
   if issues>0 and coalesce((a->>'accept_pending')::boolean,false)=false then raise exception 'pending review issues; resolve or explicitly retain them';end if;
   r:=r||jsonb_build_object('state',case when issues>0 then 'reviewed_with_pending' else 'reviewed' end,'changed_since_review',false);
   update private.monthly_reviews set snapshot=r,reviewed_at=now() where actor=ev.actor and month=m;
   insert into private.pro_audit(actor,event_id,operation,before_value,after_value) values(ev.actor,ev.id,'monthly_review',mv.snapshot,r);
   return jsonb_build_object('status','ok','message',case when issues>0 then 'Revisión mensual guardada con asuntos pendientes. No se ajustaron saldos.' else 'Revisión mensual guardada con los saldos que confirmaste. Puedes seguir corrigiendo movimientos.' end,'review',r);
  end if;
  return r;
 end if;
 if op<>'act' then raise exception 'unknown routine operation';end if;
 a:=data->'action';cmd:=a->>'command';
 if cmd in ('recurring_create','recurring_update') then
  if cmd='recurring_update' then
   select * into rr from private.recurring_rules where id=(a->>'target')::bigint and actor=ev.actor for update;
   if not found then raise exception 'recurrence unavailable';end if;
  end if;
  if coalesce(a->>'amount_cop','')!~'^[0-9]{1,13}$' or coalesce(a->>'category','')='' then raise exception 'invalid recurring fields';end if;
  if not exists(select 1 from private.accounts where name=a->>'account' and not internal) then raise exception 'unknown account';end if;
  d:=(a->>'start')::date;
  if d is null or extract(day from d)<>least((a->>'day')::int,extract(day from (date_trunc('month',d)+interval '1 month - 1 day'))) then raise exception 'first due date must match monthly day';end if;
  if exists(select 1 from private.recurring_rules where actor=ev.actor and lower(label)=lower(a->>'label') and enabled and (cmd='recurring_create' or id<>rr.id)) then raise exception 'active recurrence with this name already exists';end if;
  if cmd='recurring_update' then
   update private.recurring_rules set label=a->>'label',amount_cop=(a->>'amount_cop')::bigint,account=a->>'account',category=a->>'category',scope=a->>'scope',day=(a->>'day')::int,next_due=d,enabled=true where id=rr.id returning id into n;
  else
  insert into private.recurring_rules(actor,label,amount_cop,account,category,scope,day,next_due,origin_event) values(ev.actor,a->>'label',(a->>'amount_cop')::bigint,a->>'account',a->>'category',a->>'scope',(a->>'day')::int,d,ev.id) returning id into n;
  end if;
  r:=jsonb_build_object('status','ok','rule_id',n::text,'message','Recordaré '||(a->>'label')||' cada mes desde '||d||'. Te preguntaré si se pagó antes de registrar el gasto.');
 elsif cmd='recurring_toggle' then
  update private.recurring_rules set enabled=(a->>'enabled')::boolean where id=(a->>'target')::bigint and actor=ev.actor returning * into rr;
  if not found then raise exception 'recurrence unavailable';end if;
  r:=jsonb_build_object('status','ok','message',case when rr.enabled then 'Recordatorio recurrente activado.' else 'Recordatorio recurrente pausado. Los asuntos ya pendientes se conservan.' end);
 elsif cmd in ('recurring_skip','recurring_link') then
  select o.* into oc from private.recurring_occurrences o join private.recurring_rules r on r.id=o.rule_id where o.id=(a->>'occurrence')::bigint and r.actor=ev.actor for update of o;
  if not found or oc.state<>'pending' then raise exception 'recurrence unavailable';end if;
  if cmd='recurring_link' then
   if not exists(select 1 from private.transactions t where t.id=(a->>'transaction_id')::bigint and t.actor=ev.actor and t.kind='expense' and t.reverses is null and not exists(select 1 from private.transactions x where x.reverses=t.id)) then raise exception 'registered expense unavailable';end if;
   update private.recurring_occurrences set state='paid',transaction_id=(a->>'transaction_id')::bigint where id=oc.id;
  else update private.recurring_occurrences set state='skipped' where id=oc.id;end if;
  if oc.draft_id is not null then update private.agent_drafts set state='cancelled',revision=revision+1 where id=oc.draft_id and state='pending';end if;
  r:=jsonb_build_object('status','ok','message',case when cmd='recurring_link' then 'Vinculé el pago ya registrado, sin crear otro gasto.' else 'Este vencimiento queda omitido; el próximo mes sigue programado.' end);
 else raise exception 'unknown routine command';end if;
 insert into private.pro_audit(actor,event_id,operation,after_value) values(ev.actor,ev.id,cmd,a);
 return r;
end $$;
revoke all on function public.finance_routines(text,jsonb) from public,anon,authenticated;
grant execute on function public.finance_routines(text,jsonb) to service_role;
-- Preserve the tested accounting harness and wrap only routine commands/payment linkage.
alter function public.finance_agent(text,jsonb) rename to finance_agent_v3;
create function public.finance_agent(op text,data jsonb default '{}') returns jsonb language plpgsql security invoker set search_path='' as $$
declare ev private.events%rowtype;r jsonb;oc private.recurring_occurrences%rowtype;
begin
 if op<>'apply' then return public.finance_agent_v3(op,data);end if;
 perform 1 from private.household where id=1 for update;
 select * into ev from private.events where id=(data->>'id')::bigint for update;
 if not found then raise exception 'unknown event';end if;
 if ev.result is not null then return ev.result;end if;
 if data->'action'->>'type'='routine' then
  r:=public.finance_routines('act',data);
  perform public.finance_api('apply',jsonb_build_object('id',ev.id,'action',jsonb_build_object('type','clarify','question',r->>'message')));
  update private.events set result=r,state='done',action=data->'action' where id=ev.id;
  update private.outbox set result=r,message=r->>'message' where event_id=ev.id;
  return r;
 end if;
 if data->'action'->>'_draft_id' is not null then
  select * into oc from private.recurring_occurrences where draft_id=(data->'action'->>'_draft_id')::bigint for update;
  if found and oc.state<>'pending' then raise exception 'recurrence already resolved';end if;
 end if;
 r:=public.finance_agent_v3(op,data);
 if oc.id is not null and r->>'status'='ok' and r->>'transaction_id' is not null then
  update private.recurring_occurrences set state='paid',transaction_id=(r->>'transaction_id')::bigint where id=oc.id;
 end if;
 return r;
end $$;
revoke all on function public.finance_agent(text,jsonb) from public,anon,authenticated;
grant execute on function public.finance_agent(text,jsonb) to service_role;
