alter table private.accounts add column parent_account_id bigint references private.accounts(id), add column pocket_name text;
alter table private.accounts add constraint pocket_fields check ((parent_account_id is null and pocket_name is null) or (parent_account_id is not null and pocket_name is not null and kind='asset' and not internal));
create unique index pockets_unique_name on private.accounts(parent_account_id,lower(btrim(pocket_name))) where parent_account_id is not null;

create function private.finance_create_pocket(event_v bigint,a jsonb) returns jsonb language plpgsql set search_path=public,private as $$
declare ev private.events; parent private.accounts; child bigint; full_name text; label text; r jsonb; cents bigint;
begin
 select * into strict ev from private.events where id=event_v;
 select * into parent from private.accounts where name=a->>'account' and not internal for update;
 if not found or parent.kind<>'asset' or parent.parent_account_id is not null or parent.owner<>ev.actor then raise exception 'El bolsillo debe pertenecer a una cuenta propia de dinero';end if;
 label:=btrim(a->>'name');full_name:=parent.name||' · '||label;
 if label is null or length(label) not between 1 and 40 or length(full_name)>64 then raise exception 'Nombre de bolsillo inválido';end if;
 if exists(select 1 from private.accounts where parent_account_id=parent.id and lower(btrim(pocket_name))=lower(label)) then raise exception 'Ese bolsillo ya existe; consulta su saldo';end if;
 if coalesce(a->>'amount','')!~'^[0-9]+$' then raise exception 'Saldo inválido';end if;
 cents:=(a->>'amount')::bigint;
 if cents>100000000000000 or (a->>'date') is null or (a->>'date')::date>timezone('America/Bogota',now())::date then raise exception 'Saldo o fecha inválidos';end if;
 child:=nextval('private.child_event_seq');insert into private.events(id,actor,payload) values(child,ev.actor,jsonb_build_object('source_event',ev.id,'operation','create_pocket'));
 r:=public.finance_api('apply',jsonb_build_object('id',child,'action',jsonb_build_object('type','account','name',full_name,'owner',ev.actor,'kind','asset','amount',cents::text,'date',a->>'date')));
 update private.accounts set parent_account_id=parent.id,pocket_name=label where name=full_name;
 delete from private.outbox where event_id=child;
 return r||jsonb_build_object('pocket_created',true,'account',parent.name,'pocket',label,'opening_amount',cents::text,'editable',false,'message','Bolsillo registrado con su saldo inicial. No es ingreso ni gasto.');
end $$;
revoke all on function private.finance_create_pocket(bigint,jsonb) from public,anon,authenticated;
grant execute on function private.finance_create_pocket(bigint,jsonb) to service_role;

-- SQL totals: the parent holds only available money; children are counted once.
create function private.finance_pocket_groups() returns jsonb language sql stable set search_path=public,private as $$
 with balances as (select a.*,coalesce((select sum(e.delta) from private.entries e where e.account_id=a.id),0) balance from private.accounts a where not internal)
 select coalesce(jsonb_agg(jsonb_build_object('account',p.name,'available',p.balance::text,'balance_known',p.balance_known and not exists(select 1 from balances c where c.parent_account_id=p.id and not c.balance_known),'pockets_total',(select sum(c.balance)::text from balances c where c.parent_account_id=p.id),'total',(p.balance+(select sum(c.balance) from balances c where c.parent_account_id=p.id))::text,'pockets',(select jsonb_agg(jsonb_build_object('name',c.pocket_name,'account',c.name,'balance',c.balance::text,'balance_known',c.balance_known) order by c.id) from balances c where c.parent_account_id=p.id)) order by p.id),'[]'::jsonb) from balances p where p.parent_account_id is null and exists(select 1 from balances c where c.parent_account_id=p.id)
$$;
revoke all on function private.finance_pocket_groups() from public,anon,authenticated;
grant execute on function private.finance_pocket_groups() to service_role;

do $$
declare definition text;
begin
 select pg_get_functiondef('public.finance_pro(text,jsonb)'::regprocedure) into definition;
 if position('elsif cmd=''account'' then' in definition)=0 then raise exception 'Account branch missing';end if;
 execute replace(definition,'elsif cmd=''account'' then',E'elsif cmd=''pocket'' then\n  if p.id is null then raise exception ''Confirma la propuesta del bolsillo'';end if;\n  r:=private.finance_create_pocket(ev.id,a);\n elsif cmd=''account'' then');
 select pg_get_functiondef('public.finance_api(text,jsonb)'::regprocedure) into definition;
 definition:=replace(definition,'''owner'',ac.owner)', '''owner'',ac.owner,''parent_account'',(select parent.name from private.accounts parent where parent.id=ac.parent_account_id),''pocket_name'',ac.pocket_name)');
 definition:=replace(definition,'''balances'',(select', '''pocket_groups'',private.finance_pocket_groups(),''balances'',(select');
 execute definition;
end $$;
