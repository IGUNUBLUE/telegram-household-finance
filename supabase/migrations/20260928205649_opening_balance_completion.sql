-- Fill a previously unknown opening balance without treating it as income.
create or replace function private.finance_complete_opening(event_v bigint, a jsonb) returns jsonb
language plpgsql set search_path=public,private as $$
declare ev private.events; ac private.accounts; cents bigint; day_v date; child bigint; tx bigint; equity bigint; signed_v bigint; r jsonb;
begin
 select * into strict ev from private.events where id=event_v;
 select * into ac from private.accounts where name=a->>'account' and not internal for update;
 if not found or ac.owner<>ev.actor then raise exception 'Solo el titular puede completar este saldo';end if;
 if ac.balance_known then raise exception 'El saldo inicial ya está registrado; consulta su detalle para corregirlo';end if;
 if coalesce(a->>'amount','') !~ '^[0-9]+$' then raise exception 'Importe en centavos inválido';end if;
 cents:=(a->>'amount')::bigint;day_v:=(a->>'date')::date;
 if cents>100000000000000 or day_v is null or day_v>timezone('America/Bogota',now())::date then raise exception 'Monto o fecha inválidos';end if;
 if exists(select 1 from private.entries e join private.transactions t on t.id=e.transaction_id where e.account_id=ac.id and t.kind not in ('opening','reverse') and t.date<day_v and not exists(select 1 from private.transactions rev where rev.reverses=t.id)) then raise exception 'Hay movimientos anteriores. Indica el saldo inicial antes de esos movimientos y su fecha; el saldo actual no es el inicial';end if;
 if coalesce((select sum(e.delta) from private.entries e join private.transactions t on t.id=e.transaction_id where e.account_id=ac.id and t.kind='opening' and not exists(select 1 from private.transactions rev where rev.reverses=t.id)),0)<>0 then raise exception 'Existe una apertura que requiere revisión';end if;
 signed_v:=case when ac.kind='liability' then -cents else cents end;
 child:=nextval('private.child_event_seq');
 insert into private.events(id,actor,action,state) values(child,ev.actor,jsonb_build_object('type','opening_balance','name',ac.name,'amount',cents::text,'date',day_v,'parent_event',ev.id),'done');
 insert into private.transactions(event_id,actor,date,kind,scope,payer,memo) values(child,ev.actor,day_v,'opening','family',ev.actor,'Saldo inicial completado por el titular') returning id into tx;
 if cents<>0 then
  insert into private.accounts(name,kind,internal) values('equity:opening','equity',true) on conflict(name) do nothing;
  select id into equity from private.accounts where name='equity:opening';
  insert into private.entries(transaction_id,account_id,delta) values(tx,ac.id,signed_v),(tx,equity,-signed_v);
 end if;
 update private.accounts set balance_known=true where id=ac.id;
 r:=jsonb_build_object('status','ok','opening_completed',true,'account',ac.name,'opening_amount',cents::text,'date',day_v,'transaction_id',tx,'editable',false,'message','Saldo inicial guardado. No cuenta como ingreso ni gasto.');
 update private.events set result=r where id=child;
 return r;
end $$;
revoke all on function private.finance_complete_opening(bigint,jsonb) from public,anon,authenticated;
grant execute on function private.finance_complete_opening(bigint,jsonb) to service_role;

do $$
declare definition text;
begin
 select pg_get_functiondef('public.finance_pro(text,jsonb)'::regprocedure) into definition;
 if position('elsif cmd=''account'' then' in definition)=0 then raise exception 'Missing account branch';end if;
 definition:=replace(definition,'elsif cmd=''account'' then',E'elsif cmd=''opening_balance'' then\n  if p.id is null then raise exception ''Se requiere confirmar la propuesta de saldo inicial'';end if;\n  r:=private.finance_complete_opening(ev.id,a);\n elsif cmd=''account'' then');
 execute definition;
end $$;

-- Reversing the completion restores the unknown state, including zero balances.
create or replace function private.opening_reversed() returns trigger language plpgsql set search_path=public,private as $$
declare original_action jsonb;
begin
 if new.reverses is not null then
  select ev.action into original_action from private.transactions t join private.events ev on ev.id=t.event_id where t.id=new.reverses;
  if original_action->>'type'='opening_balance' then
   update private.accounts set balance_known=false where name=original_action->>'name';
  end if;
 end if;
 return new;
end $$;
revoke all on function private.opening_reversed() from public,anon,authenticated;
create trigger opening_completion_reversed after insert on private.transactions for each row execute function private.opening_reversed();
-- An old unknown placeholder is not a historical verified opening.
do $$
declare definition text;
begin
 select pg_get_functiondef('public.finance_routines(text,jsonb)'::regprocedure) into definition;
 definition:=replace(definition,'ot.kind=''opening'' and oe.action->>''name''=ac.name','ot.kind=''opening'' and coalesce((oe.action->>''balance_known'')::boolean,true) and oe.action->>''name''=ac.name');
 execute definition;
end $$;
