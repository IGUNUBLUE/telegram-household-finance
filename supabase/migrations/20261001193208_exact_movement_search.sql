-- A read-only search of the ledger, independent of semantic candidates and display limits.
create function public.finance_movement_search(op text,data jsonb default '{}') returns jsonb
language plpgsql security invoker set search_path='' as $$
declare amount_v bigint;name_v text;r jsonb;
begin
 if op<>'search' then raise exception 'unsupported search operation';end if;
 if not exists(select 1 from private.events e join private.members m on m.id=e.actor where e.id=(data->>'id')::bigint) then raise exception 'unknown event';end if;
 if data->>'amount_cop' is not null then
  if data->>'amount_cop' !~ '^(0|[1-9][0-9]{0,12})([.,][0-9]{1,2})?$' then raise exception 'invalid amount';end if;
  amount_v:=(replace(data->>'amount_cop',',','.')::numeric*100)::bigint;
 end if;
 if data->>'kind' is not null and data->>'kind'<>all(array['income','expense','refund','transfer','borrow','lend','repayment','collection']) then raise exception 'invalid movement kind';end if;
 if (data->>'from')::date>(data->>'to')::date then raise exception 'invalid date interval';end if;
 foreach name_v in array array[data->>'account',data->>'from_account',data->>'to_account'] loop
  if name_v is not null and not exists(select 1 from private.accounts a where a.name=name_v and not a.internal) then raise exception 'account unavailable';end if;
 end loop;
 with matches as materialized (
  select t.id,t.date,t.kind,t.memo,t.category,t.scope,t.payer,
   (select max(abs(e.delta)) from private.entries e join private.accounts a on a.id=e.account_id where e.transaction_id=t.id and not a.internal) amount_cents,
   (select jsonb_agg(jsonb_build_object('account',a.name,'owner',a.owner,'delta_cents',e.delta::text) order by a.name) from private.entries e join private.accounts a on a.id=e.account_id where e.transaction_id=t.id and not a.internal) accounts
  from private.transactions t
  where t.kind<>'opening' and t.reverses is null and not exists(select 1 from private.transactions rr where rr.reverses=t.id)
   and (data->>'kind' is null or t.kind=data->>'kind')
   and (data->>'from' is null or t.date>=(data->>'from')::date) and (data->>'to' is null or t.date<=(data->>'to')::date)
   and (amount_v is null or exists(select 1 from private.entries e join private.accounts a on a.id=e.account_id where e.transaction_id=t.id and not a.internal and abs(e.delta)=amount_v))
   and (data->>'account' is null or exists(select 1 from private.entries e join private.accounts a on a.id=e.account_id where e.transaction_id=t.id and not a.internal and a.name=data->>'account'))
   and (data->>'from_account' is null or exists(select 1 from private.entries e join private.accounts a on a.id=e.account_id where e.transaction_id=t.id and not a.internal and a.name=data->>'from_account' and e.delta<0))
   and (data->>'to_account' is null or exists(select 1 from private.entries e join private.accounts a on a.id=e.account_id where e.transaction_id=t.id and not a.internal and a.name=data->>'to_account' and e.delta>0))
   and (nullif(data->>'query','') is null or strpos(lower(t.memo),lower(data->>'query'))>0 or exists(select 1 from private.entries e join private.accounts a on a.id=e.account_id where e.transaction_id=t.id and not a.internal and strpos(lower(a.name),lower(data->>'query'))>0))
 ), shown as (
  select id::text,date,kind,memo,category,scope,payer,amount_cents::text,
   (amount_cents::numeric/100)::numeric(16,2)::text amount_cop,accounts,
   (select x->>'account' from jsonb_array_elements(accounts) x where (x->>'delta_cents')::bigint<0 limit 1) from_account,
   (select x->>'account' from jsonb_array_elements(accounts) x where (x->>'delta_cents')::bigint>0 limit 1) to_account
  from matches order by date desc,id desc limit 30
 )
 select jsonb_build_object('status','movement_search','exists',exists(select 1 from matches),'total_matches',(select count(*) from matches),
  'complete',(select count(*)<=30 from matches),'filters',data-'id','movements',coalesce((select jsonb_agg(to_jsonb(s)) from shown s),'[]'::jsonb)) into r;
 return r;
end $$;
revoke all on function public.finance_movement_search(text,jsonb) from public,anon,authenticated;
grant execute on function public.finance_movement_search(text,jsonb) to service_role;
