import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import {workerDatabase} from './fixtures/worker-database.ts';
const migration=()=>{
 const name=readdirSync('supabase/migrations').find(n=>n.endsWith('_flue_sqlite_cleanup.sql'));
 assert.ok(name,'SQLite cutover needs a cleanup migration');return readFileSync('supabase/migrations/'+name,'utf8');
};
test('SQLite cleanup removes only obsolete runtime state and secrets while preserving ledger and active configuration',async()=>{
 const f=await workerDatabase({skipSqliteCleanup:true});
 try{
  await f.db.exec(`create schema flue_sqlite_simulation authorization flue_finance_login;
   create table flue_finance.flue_agent_submissions(status text);
   insert into flue_finance.flue_agent_submissions values('settled');
   create table vault.secrets(name text,secret text);
   insert into vault.secrets values ('FLUE_DATABASE_PASSWORD','obsolete'),('OPENCODE_GO_API_KEY','obsolete'),('WORKER_SECRET','obsolete'),('TELEGRAM_WEBHOOK_SECRET','obsolete'),('FINANCE_PROJECT_URL','obsolete'),('TELEGRAM_BOT_TOKEN','active'),('DEEPGRAM_API_KEY','active');
   insert into vault.decrypted_secrets values ('TELEGRAM_BOT_TOKEN','active'),('TELEGRAM_GROUP_ID','-100123'),('DEEPGRAM_API_KEY','active'),('FINANCE_EXECUTOR','vps_subscription'),('FLUE_DATABASE_PASSWORD','obsolete');`);
  const event=await f.ingest({text:'synthetic ledger fixture'});
  await f.rpc('apply',{id:event.id,action:{type:'account',name:'Fixture',kind:'asset',owner:'101',amount:'25013',date:'2026-10-02'}});
  const before=(await f.db.query('select * from private.transactions order by id')).rows;
  await f.db.exec(migration());
  assert.deepEqual((await f.db.query('select * from private.transactions order by id')).rows,before);
  assert.equal((await f.db.query<any>("select count(*)::int n from pg_namespace where nspname in ('flue_finance','flue_sqlite_simulation')")).rows[0].n,0);
  assert.equal((await f.db.query<any>("select count(*)::int n from pg_roles where rolname='flue_finance_login'")).rows[0].n,0);
  assert.deepEqual((await f.db.query<any>('select name from vault.secrets order by name')).rows.map(r=>r.name),['DEEPGRAM_API_KEY','TELEGRAM_BOT_TOKEN']);
  assert.deepEqual((await f.db.query<any>('select public.finance_runtime_config() r')).rows[0].r,{TELEGRAM_BOT_TOKEN:'active',TELEGRAM_GROUP_ID:'-100123',DEEPGRAM_API_KEY:'active',FINANCE_EXECUTOR:'vps_subscription'});
  await f.db.exec('set role anon');await assert.rejects(f.db.query('select public.finance_runtime_config()'));await f.db.exec('reset role');
 }finally{await f.db.close();}
});
test('cleanup aborts rather than destroy unfinished work or unexpected objects',async()=>{
 const f=await workerDatabase({skipSqliteCleanup:true});
 try{
  await f.db.exec("create table flue_finance.flue_agent_submissions(status text); insert into flue_finance.flue_agent_submissions values('running')");
  await assert.rejects(f.db.exec(migration()),/unfinished work/i);
  assert.equal((await f.db.query<any>('select status from flue_finance.flue_agent_submissions')).rows[0].status,'running');
  await f.db.exec("update flue_finance.flue_agent_submissions set status='settled'; create table flue_finance.unexpected_fixture(id int)");
  await assert.rejects(f.db.exec(migration()),/unexpected object/i);
  assert.equal((await f.db.query<any>("select to_regclass('flue_finance.unexpected_fixture') present")).rows[0].present,'flue_finance.unexpected_fixture');
 }finally{await f.db.close();}
});
