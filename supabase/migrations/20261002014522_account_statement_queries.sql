-- Exact account statement: no ledger mutation, no semantic memory or display-based sums.
create function public.finance_account_statement(op text,data jsonb default '{}') returns jsonb
language plpgsql security invoker set search_path='' as $$
declare ac private.accounts;as_of_v date;offset_v integer;result_v jsonb;direction_v integer;known_v boolean;
begin
 if op<>'statement' then raise exception 'unsupported statement operation';end if;
 if not exists(select 1 from private.events e join private.members m on m.id=e.actor where e.id=(data->>'id')::bigint) then raise exception 'unknown event';end if;
 select * into ac from private.accounts where name=data->>'account' and not internal;
 if not found then raise exception 'account unavailable';end if;
 as_of_v:=(data->>'as_of')::date;if as_of_v is null then raise exception 'date required';end if;
 if as_of_v>(now() at time zone 'America/Bogota')::date then raise exception 'future balance date';end if;
 direction_v:=case when ac.kind='liability' then -1 else 1 end;
 select exists(select 1 from private.transactions ot join private.events oe on oe.id=ot.event_id where ot.kind='opening' and oe.action->>'name'=ac.name and coalesce((oe.action->>'balance_known')::boolean,true) and ot.date<=as_of_v and not exists(select 1 from private.transactions rev where rev.reverses=ot.id and rev.date<=as_of_v)) into known_v;
 offset_v:=coalesce((data->>'offset')::integer,0);if offset_v<0 then raise exception 'invalid offset';end if;
 with lines as materialized (
  select t.id,t.date,t.kind,t.memo,t.reverses,e.delta,
   (select name from private.members where id=t.actor) author_name,
   (select rr.id::text from private.transactions rr where rr.reverses=t.id and rr.date<=as_of_v) reversed_by,
   (select a.name from private.entries ee join private.accounts a on a.id=ee.account_id where ee.transaction_id=t.id and not a.internal and ee.delta<0 limit 1) from_account,
   (select a.name from private.entries ee join private.accounts a on a.id=ee.account_id where ee.transaction_id=t.id and not a.internal and ee.delta>0 limit 1) to_account
  from private.entries e join private.transactions t on t.id=e.transaction_id where e.account_id=ac.id and t.date<=as_of_v
 ), totals as (
  select coalesce(sum(delta),0) balance,coalesce(sum(delta) filter(where kind='opening'),0) opening,
   coalesce(sum(direction_v*delta) filter(where kind<>'opening' and direction_v*delta>0),0) credits,
   coalesce(-sum(direction_v*delta) filter(where kind<>'opening' and direction_v*delta<0),0) debits,count(*) n from lines
 ), pockets as (
  select a.name,a.pocket_name,exists(select 1 from private.transactions ot join private.events oe on oe.id=ot.event_id where ot.kind='opening' and oe.action->>'name'=a.name and coalesce((oe.action->>'balance_known')::boolean,true) and ot.date<=as_of_v and not exists(select 1 from private.transactions rev where rev.reverses=ot.id and rev.date<=as_of_v)) balance_known,coalesce((select sum(e.delta) from private.entries e join private.transactions t on t.id=e.transaction_id where e.account_id=a.id and t.date<=as_of_v),0) balance
  from private.accounts a where a.parent_account_id=ac.id
 ), shown as (select * from lines order by date desc,id desc limit 30 offset offset_v)
 select jsonb_build_object('status','account_statement','account',ac.name,'kind',ac.kind,'owner_name',(select name from private.members where id=ac.owner),'as_of',as_of_v,'balance_known',known_v,
  'balance_cents',(direction_v*s.balance)::text,'ledger_balance_cents',s.balance::text,'opening_cents',(direction_v*s.opening)::text,'credits_cents',s.credits::text,'debits_cents',s.debits::text,
  'pockets_total_cents',(select coalesce(sum(balance),0)::text from pockets),'total_with_pockets_cents',(direction_v*s.balance+(select coalesce(sum(balance),0) from pockets))::text,
  'pockets_complete',not exists(select 1 from pockets where not balance_known),
  'pockets',coalesce((select jsonb_agg(jsonb_build_object('name',pocket_name,'account',name,'balance_known',balance_known,'balance_cents',balance::text) order by name) from pockets),'[]'::jsonb),
  'total_movements',s.n,'complete',offset_v+30>=s.n,'offset',offset_v,'next_offset',case when offset_v+30<s.n then offset_v+30 else null end,
  'movements',coalesce((select jsonb_agg(jsonb_build_object('id',id::text,'date',date,'kind',kind,'memo',memo,'delta_cents',delta::text,'effect_cents',(direction_v*delta)::text,'delta_cop',(delta::numeric/100)::numeric(16,2)::text,'author_name',author_name,'reverses',reverses::text,'reversed_by',reversed_by,'from_account',from_account,'to_account',to_account) order by date desc,id desc) from shown),'[]'::jsonb)) into result_v from totals s;
 return result_v;
end $$;
revoke all on function public.finance_account_statement(text,jsonb) from public,anon,authenticated;
grant execute on function public.finance_account_statement(text,jsonb) to service_role;

-- A failed query is not an invalid financial record. Keep the immutable ledger intact.
do $$
declare definition text;old_message text:='No pude registrar el mensaje #''||(data->>''id'')||''. Hay que revisar el dato y enviarlo de nuevo.';new_message text:='No pude completar tu solicitud. Inténtalo de nuevo en un momento.';
begin
 select pg_get_functiondef('public.finance_api(text,jsonb)'::regprocedure) into definition;
 if strpos(definition,old_message)=0 then raise exception 'failure message definition changed';end if;
 execute replace(definition,old_message,new_message);
end $$;
