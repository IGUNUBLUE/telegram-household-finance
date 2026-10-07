import {test} from 'node:test';import assert from 'node:assert/strict';
import {workerDatabase} from './fixtures/worker-database.ts';
test('Flue private database role has runtime storage access and cannot read financial data or secrets',async()=>{
 const {db}=await workerDatabase({skipSqliteCleanup:true});
 try{
  await db.exec('set role flue_finance_login; set search_path=flue_finance; create table runtime_permission_probe(id integer); insert into runtime_permission_probe values(1);');
  assert.equal((await db.query<{n:number}>('select count(*)::int n from runtime_permission_probe')).rows[0].n,1);
  await assert.rejects(db.query('select * from private.transactions'),/permission denied/);
  await assert.rejects(db.query('select public.finance_runtime_config()'),/permission denied/);
  await assert.rejects(db.query('select * from vault.decrypted_secrets'),/permission denied/);
  await db.exec('reset role; set role anon');await assert.rejects(db.query('select * from flue_finance.runtime_permission_probe'),/permission denied/);
 }finally{await db.close();}
});
test('the actual four-argument Vault signature provisions the private runtime secret',async()=>{
 const {db}=await workerDatabase({vaultFunction:true,skipSqliteCleanup:true});try{
  const r=(await db.query<{present:boolean}>("select exists(select 1 from vault.decrypted_secrets where name='FLUE_DATABASE_PASSWORD' and length(decrypted_secret)>=64) present")).rows[0];assert.equal(r.present,true);
 }finally{await db.close();}
});
