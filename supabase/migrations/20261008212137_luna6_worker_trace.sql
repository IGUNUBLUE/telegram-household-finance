-- Accept Luna 6 telemetry; retain legacy trace compatibility for rollback.
create or replace function public.finance_worker_trace(op text,data jsonb default '{}') returns jsonb
language plpgsql security invoker set search_path='' as $$
declare metrics_v jsonb;tools_v jsonb;
begin
 if op<>'trace' or data->>'model' not in ('gpt-6-luna','gpt-5.6-luna','space-bunny-free') or data->>'model' is null then raise exception 'invalid trace';end if;
 if jsonb_typeof(coalesce(data->'tools','[]'))<>'array' or jsonb_array_length(coalesce(data->'tools','[]'))>24 then raise exception 'invalid trace tools';end if;
 select coalesce(jsonb_agg(jsonb_build_object('name',x->>'name','status',x->>'status')),'[]') into tools_v
 from jsonb_array_elements(coalesce(data->'tools','[]')) x
 where x->>'name' ~ '^[a-z_]{1,64}$' and x->>'status' in ('ok','error');
 metrics_v:=jsonb_build_object('rounds',least(5,greatest(0,coalesce((data->>'rounds')::int,0))),
 'elapsed_ms',least(1000000,greatest(0,coalesce((data->>'elapsed_ms')::bigint,0))),
 'input_tokens',least(10000000,greatest(0,coalesce((data->>'input_tokens')::bigint,0))),
 'output_tokens',least(100000,greatest(0,coalesce((data->>'output_tokens')::bigint,0))),'tools',tools_v);
 insert into private.agent_traces(event_id,model,metrics) values((data->>'id')::bigint,data->>'model',metrics_v) on conflict(event_id) do nothing;
 return '{}';
end $$;
revoke all on function public.finance_worker_trace(text,jsonb) from public,anon,authenticated;
grant execute on function public.finance_worker_trace(text,jsonb) to service_role;
