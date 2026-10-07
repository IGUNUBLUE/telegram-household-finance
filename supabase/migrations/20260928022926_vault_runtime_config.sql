-- Only the server's existing service role may read this fixed allowlist.
create function public.finance_runtime_config() returns jsonb
language sql security invoker set search_path='' as $$
 select coalesce(jsonb_object_agg(name,decrypted_secret),'{}'::jsonb)
 from vault.decrypted_secrets
 where name in ('TELEGRAM_GROUP_ID','TELEGRAM_BOT_TOKEN','OPENCODE_GO_API_KEY','TELEGRAM_WEBHOOK_SECRET','WORKER_SECRET','TRANSCRIPTION_API_KEY');
$$;
revoke all on function public.finance_runtime_config() from public,anon,authenticated;
grant execute on function public.finance_runtime_config() to service_role;
