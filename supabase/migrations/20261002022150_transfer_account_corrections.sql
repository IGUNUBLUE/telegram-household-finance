-- Correct transfer endpoints together, before reversing anything. Keep author guards
-- and the household/proposal locks in finance_pro; ledger rows stay immutable.
create function private.finance_correction_patch(original_v jsonb,proposal_v jsonb) returns jsonb
language plpgsql stable security invoker set search_path='' as $$
declare field_v text:=proposal_v->>'field';patch_v jsonb;normalized_v jsonb:=proposal_v;
begin
 if original_v->>'type' is distinct from 'post' or field_v is null or field_v not in ('amount','account','accounts') then
  return jsonb_build_object('status','clarify','message','Ese movimiento no admite esta corrección. Consulta su detalle.');
 end if;
 -- Legacy origin-only proposals selecting the old destination reverse the same
 -- pair of accounts. New previews expose both endpoints explicitly.
 if field_v='account' and original_v->>'kind'='transfer' and proposal_v->>'value'=original_v->>'other' then
  field_v:='accounts';normalized_v:=proposal_v||jsonb_build_object('field','accounts','value',jsonb_build_object('account',proposal_v->>'value','other',original_v->>'account'));
 end if;
 if field_v='accounts' then
  patch_v:=normalized_v->'value';
  if original_v->>'kind' is distinct from 'transfer' or jsonb_typeof(patch_v) is distinct from 'object'
   or jsonb_typeof(patch_v->'account') is distinct from 'string' or jsonb_typeof(patch_v->'other') is distinct from 'string'
   or patch_v->>'account'=patch_v->>'other'
   or not exists(select 1 from private.accounts where name=patch_v->>'account' and not internal)
   or not exists(select 1 from private.accounts where name=patch_v->>'other' and not internal) then
   return jsonb_build_object('status','clarify','message','Indica dos cuentas registradas diferentes: de cuál salió y a cuál llegó. No cambié el movimiento.');
  end if;
  -- Only these two keys may be changed, regardless of additional JSON keys.
  patch_v:=jsonb_build_object('account',patch_v->>'account','other',patch_v->>'other');
  normalized_v:=normalized_v||jsonb_build_object('value',patch_v);
 else
  if jsonb_typeof(normalized_v->'value') is distinct from 'string' then
   return jsonb_build_object('status','clarify','message','Indica el monto o la cuenta que quieres corregir.');
  end if;
  if field_v='account' and not exists(select 1 from private.accounts where name=normalized_v->>'value' and not internal) then
   return jsonb_build_object('status','clarify','message','Esa cuenta no está registrada. No cambié el movimiento.');
  end if;
  patch_v:=jsonb_build_object(field_v,normalized_v->>'value');
 end if;
 return jsonb_build_object('status','valid','proposal',normalized_v,'patch',patch_v);
end $$;
revoke all on function private.finance_correction_patch(jsonb,jsonb) from public,anon,authenticated;
grant execute on function private.finance_correction_patch(jsonb,jsonb) to service_role;

do $$
declare definition text;needle text;
begin
 select pg_get_functiondef('public.finance_pro(text,jsonb)'::regprocedure) into definition;
 needle:='a jsonb;';
 if position(needle in definition)=0 then raise exception 'Missing correction variable declaration';end if;
 definition:=replace(definition,needle,'a jsonb;correction_patch_v jsonb;');
 needle:='if a->''proposal''->>''command'' in (''stage'',''confirm'',''cancel_proposal'') then';
 if position(needle in definition)=0 then raise exception 'Missing proposal validation';end if;
 definition:=replace(definition,needle,$patch$
 if a->'proposal'->>'command'='correct' then
  select e.action into before_v from private.transactions tt join private.events e on e.id=tt.event_id where tt.id=(a->'proposal'->>'target')::bigint;
  r:=private.finance_correction_patch(before_v,a->'proposal');
  if r->>'status'='clarify' then return r;end if;
  a:=jsonb_set(a,'{proposal}',r->'proposal');before_v:='{}';
 end if;
 if a->'proposal'->>'command' in ('stage','confirm','cancel_proposal') then
 $patch$);
 needle:='if cmd=''correct'' and (before_v->>''type''<>''post'' or a->>''field'' not in (''amount'',''account'')) then raise exception ''unsupported correction'';end if;';
 if position(needle in definition)=0 then raise exception 'Missing correction validation';end if;
 definition:=replace(definition,needle,$patch$
 if cmd='correct' then
  r:=private.finance_correction_patch(before_v,a);
  if r->>'status'='clarify' then return r;end if;
  a:=r->'proposal';correction_patch_v:=r->'patch';
 end if;
 $patch$);
 needle:='before_v:=before_v-''{confirm_duplicate,pending_event_id}''::text[];';
 if position(needle in definition)=0 then raise exception 'Missing correction provenance cleanup';end if;
 definition:=replace(definition,needle,'-- Preserve the original action in the audit, not its draft linkage in the replacement.');
 needle:='before_v||jsonb_build_object(a->>''field'',a->>''value'')';
 if position(needle in definition)=0 then raise exception 'Missing correction replacement';end if;
 definition:=replace(definition,needle,'(before_v-''{confirm_duplicate,pending_event_id,_draft_id,_draft_revision}''::text[])||correction_patch_v');
 execute definition;
end $$;
