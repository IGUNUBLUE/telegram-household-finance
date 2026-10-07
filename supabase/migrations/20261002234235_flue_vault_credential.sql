-- Vault create_secret has a fourth defaulted UUID argument in hosted Supabase.
DO $$
declare password_v text;
begin
 if to_regprocedure('vault.create_secret(text,text,text,uuid)') is not null then
  select decrypted_secret into password_v from vault.decrypted_secrets where name='FLUE_DATABASE_PASSWORD';
  if password_v is null then
   password_v:=replace(gen_random_uuid()::text,'-','')||replace(gen_random_uuid()::text,'-','');
   perform vault.create_secret(password_v,'FLUE_DATABASE_PASSWORD','Private Flue runtime role, financial ledger excluded',null);
  end if;
  execute format('alter role flue_finance_login password %L',password_v);
 end if;
end $$;
