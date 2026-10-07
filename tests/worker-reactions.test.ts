import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createWorkerEngine,type WorkerIO} from '../supabase/functions/_shared/worker-engine.ts';
import {workerDatabase} from './fixtures/worker-database.ts';
test('Successful callback cannot become a reaction target after apply clears its payload',async()=>{
 const f=await workerDatabase();try{
  const event=await f.ingest({callback:'pconfirm:1',messageId:95});const lease=await f.rpc('queue:claim');
  const action={type:'account',name:'Banco',kind:'asset',owner:'101',amount:'25013',date:'2026-10-02'};
  await f.rpc('proposal',{id:event.id,action});await f.rpc('agent:apply',{id:event.id,action});await f.rpc('queue:finish',{id:event.id,token:lease.turn_token});
  assert.deepEqual((await f.db.query<any>('select payload from private.events where id=$1',[event.id])).rows[0].payload,{});
  const item=await f.rpc('queue:outbox');assert.equal(item.reactionMessageId,null);
 }finally{await f.db.close();}
});
test('Successful detail button stays reaction-free across separate processing and delivery engines',async()=>{
 const f=await workerDatabase();try{
  const event=await f.ingest({text:'Cuenta ficticia'});const lease=await f.rpc('queue:claim');const action={type:'account',name:'Banco',kind:'asset',owner:'101',amount:'25013',date:'2026-10-02'};
  await f.rpc('proposal',{id:event.id,action});const result=await f.rpc('agent:apply',{id:event.id,action});await f.rpc('queue:finish',{id:event.id,token:lease.turn_token});await f.db.exec('update private.outbox set sent_at=now()');
  const reactions:any[]=[];const io:WorkerIO={rpc:f.rpc,getConfig:()=>'-100123',canClaim:async()=>true,log:()=>{},today:()=> '2026-10-02',transcribe:async()=>'',narrate:async()=>'',telegramDocument:async()=>({message_id:99}),telegram:async(method,body)=>{if(method==='setMessageReaction')reactions.push(body);return {message_id:99};},interpret:async()=>{throw Error('Detail must not invoke model');}};
  const detail=await f.ingest({callback:'detail:'+result.transaction_id,messageId:96});await createWorkerEngine(io).processOne();await createWorkerEngine({...io,canClaim:async()=>false}).deliver();
  assert.deepEqual(reactions,[]);assert.ok((await f.db.query<any>('select sent_at from private.outbox where event_id=$1',[detail.id])).rows[0].sent_at);
 }finally{await f.db.close();}
});
test('Reaction starts before media/model work and confirms only after successful durable delivery',async()=>{
 const f=await workerDatabase();try{
  const seed=await f.ingest({text:'Cuenta ficticia'});const lease=await f.rpc('queue:claim');const a={type:'account',name:'Banco',kind:'asset',owner:'101',amount:'25013',date:'2026-10-02'};
  await f.rpc('proposal',{id:seed.id,action:a});await f.rpc('agent:apply',{id:seed.id,action:a});await f.rpc('queue:finish',{id:seed.id,token:lease.turn_token});await f.db.exec('update private.outbox set sent_at=now()');
  const order:any[]=[];let interpretations=0,failDelivery=true;
  const io:WorkerIO={rpc:f.rpc,getConfig:()=>'-100123',canClaim:async()=>true,log:()=>{},today:()=> '2026-10-02',transcribe:async()=>{order.push('audio');return 'Gasto ficticio';},narrate:async()=>'',telegramDocument:async()=>({message_id:99}),telegram:async(method,body)=>{if(method==='setMessageReaction'){order.push(body.reaction);return true;}if(method==='sendMessage'){order.push('reply');if(failDelivery)throw Error('Temporary delivery error');}return {message_id:99};},interpret:async()=>{order.push('model');interpretations++;return {type:'post',kind:'expense',account:'Banco',amount:'100',date:'2026-10-02',scope:'personal',payer:'101',category:'Prueba',memo:'Gasto ficticio'};}};
  const event=await f.ingest({voice:'audio-id',photo:'photo-id',messageId:91});const engine=createWorkerEngine(io);await engine.processOne();
  assert.deepEqual(order.slice(0,3),[[{type:'emoji',emoji:'🤔'}],'audio','model']);assert.equal((await f.db.query<any>('select count(*)::int n from private.transactions')).rows[0].n,2);
  await engine.deliver();assert.deepEqual(order.at(-1),[]);assert.equal((await f.db.query<any>('select sent_at from private.outbox where event_id=$1',[event.id])).rows[0].sent_at,null);
  failDelivery=false;await f.db.exec("update private.outbox set retry_at=now()-interval '1 second'");const before=order.length;
  await createWorkerEngine({...io,canClaim:async()=>false}).deliver();assert.deepEqual(order.slice(before),['reply',[{type:'emoji',emoji:'👌'}]]);assert.equal(interpretations,1);assert.ok((await f.db.query<any>('select sent_at from private.outbox where event_id=$1',[event.id])).rows[0].sent_at);
 }finally{await f.db.close();}
});
test('Clarification clears thinking, reaction rejection does not fail the event, and callbacks have no target',async()=>{
 const f=await workerDatabase();try{
  const reactions:any[]=[];let failReactions=true;
  const io:WorkerIO={rpc:f.rpc,getConfig:()=>'-100123',canClaim:async()=>true,log:()=>{},today:()=> '2026-10-02',transcribe:async()=>'',narrate:async()=>'',telegramDocument:async()=>({message_id:99}),telegram:async(method,body)=>{if(method==='setMessageReaction'){reactions.push(body);if(failReactions)throw Error('Reactions disabled');return true;}return {message_id:99};},interpret:async()=>({type:'clarify',question:'¿De qué cuenta?'})};
  await f.ingest({messageId:92});await createWorkerEngine(io).runBatch();assert.deepEqual(reactions.map(x=>x.reaction),[[{type:'emoji',emoji:'🤔'}],[]]);assert.equal((await f.db.query<any>('select state from private.events')).rows[0].state,'pending');assert.ok((await f.db.query<any>('select sent_at from private.outbox')).rows[0].sent_at);
  failReactions=false;reactions.length=0;await f.ingest({callback:'confirm:999',messageId:93});await createWorkerEngine(io).runBatch();assert.deepEqual(reactions,[]);
 }finally{await f.db.close();}
});
test('Model failure clears thinking and never produces a financial success reaction',async()=>{
 const f=await workerDatabase();try{
  const reactions:any[]=[];const io:WorkerIO={rpc:f.rpc,getConfig:()=>'-100123',canClaim:async()=>true,log:()=>{},today:()=> '2026-10-02',transcribe:async()=>'',narrate:async()=>'',telegramDocument:async()=>({message_id:99}),telegram:async(method,body)=>{if(method==='setMessageReaction')reactions.push(body.reaction);return {message_id:99};},interpret:async()=>{throw Error('Provider unavailable');}};
  await f.ingest({messageId:94});await createWorkerEngine(io).runBatch();assert.deepEqual(reactions[0],[{type:'emoji',emoji:'🤔'}]);assert.deepEqual(reactions[1],[]);assert.ok(reactions.every(r=>!r.some((x:any)=>x.emoji==='👌')));assert.equal((await f.db.query<any>('select count(*)::int n from private.transactions')).rows[0].n,0);
 }finally{await f.db.close();}
});
