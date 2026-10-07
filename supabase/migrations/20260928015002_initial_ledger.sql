create schema if not exists private;
revoke all on schema private from public, anon, authenticated;
grant usage on schema private to service_role;

create table private.household(id int primary key default 1 check(id=1), group_id text not null unique, currency text not null default 'COP' check(currency='COP'), zone text not null default 'America/Bogota');
create table private.members(id text primary key, name text not null, joined_at timestamptz not null default now());
create table private.events(id bigint primary key, actor text not null references private.members(id), payload jsonb not null default '{}'::jsonb, action jsonb, result jsonb, state text not null default 'new' check(state in ('new','working','pending','done','failed')), attempts int not null default 0, lease_until timestamptz, created_at timestamptz not null default now());
create index events_work on private.events(state,lease_until,id) where state in ('new','working','pending');
create table private.accounts(id bigint generated always as identity primary key, name text not null unique, kind text not null check(kind in ('asset','liability','receivable','expense','income','equity')), owner text references private.members(id), internal boolean not null default false, created_at timestamptz not null default now());
create table private.transactions(id bigint generated always as identity primary key, event_id bigint unique references private.events(id), actor text not null references private.members(id), date date not null, kind text not null, category text, scope text not null check(scope in ('family','personal')), payer text not null references private.members(id), beneficiary text references private.members(id), memo text not null default '', reverses bigint unique references private.transactions(id), duplicate_key text, created_at timestamptz not null default now());
create index transactions_date on private.transactions(date, scope);
create index transactions_duplicate on private.transactions(duplicate_key) where duplicate_key is not null;
create table private.entries(id bigint generated always as identity primary key, transaction_id bigint not null references private.transactions(id), account_id bigint not null references private.accounts(id), delta bigint not null check(delta<>0));
create index entries_account on private.entries(account_id);
create table private.budgets(owner text not null, scope text not null check(scope in ('family','personal')), category text not null, month date not null check(extract(day from month)=1), limit_cents bigint not null check(limit_cents>0), primary key(owner,scope,category,month));
create table private.reminders(id bigint generated always as identity primary key, actor text not null references private.members(id), label text not null, due date not null, notified_at timestamptz);
create table private.outbox(id bigint generated always as identity primary key, event_id bigint unique references private.events(id), message text not null, result jsonb not null default '{}'::jsonb, sent_at timestamptz, created_at timestamptz not null default now());
create table private.budget_alerts(owner text not null,scope text not null,category text not null,month date not null,threshold int not null,primary key(owner,scope,category,month,threshold));

alter table private.household enable row level security;
alter table private.members enable row level security;
alter table private.events enable row level security;
alter table private.accounts enable row level security;
alter table private.transactions enable row level security;
alter table private.entries enable row level security;
alter table private.budgets enable row level security;
alter table private.reminders enable row level security;
alter table private.outbox enable row level security;
alter table private.budget_alerts enable row level security;
grant all on all tables in schema private to service_role;
grant all on all sequences in schema private to service_role;

create function private.immutable_ledger() returns trigger language plpgsql set search_path='' as $$ begin raise exception 'ledger immutable'; end $$;
create trigger tx_immutable before update or delete on private.transactions for each row execute function private.immutable_ledger();
create trigger entry_immutable before update or delete on private.entries for each row execute function private.immutable_ledger();

create function private.check_balanced() returns trigger language plpgsql set search_path='' as $$
begin if (select coalesce(sum(delta),0) from private.entries where transaction_id=new.transaction_id)<>0 then raise exception 'unbalanced transaction %',new.transaction_id; end if; return null; end $$;
create constraint trigger balanced after insert on private.entries deferrable initially deferred for each row execute function private.check_balanced();

create function public.finance_api(op text, data jsonb default '{}'::jsonb) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare a jsonb; ev private.events%rowtype; tx private.transactions%rowtype;
  aid bigint; bid bigint; xid bigint; n bigint; principal bigint; interest bigint; amount bigint; delta bigint;
  kind text; owner_id text; scope_id text; cat text; memo_text text; account_kind text; other_kind text;
  acct text; oth text; signature text; date_value date; result_value jsonb; row_value record;
begin
 if op='init' then
   if data->>'group' !~ '^-[0-9]+$' then raise exception 'invalid group'; end if;
   insert into private.household(id,group_id) values(1,data->>'group') on conflict(id) do nothing;
   if (select group_id from private.household where id=1)<>data->>'group' then raise exception 'group already configured'; end if;
   return jsonb_build_object('ok',true);
 end if;
 if op='ingest' then
   if (select group_id from private.household where id=1) is distinct from data->>'group' then raise exception 'wrong group'; end if;
   if data->>'actor' !~ '^[0-9]+$' or length(coalesce(data->>'name',''))=0 then raise exception 'invalid actor'; end if;
   perform 1 from private.household where id=1 for update;
   if not exists(select 1 from private.members where id=data->>'actor') then
     if (select count(*) from private.members)>=2 then raise exception 'only two members'; end if;
     insert into private.members(id,name) values(data->>'actor',left(data->>'name',80));
   end if;
   insert into private.events(id,actor,payload) values((data->>'update_id')::bigint,data->>'actor',coalesce(data->'payload','{}'::jsonb)) on conflict(id) do nothing;
   return (select jsonb_build_object('id',id,'state',state,'result',result) from private.events where id=(data->>'update_id')::bigint);
 end if;
 if op='claim' then
   update private.events set state='working', attempts=attempts+1,lease_until=now()+interval '2 minutes'
   where id=(select id from private.events where state='new' or (state='working' and lease_until<now()) order by id for update skip locked limit 1)
   returning * into ev;
   if not found then return '{}'::jsonb; end if;
   return jsonb_build_object('id',ev.id,'actor',ev.actor,'payload',ev.payload,'action',ev.action,'attempts',ev.attempts);
 end if;
 if op='pending' then
   return coalesce((select jsonb_build_object('status','pending','action',e.action,'actor',e.actor) from private.events e where e.id=(data->>'id')::bigint and e.state='pending'),jsonb_build_object('status','unknown'));
 end if;
 if op='outbox' then
   return (select coalesce(jsonb_agg(jsonb_build_object('id',id,'event_id',event_id,'message',message,'result',result)),'[]'::jsonb) from (select * from private.outbox where sent_at is null order by id limit 10) o);
 end if;
 if op='sent' then
   update private.outbox set sent_at=now() where id=(data->>'id')::bigint and sent_at is null;
   return jsonb_build_object('ok',true);
 end if;
 if op='due' then
   for row_value in select * from private.reminders where due<=(data->>'today')::date and notified_at is null for update skip locked loop
     insert into private.outbox(message,result) values('Recordatorio: '||row_value.label,jsonb_build_object('status','reminder','message','Recordatorio: '||row_value.label));
     update private.reminders set notified_at=now() where id=row_value.id;
   end loop;
   for row_value in
     select b.owner,b.scope,b.category,b.month,b.limit_cents,coalesce(sum(e.delta) filter(where ac.kind='expense'),0) spent
     from private.budgets b left join private.transactions t on t.date>=b.month and t.date<=(data->>'today')::date and t.date<b.month+interval '1 month' and t.scope=b.scope and t.category=b.category
       and (b.scope='family' or t.beneficiary=b.owner)
     left join private.entries e on e.transaction_id=t.id
     left join private.accounts ac on ac.id=e.account_id and ac.kind='expense'
     where b.month=date_trunc('month',(data->>'today')::date)::date
     group by b.owner,b.scope,b.category,b.month,b.limit_cents
   loop
     if row_value.spent>=row_value.limit_cents*0.8 then
       n:=case when row_value.spent>=row_value.limit_cents then 100 else 80 end;
       insert into private.budget_alerts(owner,scope,category,month,threshold) values(row_value.owner,row_value.scope,row_value.category,row_value.month,n) on conflict do nothing;
       if found then insert into private.outbox(message,result) values('Presupuesto '||row_value.category||': '||n||'% usado',jsonb_build_object('status','alert','message','Presupuesto '||row_value.category||': '||n||'% usado'));
       end if;
     end if;
   end loop;
   return (select coalesce(jsonb_agg(jsonb_build_object('id',id,'message',message)),'[]'::jsonb) from private.outbox where sent_at is null and event_id is null);
 end if;
 if op='proposal' then
   update private.events set action=data->'action' where id=(data->>'id')::bigint and state='working' returning * into ev;
   if not found then raise exception 'not claimed'; end if;
   return jsonb_build_object('ok',true);
 end if;
 if op='fail' then
   update private.events set state=case when attempts>=3 then 'failed' else 'new' end,lease_until=null where id=(data->>'id')::bigint and state='working';
   if exists(select 1 from private.events where id=(data->>'id')::bigint and state='failed') then
     insert into private.outbox(event_id,message,result) values((data->>'id')::bigint,'No pude registrar el mensaje #'||(data->>'id')||'. Hay que revisar el dato y enviarlo de nuevo.',jsonb_build_object('status','failed','message','No pude registrar el mensaje #'||(data->>'id')||'. Hay que revisar el dato y enviarlo de nuevo.')) on conflict(event_id) do nothing;
   end if;
   return jsonb_build_object('ok',true);
 end if;
 if op='context' then
   return jsonb_build_object(
    'members',(select coalesce(jsonb_agg(jsonb_build_object('id',m.id,'name',m.name)),'[]'::jsonb) from private.members m),
    'accounts',(select coalesce(jsonb_agg(jsonb_build_object('name',ac.name,'kind',ac.kind,'owner',ac.owner)),'[]'::jsonb) from private.accounts ac where not ac.internal),
    'recent',(select coalesce(jsonb_agg(jsonb_build_object('id',t.id,'date',t.date,'category',t.category,'memo',t.memo,'kind',t.kind)),'[]'::jsonb) from (select * from private.transactions where reverses is null order by id desc limit 12) t));
 end if;
 if op='report' then
   date_value:=coalesce((data->>'from')::date,(now() at time zone 'America/Bogota')::date);
   if (data->>'to')::date<date_value then raise exception 'invalid period'; end if;
   return jsonb_build_object(
    'expense',coalesce((select sum(e.delta) from private.entries e join private.accounts a on a.id=e.account_id join private.transactions t on t.id=e.transaction_id where a.kind='expense' and t.date between date_value and (data->>'to')::date and (data->>'scope'='all' or t.scope=data->>'scope')),0)::text,
    'income',coalesce((select -sum(e.delta) from private.entries e join private.accounts a on a.id=e.account_id join private.transactions t on t.id=e.transaction_id where a.kind='income' and t.date between date_value and (data->>'to')::date and (data->>'scope'='all' or t.scope=data->>'scope')),0)::text,
    'balances',(select coalesce(jsonb_agg(jsonb_build_object('name',a.name,'kind',a.kind,'balance',(case when a.kind='liability' then -coalesce(s.amount,0) else coalesce(s.amount,0) end)::text)),'[]'::jsonb) from private.accounts a left join (select e.account_id,sum(e.delta) amount from private.entries e group by e.account_id) s on s.account_id=a.id where not a.internal),
    'categories',(select coalesce(jsonb_agg(jsonb_build_object('category',c.category,'amount',c.amount::text)),'[]'::jsonb) from (select t.category,sum(e.delta) amount from private.entries e join private.accounts a on a.id=e.account_id join private.transactions t on t.id=e.transaction_id where a.kind='expense' and t.date between date_value and (data->>'to')::date and (data->>'scope'='all' or t.scope=data->>'scope') group by t.category) c),
    'budgets',(select coalesce(jsonb_agg(jsonb_build_object('category',b.category,'scope',b.scope,'owner',b.owner,'limit',b.limit_cents::text)),'[]'::jsonb) from private.budgets b where b.month=date_trunc('month',date_value)::date));
 end if;
 if op='history' then
   return (select coalesce(jsonb_agg(jsonb_build_object('id',t.id,'date',t.date,'kind',t.kind,'category',t.category,'payer',t.payer,'beneficiary',t.beneficiary,'scope',t.scope,'memo',t.memo,'reverses',t.reverses,'amount',coalesce((select abs(e.delta)::text from private.entries e join private.accounts ac on ac.id=e.account_id where e.transaction_id=t.id and not ac.internal order by e.id limit 1),'0'))),'[]'::jsonb) from (select * from private.transactions order by id desc limit 100) t);
 end if;
 if op='export' then
   return (select coalesce(jsonb_agg(jsonb_build_object('transaction_id',t.id,'date',t.date,'kind',t.kind,'category',t.category,'scope',t.scope,'payer',t.payer,'beneficiary',t.beneficiary,'account',ac.name,'delta',e.delta::text,'memo',t.memo,'reverses',t.reverses) order by t.id,e.id),'[]'::jsonb)
     from private.transactions t join private.entries e on e.transaction_id=t.id join private.accounts ac on ac.id=e.account_id);
 end if;
 if op='apply' then
   perform 1 from private.household where id=1 for update;
   select * into ev from private.events where id=(data->>'id')::bigint for update;
   if not found then raise exception 'missing event'; end if;
   if ev.result is not null then return ev.result; end if;
   a:=data->'action'; if a is null or jsonb_typeof(a)<>'object' then raise exception 'action required'; end if;
   kind:=a->>'type';
   if kind='clarify' then
      result_value:=jsonb_build_object('status','clarify','message',left(a->>'question',200));
      update private.events set result=result_value,state='pending' where id=ev.id;
      insert into private.outbox(event_id,message,result) values(ev.id,result_value->>'message',result_value);
      return result_value;
   end if;
   if kind='export' then
     result_value:=jsonb_build_object('status','export','message','Exportación del libro');
   elsif kind='report' then
     result_value:=jsonb_build_object('status','ok','report',public.finance_api('report',a));
   elsif kind='history' then
     result_value:=jsonb_build_object('status','ok','history',public.finance_api('history',a));
   elsif kind='budget' then
     scope_id:=a->>'scope';owner_id:=case when scope_id='family' then 'family' else coalesce(a->>'beneficiary',ev.actor) end;
     if scope_id='personal' and not exists(select 1 from private.members where id=owner_id) then raise exception 'unknown beneficiary'; end if;
     cat:=a->>'category';amount:=(a->>'amount')::bigint;
     if amount<=0 or cat is null or length(cat)>80 then raise exception 'invalid budget'; end if;
     date_value:=(a->>'month')::date; if extract(day from date_value)<>1 then raise exception 'month must start on day 1'; end if;
     insert into private.budgets(owner,scope,category,month,limit_cents) values(owner_id,scope_id,cat,date_value,amount) on conflict(owner,scope,category,month) do update set limit_cents=excluded.limit_cents;
     result_value:=jsonb_build_object('status','ok','message','Presupuesto guardado');
   elsif kind='reminder' then
     insert into private.reminders(actor,label,due) values(ev.actor,left(a->>'label',120),(a->>'date')::date);
     result_value:=jsonb_build_object('status','ok','message','Recordatorio guardado');
   elsif kind in ('account','post','reverse') then
     if kind='reverse' then
       select * into tx from private.transactions where id=(a->>'target')::bigint and reverses is null;
       if not found or exists(select 1 from private.transactions where reverses=tx.id) then raise exception 'already reversed or unknown'; end if;
       if nullif(a->>'reason','') is null then raise exception 'reason required'; end if;
       insert into private.transactions(event_id,actor,date,kind,category,scope,payer,beneficiary,memo,reverses) values(ev.id,ev.actor,tx.date,'reverse',tx.category,tx.scope,tx.payer,tx.beneficiary,left(a->>'reason',240),tx.id) returning id into xid;
       insert into private.entries(transaction_id,account_id,delta) select xid,e.account_id,-e.delta from private.entries e where e.transaction_id=tx.id;
       result_value:=jsonb_build_object('status','ok','transaction_id',xid,'message','Movimiento corregido con reversión');
     elsif kind='account' then
       amount:=(a->>'amount')::bigint;
       if amount<0 or amount>100000000000000 then raise exception 'invalid opening amount'; end if;
       acct:=a->>'name';account_kind:=a->>'kind';
       if account_kind not in ('asset','liability','receivable') or acct is null or length(acct)<1 or length(acct)>64 then raise exception 'invalid account'; end if;
       if not exists(select 1 from private.members where id=a->>'owner') then raise exception 'unknown owner'; end if;
       insert into private.accounts(name,kind,owner) values(acct,account_kind,a->>'owner') returning id into aid;
       date_value:=(a->>'date')::date;
       insert into private.transactions(event_id,actor,date,kind,scope,payer,memo) values(ev.id,ev.actor,date_value,'opening','family',ev.actor,'saldo inicial') returning id into xid;
       if amount>0 then
         insert into private.accounts(name,kind,internal) values('equity:opening','equity',true) on conflict(name) do nothing;
         select id into bid from private.accounts where name='equity:opening';
         insert into private.entries(transaction_id,account_id,delta) values(xid,aid,case when account_kind='liability' then -amount else amount end),(xid,bid,case when account_kind='liability' then amount else -amount end);
       end if;
       result_value:=jsonb_build_object('status','ok','transaction_id',xid,'message','Cuenta guardada');
     else
       amount:=(a->>'amount')::bigint;
       if amount<=0 or amount>100000000000000 then raise exception 'invalid amount'; end if;
       date_value:=(a->>'date')::date;
       if date_value>current_date+interval '1 day' or date_value<date '2000-01-01' then raise exception 'invalid date'; end if;
       scope_id:=a->>'scope';if scope_id not in ('family','personal') then raise exception 'invalid scope'; end if;
       owner_id:=a->>'payer';if not exists(select 1 from private.members where id=owner_id) then raise exception 'unknown payer'; end if;
       if scope_id='personal' and not exists(select 1 from private.members where id=coalesce(a->>'beneficiary',owner_id)) then raise exception 'unknown beneficiary'; end if;
       acct:=a->>'account'; select ac.id,ac.kind into aid,account_kind from private.accounts ac where ac.name=acct and not ac.internal;
       if aid is null then raise exception 'unknown account'; end if;
       oth:=a->>'other'; if oth is not null then select ac.id,ac.kind into bid,other_kind from private.accounts ac where ac.name=oth and not ac.internal; end if;
       cat:=nullif(left(a->>'category',80),'');memo_text:=coalesce(left(a->>'memo',240),'');
       if a->>'kind' not in ('income','expense','transfer','borrow','lend','repayment','collection','refund') then raise exception 'invalid operation'; end if;
       if a->>'kind' in ('income','expense','refund') and cat is null then raise exception 'category required'; end if;
       if a->>'kind' in ('transfer','borrow','lend','repayment','collection') and (bid is null or bid=aid) then raise exception 'other account required'; end if;
       if a->>'kind'='expense' and account_kind not in ('asset','liability') then raise exception 'invalid payment account'; end if;
       if a->>'kind' in ('income','refund','borrow','collection') and account_kind<>'asset' then raise exception 'cash account required'; end if;
       if a->>'kind'='transfer' and (account_kind not in ('asset','liability') or other_kind not in ('asset','liability')) then raise exception 'invalid transfer'; end if;
       if a->>'kind' in ('borrow','repayment') and other_kind<>'liability' then raise exception 'liability required'; end if;
       if a->>'kind' in ('lend','collection') and other_kind<>'receivable' then raise exception 'receivable required'; end if;
       if a->>'kind' in ('lend','repayment') and account_kind<>'asset' then raise exception 'cash required'; end if;
       if coalesce((a->>'confirm_duplicate')::boolean,false) then
         if nullif(a->>'pending_event_id','') is null then raise exception 'pending duplicate required'; end if;
         update private.events set state='done',payload='{}'::jsonb,result=jsonb_build_object('status','confirmed','message','Duplicado confirmado')
           where id=(a->>'pending_event_id')::bigint and state='pending' and action=a-'{confirm_duplicate,pending_event_id}'::text[];
         if not found then raise exception 'duplicate already confirmed or changed'; end if;
       end if;
       signature:=md5(concat_ws('|',a->>'kind',date_value::text,amount::text,acct,coalesce(oth,''),cat,scope_id,owner_id,coalesce(a->>'beneficiary',owner_id)));
       if not coalesce((a->>'confirm_duplicate')::boolean,false) and exists(select 1 from private.transactions where duplicate_key=signature and reverses is null and not exists(select 1 from private.transactions r where r.reverses=private.transactions.id)) then
         result_value:=jsonb_build_object('status','duplicate','message','Posible duplicado. Responde confirmar al mensaje para registrarlo.');
         update private.events set result=result_value,state='pending',action=a where id=ev.id;
         insert into private.outbox(event_id,message,result) values(ev.id,result_value->>'message',result_value);
         return result_value;
       end if;
       insert into private.transactions(event_id,actor,date,kind,category,scope,payer,beneficiary,memo,duplicate_key) values(ev.id,ev.actor,date_value,a->>'kind',cat,scope_id,owner_id,case when scope_id='personal' then coalesce(a->>'beneficiary',owner_id) else null end,memo_text,signature) returning id into xid;
       if a->>'kind' in ('income','expense','refund') then
          insert into private.accounts(name,kind,internal) values(concat(case when a->>'kind'='income' then 'income' else 'expense' end,':',scope_id,':',case when scope_id='personal' then coalesce(a->>'beneficiary',owner_id) else 'all' end,':',cat),case when a->>'kind'='income' then 'income' else 'expense' end,true) on conflict(name) do nothing;
          select id into bid from private.accounts where name=concat(case when a->>'kind'='income' then 'income' else 'expense' end,':',scope_id,':',case when scope_id='personal' then coalesce(a->>'beneficiary',owner_id) else 'all' end,':',cat);
          if a->>'kind'='income' then delta:=amount; elsif a->>'kind'='refund' then delta:=amount; else delta:=-amount; end if;
          insert into private.entries(transaction_id,account_id,delta) values(xid,aid,delta),(xid,bid,-delta);
       else
          -- Liability has negative signed balance. Transfer into it clears debt.
          if a->>'kind' in ('transfer','repayment','lend') then delta:=-amount; else delta:=amount; end if;
          if a->>'kind'='transfer' and account_kind='liability' then delta:=-amount; end if;
          insert into private.entries(transaction_id,account_id,delta) values(xid,aid,delta),(xid,bid,-delta);
       end if;
       result_value:=jsonb_build_object('status','ok','transaction_id',xid,'message','Movimiento registrado');
     end if;
   else raise exception 'unsupported action';
   end if;
   update private.events set result=result_value,state='done',action=a,payload='{}'::jsonb where id=ev.id;
   insert into private.outbox(event_id,message,result) values(ev.id,coalesce(result_value->>'message','Consulta lista'),result_value);
   return result_value;
 end if;
 raise exception 'unknown operation %',op;
end $$;
revoke all on function public.finance_api(text,jsonb) from public,anon,authenticated;
grant execute on function public.finance_api(text,jsonb) to service_role;
