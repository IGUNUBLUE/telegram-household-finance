-- Pure helpers reuse the established review calculation. Reading family progress
-- must not invoke review, which creates a row and locks the household.
do $$
declare src text;accounts_block text;snapshot_block text;original_snapshot_block text;first_i int;last_i int;body_v text;
begin
 src:=pg_get_functiondef('public.finance_routines(text,jsonb)'::regprocedure);
 first_i:=strpos(src,'  -- Balances are as of month end');
 last_i:=strpos(src,'  if op=''check'' then');
 if first_i=0 or last_i<=first_i then raise exception 'Missing review accounts block';end if;
 accounts_block:=substring(src from first_i for last_i-first_i);
 body_v:='declare mv private.monthly_reviews%rowtype;end_d date;accounts_v jsonb;begin
 select * into mv from private.monthly_reviews where actor=actor_v and month=m;
 end_d:=(m+interval ''1 month - 1 day'')::date;
 '||replace(accounts_block,'ev.actor','actor_v')||'return accounts_v;end';
 execute format('create function private.finance_month_accounts(actor_v text,m date) returns jsonb language plpgsql stable security invoker set search_path='''' as %L',body_v);
 first_i:=strpos(src,'  report_v:=public.finance_api(''report''');
 last_i:=first_i+strpos(substring(src from first_i),'  if op=''act'' then')-1;
 if first_i=0 or last_i<=first_i then raise exception 'Missing review snapshot block';end if;
 snapshot_block:=substring(src from first_i for last_i-first_i);
 original_snapshot_block:=snapshot_block;
 -- General report pocket groups are CURRENT balances, not month-end balances.
 -- Month accounts already carry exact cutoff balances. Ignore that current-only
 -- field in both new and legacy snapshots without rewriting saved review history.
 snapshot_block:=replace(snapshot_block,')-''balances''-''budgets'';',')-''balances''-''budgets''-''pocket_groups'';');
 snapshot_block:=replace(snapshot_block,'mv.snapshot->>''fingerprint''<>fingerprint',
  'md5(jsonb_build_object(''report'',(mv.snapshot->''report'')-''pocket_groups'',''accounts'',mv.snapshot->''accounts'',''budgets'',mv.snapshot->''budgets'',''pending'',mv.snapshot->''pending'')::text)<>fingerprint');
 body_v:='declare mv private.monthly_reviews%rowtype;end_d date;accounts_v jsonb;report_v jsonb;budgets_v jsonb;pending_v jsonb;issues int;fingerprint text;r jsonb;begin
 select * into mv from private.monthly_reviews where actor=actor_v and month=m;
 end_d:=(m+interval ''1 month - 1 day'')::date;
 accounts_v:=private.finance_month_accounts(actor_v,m);
 '||replace(snapshot_block,'ev.actor','actor_v')||'return r;end';
 execute format('create function private.finance_month_snapshot(actor_v text,m date) returns jsonb language plpgsql stable security invoker set search_path='''' as %L',body_v);
 src:=replace(src,accounts_block,E'  accounts_v:=private.finance_month_accounts(ev.actor,m);\n');
 src:=replace(src,original_snapshot_block,E'  r:=private.finance_month_snapshot(ev.actor,m);issues:=(r->>''issues'')::int;fingerprint:=r->>''fingerprint'';\n');
 src:=replace(src,'? Podemos comprobar saldos, pendientes y presupuestos. Dime «revisemos el mes pasado» cuando tengas un momento.',
  '? Si te sirve, podemos revisar tus cuentas, pendientes y presupuestos. También puedes consultar los saldos del hogar cuando quieras.');
 execute src;
end $$;
revoke all on function private.finance_month_accounts(text,date),private.finance_month_snapshot(text,date) from public,anon,authenticated;
grant execute on function private.finance_month_accounts(text,date),private.finance_month_snapshot(text,date) to service_role;

create function public.finance_family(op text,data jsonb default '{}') returns jsonb
language plpgsql stable security invoker set search_path='' as $$
declare ev private.events%rowtype;cutoff date;m date;accounts_v jsonb;groups_v jsonb;
 cash_v numeric;debt_v numeric;receivable_v numeric;members_v jsonb:='[]';member_v record;
 snapshot_v jsonb;state_v text;family_state text;total_v int;checked_v int;
begin
 if op not in ('overview','review_status') then raise exception 'read-only family operation required';end if;
 select * into ev from private.events where id=(data->>'id')::bigint;
 if not found or not exists(select 1 from private.members where id=ev.actor) then raise exception 'unknown household event';end if;
 if op='overview' then
  cutoff:=(data->>'as_of')::date;
  if cutoff is null or cutoff>(now() at time zone 'America/Bogota')::date then raise exception 'valid balance date required';end if;
  select coalesce(jsonb_agg(jsonb_build_object('name',x.name,'kind',x.kind,'owner',x.owner,'owner_name',(select name from private.members where id=x.owner),
   'parent_account',x.parent_name,'pocket_name',x.pocket_name,'balance',x.balance::text,'balance_known',x.balance_known) order by x.name),'[]') into accounts_v
  from (select ac.name,ac.kind,ac.owner,ac.pocket_name,(select name from private.accounts where id=ac.parent_account_id) parent_name,
   (case when ac.kind='liability' then -1 else 1 end)*coalesce(sum(e.delta) filter(where t.date<=cutoff),0) balance,
   exists(select 1 from private.transactions ot join private.events oe on oe.id=ot.event_id
    where ot.kind='opening' and oe.action->>'name'=ac.name and coalesce((oe.action->>'balance_known')::boolean,true) and ot.date<=cutoff
     and not exists(select 1 from private.transactions rev where rev.reverses=ot.id and rev.date<=cutoff)) balance_known
   from private.accounts ac left join private.entries e on e.account_id=ac.id left join private.transactions t on t.id=e.transaction_id
   where not ac.internal and ac.kind in ('asset','liability','receivable')
    and (exists(select 1 from private.transactions ot join private.events oe on oe.id=ot.event_id where ot.kind='opening' and oe.action->>'name'=ac.name and ot.date<=cutoff)
     or exists(select 1 from private.entries ae join private.transactions atx on atx.id=ae.transaction_id where ae.account_id=ac.id and atx.date<=cutoff))
   group by ac.id)x;
  select coalesce(sum((x->>'balance')::numeric) filter(where x->>'kind'='asset'),0),
   coalesce(sum((x->>'balance')::numeric) filter(where x->>'kind'='liability'),0),
   coalesce(sum((x->>'balance')::numeric) filter(where x->>'kind'='receivable'),0)
   into cash_v,debt_v,receivable_v from jsonb_array_elements(accounts_v)x;
  select coalesce(jsonb_agg(jsonb_build_object('account',p->>'name','available',p->>'balance',
   'pockets_total',(select sum((c->>'balance')::numeric)::text from jsonb_array_elements(accounts_v)c where c->>'parent_account'=p->>'name'),
   'total',((p->>'balance')::numeric+(select sum((c->>'balance')::numeric) from jsonb_array_elements(accounts_v)c where c->>'parent_account'=p->>'name'))::text,
   'balance_known',(p->>'balance_known')::boolean and not exists(select 1 from jsonb_array_elements(accounts_v)c where c->>'parent_account'=p->>'name' and not (c->>'balance_known')::boolean),
   'pockets',(select jsonb_agg(jsonb_build_object('name',c->>'pocket_name','account',c->>'name','balance',c->>'balance','balance_known',c->'balance_known') order by c->>'name') from jsonb_array_elements(accounts_v)c where c->>'parent_account'=p->>'name')) order by p->>'name'),'[]') into groups_v
   from jsonb_array_elements(accounts_v)p where p->>'parent_account' is null and exists(select 1 from jsonb_array_elements(accounts_v)c where c->>'parent_account'=p->>'name');
  return jsonb_build_object('source','ledger','as_of',cutoff,'cash_cents',cash_v::text,'debt_cents',debt_v::text,'receivable_cents',receivable_v::text,
   'net_cash_cents',(cash_v-debt_v)::text,'net_position_cents',(cash_v+receivable_v-debt_v)::text,
   'balances_complete',not exists(select 1 from jsonb_array_elements(accounts_v)x where not (x->>'balance_known')::boolean),
   'unverified_accounts',(select coalesce(jsonb_agg(x->>'name'),'[]') from jsonb_array_elements(accounts_v)x where not (x->>'balance_known')::boolean),
   'accounts',accounts_v,'pocket_groups',groups_v);
 end if;
 m:=(data->>'month')::date;
 if m is null or extract(day from m)<>1 or m>=date_trunc('month',now() at time zone 'America/Bogota')::date then raise exception 'choose a completed month';end if;
 for member_v in select me.id,me.name,mr.snapshot,mr.reviewed_at,mr.actor is not null started from private.members me
  left join private.monthly_reviews mr on mr.actor=me.id and mr.month=m order by me.id loop
  snapshot_v:=private.finance_month_snapshot(member_v.id,m);
  select count(*),count(*) filter(where (x->>'checked')::boolean) into total_v,checked_v from jsonb_array_elements(snapshot_v->'accounts')x;
  state_v:=case when not member_v.started then 'not_started' when member_v.snapshot is null then 'in_progress'
   when (snapshot_v->>'changed_since_review')::boolean then 'needs_update' else member_v.snapshot->>'state' end;
  members_v:=members_v||jsonb_build_array(jsonb_build_object('actor',member_v.id,'name',member_v.name,'state',state_v,
   'reviewed_at',member_v.reviewed_at,'changed_since_review',coalesce((snapshot_v->>'changed_since_review')::boolean,false),
   'accounts_total',total_v,'accounts_checked',checked_v,'has_pending_issues',(snapshot_v->>'issues')::int>0));
 end loop;
 family_state:=case
  when exists(select 1 from jsonb_array_elements(members_v)x where x->>'state'='needs_update') then 'needs_update'
  when not exists(select 1 from jsonb_array_elements(members_v)x where x->>'state' not in ('reviewed','reviewed_with_pending')) then
   case when exists(select 1 from jsonb_array_elements(members_v)x where x->>'state'='reviewed_with_pending') then 'reviewed_with_pending' else 'reviewed' end
  when exists(select 1 from jsonb_array_elements(members_v)x where x->>'state' in ('reviewed','reviewed_with_pending')) then 'partial'
  when exists(select 1 from jsonb_array_elements(members_v)x where x->>'state'='in_progress') then 'in_progress' else 'not_started' end;
 return jsonb_build_object('month',m,'state',family_state,'members',members_v,'source','individual_reviews','optional',true);
end $$;
revoke all on function public.finance_family(text,jsonb) from public,anon,authenticated;
grant execute on function public.finance_family(text,jsonb) to service_role;
