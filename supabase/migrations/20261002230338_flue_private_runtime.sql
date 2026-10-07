-- Isolated runtime persistence. This role cannot access the financial ledger.
create role flue_finance_login login noinherit nosuperuser nocreatedb nocreaterole noreplication connection limit 4;
grant flue_finance_login to postgres;
create schema flue_finance authorization flue_finance_login;
revoke all on schema flue_finance from public,anon,authenticated,service_role;
alter role flue_finance_login set search_path=flue_finance;
alter role flue_finance_login set statement_timeout='20s';
alter role flue_finance_login set idle_in_transaction_session_timeout='20s';
DO $$
declare password_v text;
begin
 -- Test databases need no live credential; production Vault owns the generated secret.
 if to_regprocedure('vault.create_secret(text,text,text)') is not null then
  password_v:=replace(gen_random_uuid()::text,'-','')||replace(gen_random_uuid()::text,'-','');
  execute format('alter role flue_finance_login password %L',password_v);
  perform vault.create_secret(password_v,'FLUE_DATABASE_PASSWORD','Private Flue runtime role, financial ledger excluded');
 end if;
end $$;
create or replace function public.finance_runtime_config() returns jsonb
language sql security invoker set search_path='' as $$
 select coalesce(jsonb_object_agg(name,decrypted_secret),'{}'::jsonb)
 from vault.decrypted_secrets
 where name in ('TELEGRAM_GROUP_ID','TELEGRAM_BOT_TOKEN','OPENCODE_GO_API_KEY','TELEGRAM_WEBHOOK_SECRET','WORKER_SECRET','DEEPGRAM_API_KEY','FINANCE_EXECUTOR','FLUE_DATABASE_PASSWORD');
$$;
revoke all on function public.finance_runtime_config() from public,anon,authenticated;
grant execute on function public.finance_runtime_config() to service_role;
