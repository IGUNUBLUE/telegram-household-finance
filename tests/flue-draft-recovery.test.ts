import {test} from 'node:test';import assert from 'node:assert/strict';
import {fauxProvider,fauxAssistantMessage as answer,fauxToolCall as call} from '@earendil-works/pi-ai/providers/faux';
import {workerDatabase} from './fixtures/worker-database.ts';import {createFinancialFlue} from '../scripts/lib/flue-agent.ts';import {createFlueInterpretationServices} from '../scripts/lib/flue-interpretation.ts';import {financialTools} from '../supabase/functions/_shared/agent-tools.ts';
test('reclaimed Flue attempts recover draft identities even when item keys and fields change',async()=>{
 const f=await workerDatabase();let runtime:Awaited<ReturnType<typeof createFinancialFlue>>|undefined;
 try{
  await f.ingest({text:'Arroz 100 y leche 200'});let event=await f.rpc('queue:claim');
  const p=fauxProvider({provider:'draft-recovery',models:[{id:'fixture',contextWindow:32000,maxTokens:1800}],tokensPerSecond:100000});runtime=await createFinancialFlue({provider:p.provider,model:'draft-recovery/fixture',tools:financialTools});
  const services=createFlueInterpretationServices({runtime,rpc:f.rpc,today:()=> '2026-10-02',telegramFile:async()=>new ArrayBuffer(0)});
  const context=async()=>({...await f.rpc('context'),...await f.rpc('agent:context',{id:event.id}),actor:'101',event_id:event.id,event_attempt_token:event.turn_token});
  const items=(keys:string[],memo='Arroz')=>[{item_key:keys[0],fields:{kind:'expense',amount_cop:'100',memo}},{item_key:keys[1],fields:{kind:'expense',amount_cop:'200',memo:'Leche'}}];
  p.setResponses([answer(call('actualizar_asuntos',{items:items(['arroz','leche'])})),async()=>{throw Error('synthetic crash after commit');}]);
  await assert.rejects(services.interpret({text:'Arroz 100 y leche 200'},await context()));
  const before=(await f.rpc('agent:context',{id:event.id})).drafts;assert.equal(before.length,2);
  await f.db.query("update private.events set lease_until=now()-interval '1 second',turn_until=now()-interval '1 second' where id=$1",[event.id]);event=await f.rpc('queue:claim');
  p.setResponses([answer(call('actualizar_asuntos',{items:items(['item-1','item-2'],'almuerzo de ejemplo')})),answer('Conservé los pendientes existentes.')]);
  await services.interpret({text:'Arroz 100 y leche 200'},await context());
  const after=(await f.rpc('agent:context',{id:event.id})).drafts;assert.equal(after.length,2);assert.deepEqual(after.map((d:any)=>d.id).sort(),before.map((d:any)=>d.id).sort());assert.equal(after.find((d:any)=>d.fields.amount_cop==='100').fields.memo,'Arroz');
  assert.equal((await f.db.query<{n:number}>('select count(*)::int n from private.transactions')).rows[0].n,0);
  await assert.rejects(f.rpc('agent:draft_save',{id:event.id,_attempt_token:'stale',fields:{memo:'Must not change'}}),/attempt/i);
  // A subsequent real message may intentionally update the preserved draft.
  await f.rpc('queue:finish',{id:event.id,token:event.turn_token});await f.db.query("update private.events set state='done',lease_until=null where id=$1",[event.id]);await f.ingest({text:'Corrige almuerzo de ejemplo'});event=await f.rpc('queue:claim');
  const draft=after.find((d:any)=>d.fields.amount_cop==='100');const changed=await f.rpc('agent:draft_save',{id:event.id,_attempt_token:event.turn_token,draft_id:draft.id,revision:draft.revision,fields:{memo:'almuerzo de ejemplo'}});assert.equal(changed.draft.fields.memo,'almuerzo de ejemplo');
 }finally{await runtime?.close();await f.db.close();}
});
