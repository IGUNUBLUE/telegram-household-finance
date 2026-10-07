-- Run only after the offline SQLite import, restart checks and verified offsite backup.
-- Financial ledger, queue, permissions and semantic memory are outside this migration.
DO $$
declare schema_v text; relation_v text;
begin
 if exists(select 1 from pg_stat_activity where usename='flue_finance_login') then
  raise exception 'Flue runtime sessions are still active';
 end if;
 foreach schema_v in array array['flue_finance','flue_sqlite_simulation'] loop
  if exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname=schema_v and c.relkind in ('r','p','v','m','f')
    and c.relname not in ('flue_meta','flue_submission_chunks','flue_agent_submissions','flue_conversation_streams','flue_conversation_stream_batches','flue_conversation_fold_checkpoints','flue_attachments')) then
   raise exception 'Unexpected object in obsolete Flue runtime schema';
  end if;
  if to_regclass(format('%I.flue_agent_submissions',schema_v)) is not null then
   execute format('select exists(select 1 from %I.flue_agent_submissions where status <> ''settled'')',schema_v) into relation_v;
   if relation_v::boolean then raise exception 'Flue runtime has unfinished work'; end if;
  end if;
 end loop;
 -- RESTRICT is intentional: unknown dependencies abort rather than cascade into other schemas.
 foreach schema_v in array array['flue_finance','flue_sqlite_simulation'] loop
  execute format('drop table if exists %I.flue_attachments, %I.flue_submission_chunks, %I.flue_agent_submissions, %I.flue_conversation_fold_checkpoints, %I.flue_conversation_stream_batches, %I.flue_conversation_streams, %I.flue_meta restrict',schema_v,schema_v,schema_v,schema_v,schema_v,schema_v,schema_v);
  execute format('drop schema if exists %I restrict',schema_v);
 end loop;
 if exists(select 1 from pg_roles where rolname='flue_finance_login') then
  revoke flue_finance_login from postgres;
  drop role flue_finance_login;
 end if;
 if to_regclass('vault.secrets') is not null then
  delete from vault.secrets where name in ('FLUE_DATABASE_PASSWORD','OPENCODE_GO_API_KEY','WORKER_SECRET','TELEGRAM_WEBHOOK_SECRET','FINANCE_PROJECT_URL');
 end if;
end $$;
create or replace function public.finance_runtime_config() returns jsonb
language sql security invoker set search_path='' as $$
 select coalesce(jsonb_object_agg(name,decrypted_secret),'{}'::jsonb)
 from vault.decrypted_secrets
 where name in ('TELEGRAM_GROUP_ID','TELEGRAM_BOT_TOKEN','DEEPGRAM_API_KEY','FINANCE_EXECUTOR');
$$;
revoke all on function public.finance_runtime_config() from public,anon,authenticated;
grant execute on function public.finance_runtime_config() to service_role;
