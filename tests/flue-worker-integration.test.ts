import {test} from 'node:test';import assert from 'node:assert/strict';
import {fauxProvider,fauxAssistantMessage as answer,fauxToolCall as call} from '@earendil-works/pi-ai/providers/faux';
import {createFinancialFlue} from '../scripts/lib/flue-agent.ts';
import {createFlueInterpretationServices} from '../scripts/lib/flue-interpretation.ts';
import {financialTools} from '../supabase/functions/_shared/agent-tools.ts';
import {createWorkerEngine,type WorkerIO} from '../supabase/functions/_shared/worker-engine.ts';
import {workerDatabase} from './fixtures/worker-database.ts';
test('real Flue tools preserve the SQL ledger, audio/photo flow, reply, reactions and delivery recovery',async()=>{
 const f=await workerDatabase();const model=fauxProvider({provider:'integration',models:[{id:'fixture',contextWindow:32000,maxTokens:1800}],tokensPerSecond:100000});
 const runtime=await createFinancialFlue({provider:model.provider,model:'integration/fixture',tools:financialTools});
 try{
  const seed=await f.ingest({text:'apertura sintética'});const lease=await f.rpc('queue:claim');const opening={type:'account',name:'Banco',kind:'asset',owner:'101',amount:'25013',date:'2026-10-02'};
  await f.rpc('proposal',{id:seed.id,action:opening});await f.rpc('agent:apply',{id:seed.id,action:opening});await f.rpc('queue:finish',{id:seed.id,token:lease.turn_token});await f.db.exec('delete from private.outbox');
  let transcriptions=0,images=0,sends=0;const routes:any[]=[],logs:any[]=[];
  const services=createFlueInterpretationServices({runtime,rpc:f.rpc,today:()=> '2026-10-02',telegramFile:async()=>{images++;return new Uint8Array([255,216,255,217]).buffer;}});
  const io:WorkerIO={...services,rpc:f.rpc,today:()=> '2026-10-02',getConfig:()=> '-100123',model:'gpt-5.6-luna',canClaim:async()=>true,log:r=>logs.push(r),transcribe:async()=>{transcriptions++;return 'Pagué 250,13 de arroz desde Banco, personal, hoy';},telegramDocument:async()=>({message_id:43}),telegram:async(method,body)=>{routes.push({method,...body});if(method==='sendMessage'&&++sends===1)throw Error('synthetic delivery failure');return {message_id:43};}};
  model.setResponses([answer(call('actualizar_borrador',{fields:{kind:'expense',amount_cop:'250.13',account:'Banco',payer:'101',date:'2026-10-02',category:'Comida',scope:'personal',memo:'Arroz'}})),async()=>{const d=(await f.db.query<any>('select id,revision from private.agent_drafts order by id desc limit 1')).rows[0];return answer(call('registrar_movimiento',{draft_id:String(d.id),revision:d.revision}));}]);
  const ev=await f.ingest({voice:'synthetic-voice',photo:'synthetic-photo',messageId:17,threadId:8,isTopic:true});
  const engine=createWorkerEngine(io);await engine.processOne();await engine.deliver();
  assert.deepEqual(logs,[]);assert.equal(transcriptions,1);assert.equal(images,1);
  const report=await f.rpc('report',{from:'2026-10-01',to:'2026-10-31',scope:'all'});assert.equal(report.balances.find((b:any)=>b.name==='Banco').balance,'0');assert.equal(report.expense,'25013');
  assert.equal((await f.db.query<any>('select count(*)::int n from private.transactions')).rows[0].n,2);
  assert.equal((await f.db.query<any>('select state from private.events where id=$1',[ev.id])).rows[0].state,'done');
  assert.ok(routes.some(r=>r.method==='sendChatAction'&&r.message_thread_id===8));assert.ok(routes.some(r=>r.method==='setMessageReaction'&&r.reaction[0]?.emoji==='🤔'));
  await f.db.exec("update private.outbox set retry_at=now()-interval '1 second'");await createWorkerEngine({...io,canClaim:async()=>false}).deliver();
  assert.equal(sends,2);assert.ok(routes.some(r=>r.method==='sendMessage'&&r.reply_parameters.message_id===17&&r.parse_mode==='MarkdownV2'));assert.ok(routes.some(r=>r.method==='setMessageReaction'&&r.reaction[0]?.emoji==='👌'));
  assert.equal((await f.db.query<any>('select count(*)::int n from private.transactions')).rows[0].n,2);
 }finally{await runtime.close();await f.db.close();}
});
