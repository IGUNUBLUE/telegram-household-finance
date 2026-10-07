-- Consultation remains shared. Financial corrections belong to the original author.
create function private.finance_mutation_permission(target_v bigint,actor_v text) returns jsonb
language plpgsql stable security invoker set search_path='' as $$
declare author_v text; name_v text;
begin
 select t.actor,m.name into author_v,name_v from private.transactions t join private.members m on m.id=t.actor where t.id=target_v;
 if not found then return jsonb_build_object('status','clarify','message','No encontré ese movimiento. Consulta su detalle.');end if;
 if author_v is distinct from actor_v then
  return jsonb_build_object('status','clarify','message','Este movimiento lo registró '||name_v||'. Solo esa persona puede cambiarlo o deshacerlo. Puedes consultar su detalle.');
 end if;
 return null;
end $$;
revoke all on function private.finance_mutation_permission(bigint,text) from public,anon,authenticated;
grant execute on function private.finance_mutation_permission(bigint,text) to service_role;

do $$
declare definition text;needle text;
begin
 select pg_get_functiondef('public.finance_pro(text,jsonb)'::regprocedure) into definition;
 needle:='if op=''mode'' then';
 if position(needle in definition)=0 then raise exception 'Missing edit mode branch';end if;
 definition:=replace(definition,needle,$patch$
 if op='mode' then
  if data->'mode'->>'kind'='edit' then
   r:=private.finance_mutation_permission((data->'mode'->>'target')::bigint,actor_v);
   if r is not null then return r;end if;
  end if;
 $patch$);
 needle:='if cmd=''stage'' then';
 if position(needle in definition)=0 then raise exception 'Missing staging branch';end if;
 definition:=replace(definition,needle,$patch$
 if cmd='stage' then
  if a->'proposal'->>'command' in ('correct','undo') then
   r:=private.finance_mutation_permission((a->'proposal'->>'target')::bigint,actor_v);
   if r is not null then return r;end if;
  end if;
 $patch$);
 needle:='elsif cmd in (''correct'',''undo'') then';
 if position(needle in definition)=0 then raise exception 'Missing correction branch';end if;
 definition:=replace(definition,needle,$patch$
 elsif cmd in ('correct','undo') then
  r:=private.finance_mutation_permission((a->>'target')::bigint,actor_v);
  if r is not null then return r;end if;
 $patch$);
 execute definition;

 select pg_get_functiondef('public.finance_api(text,jsonb)'::regprocedure) into definition;
 needle:='if kind=''reverse'' then';
 if position(needle in definition)=0 then raise exception 'Missing raw reversal branch';end if;
 definition:=replace(definition,needle,$patch$
 if kind='reverse' then
  if private.finance_mutation_permission((a->>'target')::bigint,ev.actor) is not null then
   raise exception 'Solo el autor del movimiento puede deshacerlo' using errcode='42501';
  end if;
 $patch$);
 execute definition;
end $$;
