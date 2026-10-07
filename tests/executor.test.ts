import {test} from 'node:test';
import assert from 'node:assert/strict';
import {executorMode} from '../supabase/functions/_shared/executor.ts';
import {workerDatabase} from './fixtures/worker-database.ts';
test('executor defaults to Edge and rejects unknown modes',()=>{assert.equal(executorMode(),'edge');assert.equal(executorMode('vps_subscription'),'vps_subscription');assert.throws(()=>executorMode('unexpected'));});
test('stale executor overlap serializes actor claims and preserves application idempotency',async()=>{
 const f=await workerDatabase();try{
  const event=await f.ingest({text:'crear cuenta ficticia'});
  const claims=await Promise.all([f.rpc('queue:claim'),f.rpc('queue:claim')]);assert.equal(claims.filter(c=>c.id).length,1);
  const active=claims.find(c=>c.id);assert.equal(active.id,event.id);
  const action={type:'account',name:'Prueba',kind:'asset',owner:'101',amount:'25013',date:'2026-10-02'};
  await f.rpc('proposal',{id:event.id,action});await f.rpc('agent:apply',{id:event.id,action});await f.rpc('agent:apply',{id:event.id,action});
  assert.equal((await f.db.query<any>('select count(*)::int n from private.transactions')).rows[0].n,1);
  assert.deepEqual(await f.rpc('queue:outbox'),{});await f.rpc('queue:finish',{id:event.id,token:active.turn_token});
  const out=await f.rpc('queue:outbox');assert.ok(out.id);assert.equal((await f.rpc('queue:sent',{id:out.id,token:'stale-token'})).ok,false);assert.equal((await f.rpc('queue:sent',{id:out.id,token:out.token})).ok,true);
 }finally{await f.db.close();}
});
test('private selector and actual model trace are backend-only and bounded',async()=>{
 const f=await workerDatabase();try{
  await f.db.exec("insert into vault.decrypted_secrets values('FINANCE_EXECUTOR','vps_subscription'),('UNLISTED_KEY','fictional')");
  const cfg=(await f.db.query<any>('select public.finance_runtime_config() r')).rows[0].r;assert.equal(cfg.FINANCE_EXECUTOR,'vps_subscription');assert.equal(cfg.UNLISTED_KEY,undefined);
  const ev=await f.ingest({text:'consulta ficticia'});
  await f.db.query("select public.finance_worker_trace('trace',$1::jsonb)",[JSON.stringify({id:ev.id,model:'gpt-5.6-luna',rounds:1,tools:[{name:'consultar_cuenta',status:'ok',secret:'fictional-private'}],private:'fictional-private'})]);
  const trace=(await f.db.query<any>('select model,metrics from private.agent_traces')).rows[0];assert.equal(trace.model,'gpt-5.6-luna');assert.doesNotMatch(JSON.stringify(trace.metrics),/fictional-private/);
  for(const role of ['anon','authenticated']){await f.db.exec('set role '+role);try{await assert.rejects(f.db.query("select public.finance_worker_trace('trace','{}')"));await assert.rejects(f.db.query('select public.finance_runtime_config()'));}finally{await f.db.exec('reset role');}}
 }finally{await f.db.close();}
});
