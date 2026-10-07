import {test,before,after} from 'node:test';import assert from 'node:assert/strict';
import {approvalDatabase} from './fixtures/approval-database.ts';
let f:Awaited<ReturnType<typeof approvalDatabase>>;
before(async()=>{f=await approvalDatabase();});after(async()=>f?.db.close());
test('request retries preserve one immutable approval and 48-hour expiry without financial writes',async()=>{
 const e=await f.event();const before=await f.snapshotLedger();const initial=await f.request(e),retry=await f.request(e);
 assert.equal(retry.id,initial.id);assert.equal(initial.state,'pending');assert.deepEqual(initial.required_members,['202']);
 assert.equal(Date.parse(initial.expires_at)-Date.parse(initial.created_at),48*60*60*1000);
 assert.deepEqual(await f.snapshotLedger(),before);assert.equal(initial.reporter,'101');
});
test('approval context derives actor from event and scopes requests to reporter and assigned member',async()=>{
 const source=await f.event();const r=await f.request(source),owner=await f.event('202');
 const a=await f.rpc('approval:context',{id:source.id,actor:'202'}),b=await f.rpc('approval:context',{id:owner.id,actor:'101'});
 assert.ok(a.sent.some((x:any)=>x.id===r.id));assert.equal(a.received.length,0);
 assert.ok(b.received.some((x:any)=>x.id===r.id));assert.equal(b.sent.length,0);
});
test('private eligibility accepts only an existing member own chat and never enrolls unknown identities',async()=>{
 await f.enable();assert.equal((await f.rpc('approval:private_member',{actor:'202',chat_id:'202',group:'-100123'})).allowed,true);
 for(const data of [{actor:'999',chat_id:'999',group:'-100123'},{actor:'202',chat_id:'101',group:'-100123'},{actor:'202',chat_id:'202',group:'-999'}])assert.equal((await f.rpc('approval:private_member',data)).allowed,false);
 assert.equal((await f.db.query<any>('select count(*)::int n from private.members')).rows[0].n,2);
 await f.enable(false);assert.equal((await f.rpc('approval:private_member',{actor:'202',chat_id:'202',group:'-100123'})).allowed,false);
});
test('rejected approval does not revive or renew its notification budget when requested again',async()=>{
 const e=await f.event(),r=await f.request(e);
 await f.db.query("update private.approval_requests set state='rejected' where id=$1",[r.id]);
 const retry=await f.request(e);assert.equal(retry.id,r.id);assert.equal(retry.state,'rejected');assert.equal(retry.expires_at,r.expires_at);
 assert.equal((await f.db.query<any>('select count(*)::int n from private.approval_requests where id=$1',[r.id])).rows[0].n,1);
});
test('approval RPC and private tables are not accessible to anon or authenticated roles',async()=>{
 for(const role of ['anon','authenticated']){
  await f.db.exec('set role '+role);
  try{await assert.rejects(f.db.query("select public.finance_approval('context','{}')"),/permission denied/);await assert.rejects(f.db.query('select * from private.approval_requests'),/permission denied/);}
  finally{await f.db.exec('reset role');}
 }
});
