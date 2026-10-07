-- Preserve the five existing providers and their right-biased merge order.
-- This backend-only endpoint reduces network trips; it does not trim context.
create function public.finance_worker_context(op text,data jsonb default '{}') returns jsonb
language plpgsql security invoker set search_path='' as $$
declare phase_v text:=coalesce(data->>'phase','initial');event_data jsonb;r jsonb;
begin
 if op is distinct from 'context' then raise exception 'unsupported context operation';end if;
 if phase_v not in ('initial','refresh') then raise exception 'unsupported context phase';end if;
 event_data:=jsonb_build_object('id',data->'id');
 if phase_v='initial' then
  -- finance_agent(context) locks the event; finance_routines(context) locks
  -- household then event. Take household first to preserve the writer order
  -- now that those providers share one transaction. No lock spans the LLM call.
  perform 1 from private.household where id=1 for update;
 end if;
 r:=public.finance_api('context','{}'::jsonb);
 if phase_v='initial' then
  r:=r||public.finance_pro('context',event_data);
  r:=r||public.finance_natural('context',event_data);
 end if;
 r:=r||public.finance_agent('context',event_data);
 if phase_v='initial' then
  r:=r||public.finance_routines('context',event_data);
 end if;
 return r;
end $$;
revoke all on function public.finance_worker_context(text,jsonb) from public,anon,authenticated;
grant execute on function public.finance_worker_context(text,jsonb) to service_role;
