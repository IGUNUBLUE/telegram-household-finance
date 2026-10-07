import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createWorkerEngine,type WorkerIO} from '../supabase/functions/_shared/worker-engine.ts';
import {workerDatabase} from './fixtures/worker-database.ts';
test('shared worker preserves cents, proposals, media routes and independent delivery',async()=>{
 const f=await workerDatabase();
 try{
  const routes:any[]=[];let calls=0;const seen:any[]=[];
  const io:WorkerIO={rpc:f.rpc,telegram:async(method,body)=>{routes.push({method,...body});return {message_id:42};},telegramDocument:async()=>({message_id:42}),transcribe:async()=> 'audio transcrito',model:'gpt-5.6-luna',interpret:async(input,context,onMetrics)=>{onMetrics?.({rounds:1,elapsed_ms:10,input_tokens:10,output_tokens:10,tools:[]});calls++;seen.push({input,context});return {type:'account',name:'Banco',kind:'asset',owner:'101',amount:'25013',date:'2026-10-02'};},narrate:async()=>'',today:()=> '2026-10-02',getConfig:()=>'-100123',canClaim:async()=>true,log:()=>{}};
  await f.ingest({voice:'voice-id',photo:'photo-id',messageId:17,threadId:8,isTopic:true});
  const engine=createWorkerEngine(io);
  assert.equal(await engine.processOne(),true);
  assert.equal((await f.db.query<any>('select model from private.agent_traces')).rows[0].model,'gpt-5.6-luna');
  assert.equal(calls,1);assert.match(seen[0].input.text,/audio transcrito/);assert.equal(seen[0].input.photo,'photo-id');assert.equal(seen[0].context.actor,'101');
  assert.ok(routes.some(r=>r.method==='sendChatAction'&&r.message_thread_id===8));
  const report=await f.rpc('report',{scope:'all'});assert.equal(report.balances.find((b:any)=>b.name==='Banco').balance,'25013');assert.equal(report.income,'0');
  const ev=(await f.db.query<any>('select id,action from private.events order by id desc limit 1')).rows[0];
  await f.rpc('agent:apply',{id:ev.id,action:ev.action});
  assert.equal((await f.db.query<any>('select count(*)::int n from private.transactions')).rows[0].n,1);
  const inactive=createWorkerEngine({...io,canClaim:async()=>false});
  assert.equal(await inactive.processOne(),false);await inactive.deliver();
  assert.ok(routes.some(r=>r.method==='sendMessage'&&r.reply_parameters.message_id===17));
  const next=await f.ingest({text:'continua'});
  const claimed=await f.rpc('queue:claim');assert.equal(claimed.id,next.id);
  await f.rpc('proposal',{id:next.id,action:{type:'clarify',question:'Propuesta guardada'}});
  await f.rpc('queue:finish',{id:claimed.id,token:claimed.turn_token});
  await f.db.query("update private.events set lease_until=now()-interval '1 second' where id=$1",[next.id]);
  await engine.processOne();assert.equal(calls,1);
 }finally{await f.db.close();}
});
test('post-commit narration outage inhibits the next claim and preserves the committed receipt',async()=>{
 const f=await workerDatabase();try{
  const seed=await f.ingest({text:'Cuenta ficticia y pendiente'});const lease=await f.rpc('queue:claim');
  await f.rpc('agent:draft_save',{id:seed.id,fields:{memo:'Otro asunto ficticio pendiente'}});
  const opening={type:'account',name:'Banco',kind:'asset',owner:'101',amount:'100000',date:'2026-10-02'};await f.rpc('proposal',{id:seed.id,action:opening});await f.rpc('agent:apply',{id:seed.id,action:opening});await f.rpc('queue:finish',{id:seed.id,token:lease.turn_token});
  const first=await f.ingest({text:'Primer gasto ficticio'}),second=await f.ingest({text:'Segundo gasto ficticio'});
  let blocked=false,interpretations=0;const logs:any[]=[];
  const io:WorkerIO={rpc:f.rpc,getConfig:()=>'-100123',canClaim:async()=>!blocked,onProviderUnavailable:()=>{blocked=true;},log:r=>logs.push(r),today:()=> '2026-10-02',transcribe:async()=>'',narrate:async()=>{throw Error('fictional quota token');},telegramDocument:async()=>({message_id:43}),telegram:async()=>({message_id:43}),interpret:async(_input,context)=>{interpretations++;context.turn_focus.draft_ids.push(context.drafts[0].id);return {type:'post',kind:'expense',account:'Banco',amount:'100',date:'2026-10-02',scope:'personal',payer:'101',category:'Prueba',memo:'Primer gasto ficticio'};}};
  const result=await createWorkerEngine(io).runBatch();assert.equal(result.processed,1);assert.equal(interpretations,1);assert.equal(blocked,true);
  const events=(await f.db.query<any>('select id,state,result from private.events where id in ($1,$2) order by id',[first.id,second.id])).rows;
  assert.equal(events[0].state,'done');assert.ok(events[0].result.receipt);assert.equal(events[1].state,'new');
  assert.equal((await f.db.query<any>('select count(*)::int n from private.transactions')).rows[0].n,2);
  assert.ok((await f.db.query<any>('select sent_at from private.outbox where event_id=$1',[first.id])).rows[0].sent_at);assert.doesNotMatch(JSON.stringify(logs),/fictional quota token/);
 }finally{await f.db.close();}
});
test('post-commit delivery interruption recovers without applying another transaction',async()=>{
 const f=await workerDatabase();let attempts=0,interpretations=0;try{
  await f.ingest({text:'crear cuenta ficticia'});
  const io:WorkerIO={rpc:f.rpc,getConfig:()=>'-100123',canClaim:async()=>true,log:()=>{},today:()=> '2026-10-02',transcribe:async()=>'',narrate:async()=>'',telegramDocument:async()=>({message_id:43}),telegram:async(method)=>{if(method==='sendMessage'&&++attempts===1)throw Error('fictional-token secret error');return {message_id:43};},interpret:async()=>{interpretations++;return {type:'account',name:'Prueba',kind:'asset',owner:'101',amount:'25013',date:'2026-10-02'};}};
  const engine=createWorkerEngine(io);await engine.processOne();await engine.deliver();
  assert.equal((await f.db.query<any>('select state from private.events')).rows[0].state,'done');assert.equal((await f.db.query<any>('select sent_at from private.outbox')).rows[0].sent_at,null);
  await f.db.exec("update private.outbox set retry_at=now()-interval '1 second'");
  await createWorkerEngine({...io,canClaim:async()=>false}).deliver();
  assert.equal(interpretations,1);assert.equal(attempts,2);assert.equal((await f.db.query<any>('select count(*)::int n from private.transactions')).rows[0].n,1);assert.ok((await f.db.query<any>('select sent_at from private.outbox')).rows[0].sent_at);
 }finally{await f.db.close();}
});
