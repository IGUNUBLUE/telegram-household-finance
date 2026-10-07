-- Hosted Supabase extensions: integration verified on the deployed project.
create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;
select cron.schedule('finance-memory','* * * * *',$job$
 select net.http_post(
  url:=(select decrypted_secret from vault.decrypted_secrets where name='FINANCE_PROJECT_URL')||'/functions/v1/memory',
  headers:=jsonb_build_object('Content-Type','application/json','Authorization','Bearer '||(select decrypted_secret from vault.decrypted_secrets where name='WORKER_SECRET')),
  body:='{"action":"index"}'::jsonb,timeout_milliseconds:=120000
 );
$job$);
