-- Read-only person filtering before ordering/limiting. Household searches remain
-- available; movement scope (family/personal) is independent of person identity.
create or replace function public.finance_movement_search(op text,data jsonb default '{}') returns jsonb
language plpgsql stable security invoker set search_path='' as $$
declare amount_v bigint;name_v text;r jsonb;actor_v text;person_v text;
 scope_v text:=coalesce(data->>'person_scope','all');
 role_v text:=coalesce(data->>'person_role','author');
 sort_v text:=coalesce(data->>'sort_by','date');movement_scope_v text:=coalesce(data->>'movement_scope','all');limit_v int:=30;
begin
 if op<>'search' then raise exception 'unsupported search operation';end if;
 select e.actor into actor_v from private.events e join private.members m on m.id=e.actor where e.id=(data->>'id')::bigint;
 if not found then raise exception 'unknown event';end if;
 if data ? 'person_scope' and (jsonb_typeof(data->'person_scope')<>'string' or scope_v not in ('all','mine','member')) then raise exception 'invalid person scope';end if;
 if data ? 'person_role' and (jsonb_typeof(data->'person_role')<>'string' or role_v not in ('author','payer','account_owner')) then raise exception 'invalid person role';end if;
 if scope_v='all' and data ? 'person_role' then raise exception 'person scope required for person role';end if;
 if scope_v='member' then
  person_v:=data->>'member_id';
  if jsonb_typeof(data->'member_id') is distinct from 'string' or person_v !~ '^[0-9]+$' or not exists(select 1 from private.members where id=person_v) then raise exception 'known member required';end if;
 elsif data ? 'member_id' then raise exception 'member_id requires member scope';
 elsif scope_v='mine' then person_v:=actor_v;
 end if;
 if data ? 'sort_by' and (jsonb_typeof(data->'sort_by')<>'string' or sort_v not in ('date','registered')) then raise exception 'invalid movement sort';end if;
 if data ? 'movement_scope' and (jsonb_typeof(data->'movement_scope')<>'string' or movement_scope_v not in ('all','family','personal')) then raise exception 'invalid movement scope';end if;
 if data ? 'limit' then
  if jsonb_typeof(data->'limit')<>'number' or data->>'limit' !~ '^[0-9]+$' or (data->>'limit')::numeric not between 1 and 30 then raise exception 'invalid movement limit';end if;
  limit_v:=(data->>'limit')::int;
 end if;
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
  select t.id,t.date,t.created_at,t.kind,t.memo,t.category,t.scope,t.actor,t.payer,t.counterparty,
   (select max(abs(e.delta)) from private.entries e join private.accounts a on a.id=e.account_id where e.transaction_id=t.id and not a.internal) amount_cents,
   (select jsonb_agg(jsonb_build_object('account',a.name,'owner',a.owner,'delta_cents',e.delta::text) order by a.name) from private.entries e join private.accounts a on a.id=e.account_id where e.transaction_id=t.id and not a.internal) accounts
  from private.transactions t
  where t.kind<>'opening' and t.reverses is null and not exists(select 1 from private.transactions rr where rr.reverses=t.id)
   and (person_v is null
    or (role_v='author' and t.actor=person_v)
    or (role_v='payer' and t.payer=person_v)
    or (role_v='account_owner' and exists(select 1 from private.entries e join private.accounts a on a.id=e.account_id where e.transaction_id=t.id and not a.internal and a.owner=person_v)))
   and (movement_scope_v='all' or t.scope=movement_scope_v)
   and (data->>'kind' is null or t.kind=data->>'kind')
   and (data->>'from' is null or t.date>=(data->>'from')::date) and (data->>'to' is null or t.date<=(data->>'to')::date)
   and (amount_v is null or exists(select 1 from private.entries e join private.accounts a on a.id=e.account_id where e.transaction_id=t.id and not a.internal and abs(e.delta)=amount_v))
   and (data->>'account' is null or exists(select 1 from private.entries e join private.accounts a on a.id=e.account_id where e.transaction_id=t.id and not a.internal and a.name=data->>'account'))
   and (data->>'from_account' is null or exists(select 1 from private.entries e join private.accounts a on a.id=e.account_id where e.transaction_id=t.id and not a.internal and a.name=data->>'from_account' and e.delta<0))
   and (data->>'to_account' is null or exists(select 1 from private.entries e join private.accounts a on a.id=e.account_id where e.transaction_id=t.id and not a.internal and a.name=data->>'to_account' and e.delta>0))
   and (nullif(data->>'query','') is null or strpos(lower(t.memo),lower(data->>'query'))>0 or strpos(lower(t.counterparty),lower(data->>'query'))>0 or exists(select 1 from private.entries e join private.accounts a on a.id=e.account_id where e.transaction_id=t.id and not a.internal and strpos(lower(a.name),lower(data->>'query'))>0))
 ), shown as (
  select m.id::text,m.date,m.created_at as registered_at,m.kind,m.memo,m.category,m.scope,m.actor,m.payer,m.counterparty,m.amount_cents::text,
   (select name from private.members where id=m.actor) actor_name,
   (select name from private.members where id=m.payer) payer_name,
   (m.amount_cents::numeric/100)::numeric(16,2)::text amount_cop,m.accounts,
   (select x->>'account' from jsonb_array_elements(m.accounts) x where (x->>'delta_cents')::bigint<0 limit 1) from_account,
   (select x->>'account' from jsonb_array_elements(m.accounts) x where (x->>'delta_cents')::bigint>0 limit 1) to_account,
   row_number() over(order by case when sort_v='date' then m.date end desc nulls last,case when sort_v='registered' then m.created_at end desc nulls last,m.id desc) ordinal
  from matches m order by ordinal limit limit_v
 )
 select jsonb_build_object('status','movement_search','exists',exists(select 1 from matches),'total_matches',(select count(*) from matches),
  'complete',(select count(*)<=limit_v from matches),'filters',data-'id','sort_by',sort_v,
  'person_filter',jsonb_build_object('scope',scope_v,'role',case when person_v is not null then role_v end,'member_id',person_v,'member_name',(select name from private.members where id=person_v)),
  'totals_cop',(select jsonb_object_agg(totals.kind,totals.amount_cop) from (
   select k.kind,round(coalesce(sum(m.amount_cents),0)::numeric/100,2)::text amount_cop
   from unnest(array['income','expense','refund','transfer','borrow','lend','repayment','collection']) k(kind)
   left join matches m on m.kind=k.kind group by k.kind
  ) totals),
  'movements',coalesce((select jsonb_agg(to_jsonb(s)-'ordinal' order by s.ordinal) from shown s),'[]'::jsonb)) into r;
 return r;
end $$;
revoke all on function public.finance_movement_search(text,jsonb) from public,anon,authenticated;
grant execute on function public.finance_movement_search(text,jsonb) to service_role;
