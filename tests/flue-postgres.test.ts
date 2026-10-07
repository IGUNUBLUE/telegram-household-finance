import {test} from 'node:test';import assert from 'node:assert/strict';
import {createPostgresRunner,fluePoolOptions} from '../scripts/lib/flue-postgres.ts';
test('Flue transactions retain a single client and roll back failed operations',async()=>{
 const calls:string[]=[];let releases=0,poolQueries=0;
 const client={query:async(sql:string)=>{calls.push(sql);return {rows:[{sql}]};},release:()=>{releases++;}};
 const runner=createPostgresRunner({query:async()=>{poolQueries++;return {rows:[]};},connect:async()=>client,end:async()=>{}} as any);
 assert.equal((await runner.transaction(async tx=>(await tx.query('select 1'))[0])).sql,'select 1');
 await assert.rejects(runner.transaction(async tx=>{await tx.query('select 2');throw Error('synthetic');}));
 assert.deepEqual(calls,['BEGIN','select 1','COMMIT','BEGIN','select 2','ROLLBACK']);assert.equal(releases,2);assert.equal(poolQueries,0);
});
test('private Flue pool verifies TLS, scopes tables to its schema and bounds connection use',()=>{
 const options=fluePoolOptions('https://syntheticproject.supabase.co','synthetic-password');
 assert.equal(options.host,'db.syntheticproject.supabase.co');assert.equal(options.user,'flue_finance_login');assert.match((options.ssl as any).ca,/BEGIN CERTIFICATE/);assert.equal(options.options,'-c search_path=flue_finance');assert.equal(options.max,3);assert.equal((options.ssl as any).rejectUnauthorized,true);
 assert.throws(()=>fluePoolOptions('https://other.invalid','x'));assert.throws(()=>fluePoolOptions('https://syntheticproject.supabase.co',''));
});
