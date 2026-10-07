-- Input pesos are decimal strings; ledger remains integer cents throughout.
create function private.cop_cents(value text,signed boolean default false) returns bigint language plpgsql immutable security invoker set search_path='' as $$
declare n numeric;
begin
 if value is null or value!~'^[0-9]{1,13}([.,][0-9]{1,2})?$' and not(signed and value~'^-[0-9]{1,13}([.,][0-9]{1,2})?$') then raise exception 'COP requires at most two decimal places without grouping';end if;
 n:=replace(value,',','.')::numeric*100;
 if abs(n)>100000000000000 then raise exception 'COP out of range';end if;
 return n::bigint;
end $$;
revoke all on function private.cop_cents(text,boolean) from public,anon,authenticated;
grant execute on function private.cop_cents(text,boolean) to service_role;
alter table private.recurring_rules alter column amount_cop type numeric(15,2) using amount_cop::numeric;
DO $$declare src text;new_src text;
begin
 src:=pg_get_functiondef('public.finance_agent_v3(text,jsonb)'::regprocedure);
 new_src:=replace(src,'(((d.fields->>''amount_cop'')::bigint)*100)::text','private.cop_cents(d.fields->>''amount_cop'')::text');
 if src=new_src then raise exception 'draft decimal patch missing';end if;execute new_src;
 src:=pg_get_functiondef('public.finance_routines(text,jsonb)'::regprocedure);
 new_src:=replace(src,'observed:=(data->>''balance_cop'')::bigint*100;','observed:=private.cop_cents(data->>''balance_cop'',true);');
 new_src:=replace(new_src,'''^-?[0-9]{1,13}$''','''^-?[0-9]{1,13}([.,][0-9]{1,2})?$''');
 new_src:=replace(new_src,'''^[0-9]{1,13}$''','''^[0-9]{1,13}([.,][0-9]{1,2})?$''');
 new_src:=replace(new_src,'(a->>''amount_cop'')::bigint','(private.cop_cents(a->>''amount_cop'')::numeric/100)');
 new_src:=replace(new_src,'rr.amount_cop::text','trim_scale(rr.amount_cop)::text');
 new_src:=replace(new_src,'label,amount_cop::text,account','label,trim_scale(amount_cop)::text amount_cop,account');
 if src=new_src then raise exception 'routine decimal patch missing';end if;execute new_src;
end $$;
