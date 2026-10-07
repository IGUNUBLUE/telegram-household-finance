import {test} from 'node:test';import assert from 'node:assert/strict';
import {workerDatabase} from './fixtures/worker-database.ts';
import {createWorkerEngine,type WorkerIO} from '../supabase/functions/_shared/worker-engine.ts';
import {dispatchTool} from '../supabase/functions/_shared/agent-tools.ts';

async function fixture(){
 const f=await workerDatabase();
 const seed=await f.ingest({text:'Cuenta sintética'});await f.rpc('agent:apply',{id:seed.id,action:{type:'account',name:'Banco ficticio',kind:'asset',owner:'101',amount:'0',date:'2026-10-04'}});await f.db.exec('delete from private.outbox');
 let nextMessage=100;const messages=new Map<number,string>(),calls:{method:string;body:any}[]=[];
 const telegram:WorkerIO['telegram']=async(method,body)=>{calls.push({method,body});if(method==='sendMessage'){const id=nextMessage++;messages.set(id,String(body.text));return {message_id:id};}if(method==='editMessageText'){const id=Number(body.message_id);assert.ok(messages.has(id),'only bot messages can be edited');messages.set(id,String(body.text));return {message_id:id};}return {};};
 const io:WorkerIO={rpc:f.rpc,getConfig:()=>'-100123',canClaim:async()=>true,log:()=>{},today:()=> '2026-10-04',transcribe:async()=> 'familiar',narrate:async()=>'',telegram,telegramDocument:async()=>({message_id:900}),interpret:async()=>({type:'clarify',question:'Consulta ficticia'})};
 const expenseCount=async()=>Number((await f.db.query<any>("select count(*) n from private.transactions where kind='expense'")).rows[0].n);
 return {...f,io,calls,messages,expenseCount};
}
async function save(c:any,rpc:WorkerIO['rpc'],amount='51.27'){
 const r=await dispatchTool('actualizar_asuntos',{items:[{item_key:'expense',fields:{kind:'expense',amount_cop:amount,account:'Banco ficticio',payer:'101',date:'2026-10-04',memo:'Compra sintética'}}]},c,rpc);return r.result.drafts[0];
}
async function change(c:any,rpc:WorkerIO['rpc'],fields:any,register=false){
 const id=c.conversation.previous_draft_ids[0];const old=(await rpc('agent:draft_get',{id:c.event_id,draft_id:id})).draft;
 const r=await dispatchTool('actualizar_asuntos',{items:[{item_key:'expense',draft_id:id,revision:old.revision,fields}]},c,rpc);const d=r.result.drafts[0];
 return register?(await dispatchTool('registrar_movimiento',{draft_id:d.id,revision:d.revision},c,rpc)).action:{type:'clarify',question:'¿Personal o familiar? Importe actualizado.'};
}
function model(f:Awaited<ReturnType<typeof fixture>>,extra?:()=>Promise<void>):WorkerIO['interpret']{
 return async(input,c)=>{if(input.text==='start'){await save(c,f.rpc);await extra?.();return {type:'clarify',question:'¿Personal o familiar?'};}if(input.text==='finish'||input.text==='familiar')return change(c,f.rpc,{scope:'family'},true);if(input.text==='amount')return change(c,f.rpc,{amount_cop:'61.07'});return {type:'clarify',question:'Consulta independiente'};};
}

test('a continuation arriving during interpretation resolves the pending expense before its obsolete question is sent',async()=>{
 const f=await fixture();try{
  await f.ingest({text:'start',messageId:1});let interpretations=0;
  const worker=createWorkerEngine({...f.io,interpret:async(_input,c)=>{interpretations++;if(interpretations===1){await save(c,f.rpc);await f.ingest({text:'',voice:'synthetic-audio',messageId:2});return {type:'clarify',question:'¿Personal o familiar?'};}return change(c,f.rpc,{scope:'family'},true);}});
  await worker.runBatch();const sent=f.calls.filter(x=>x.method==='sendMessage');assert.equal(sent.length,1);assert.match(String(sent[0].body.text),/Gasto registrado/);assert.equal(await f.expenseCount(),1);
  const rows=(await f.db.query<any>('select sent_at,superseded_by from private.outbox order by id')).rows;assert.equal(rows[0].sent_at,null);assert.ok(rows[0].superseded_by);assert.ok(rows[1].sent_at);
 }finally{await f.db.close();}
});

test('a sent pending question is updated in place and its final receipt stays a new message',async()=>{
 const f=await fixture();try{
  const worker=createWorkerEngine({...f.io,interpret:async(input,c)=>{if(input.text==='start'){await save(c,f.rpc);return {type:'clarify',question:'¿Personal o familiar?'};}return change(c,f.rpc,input.text==='amount'?{amount_cop:'61.07'}:{scope:'family'},input.text==='finish');}});
  await f.ingest({text:'start',messageId:1});await worker.runBatch();assert.equal(f.messages.size,1);
  await f.ingest({text:'amount',messageId:2});await worker.runBatch();assert.equal(f.messages.size,1);assert.equal(f.calls.filter(x=>x.method==='editMessageText').length,1);assert.equal(await f.expenseCount(),0);
  await f.ingest({text:'finish',messageId:3});await worker.runBatch();assert.equal(f.messages.size,2);assert.match(f.messages.get(100)!,/resuelto/);assert.match(f.messages.get(101)!,/Gasto registrado/);assert.equal(await f.expenseCount(),1);
  const deltas=(await f.db.query<any>("select delta::text from private.entries e join private.transactions t on t.id=e.transaction_id where t.kind='expense' order by delta")).rows;assert.deepEqual(deltas,[{delta:'-6107'},{delta:'6107'}]);
 }finally{await f.db.close();}
});

test('a replacement edit survives a lost progress RPC without sending a duplicate question or rerunning interpretation',async()=>{
 const f=await fixture();try{
  const worker=createWorkerEngine({...f.io,interpret:model(f)});await f.ingest({text:'start',messageId:1});await worker.runBatch();await f.ingest({text:'amount',messageId:2});await worker.processOne();
  let outage=true;
  const recovering=createWorkerEngine({...f.io,interpret:async()=>{throw Error('must not reinterpret');},rpc:async(op,data={})=>{if(op==='queue:progress'&&outage){outage=false;throw Error('lost delivery progress');}return f.rpc(op,data);}});
  await recovering.deliver();await f.db.exec("update private.outbox set retry_at=now()-interval '1 second'");await recovering.deliver();
  assert.equal(f.messages.size,1);assert.equal(f.calls.filter(x=>x.method==='sendMessage').length,1);assert.equal(await f.expenseCount(),0);assert.ok((await f.db.query<any>('select sent_at from private.outbox order by id desc limit 1')).rows[0].sent_at);
 }finally{await f.db.close();}
});

for(const [name,payload] of [
 ['unrelated subject',{text:'another'}],['explicit reply to another conversation',{text:'another',replyTo:999}],['different Telegram topic',{text:'another',threadId:7}]
] as const)test('queued '+name+' preserves the original pending question',async()=>{
 const f=await fixture();try{
  const worker=createWorkerEngine({...f.io,interpret:model(f,async()=>{await f.ingest({...payload,messageId:2});})});await f.ingest({text:'start',messageId:1});await worker.runBatch();
  assert.equal(f.messages.size,2);assert.ok([...f.messages.values()].some(t=>t.includes('Personal o familiar')));assert.equal(await f.expenseCount(),0);
 }finally{await f.db.close();}
});

test('another actor neither delays nor replaces a pending question',async()=>{
 const f=await fixture();try{
  const worker=createWorkerEngine({...f.io,interpret:model(f,async()=>{await f.rpc('ingest',{update_id:500,actor:'202',name:'Otra persona',group:'-100123',payload:{actor:'202',text:'another',messageId:2}});})});
  await f.ingest({text:'start',messageId:1});await worker.processOne();await worker.deliver();assert.equal(f.messages.size,1);assert.ok([...f.messages.values()][0].includes('Personal o familiar'));
 }finally{await f.db.close();}
});

test('a waiting question is delivered if the continuation fails or exceeds the bounded hold',async()=>{
 const f=await fixture();try{
  let next=0;const worker=createWorkerEngine({...f.io,interpret:model(f,async()=>{next=(await f.ingest({text:'another',messageId:2})).id;})});
  await f.ingest({text:'start',messageId:1});await worker.processOne();await worker.deliver();assert.equal(f.messages.size,0);
  await f.db.exec("update private.outbox set created_at=now()-interval '46 seconds'");await worker.deliver();assert.equal(f.messages.size,1);
  assert.equal((await f.db.query<any>('select state from private.events where id=$1',[next])).rows[0].state,'new');
 }finally{await f.db.close();}
});

test('a failed continuation releases the original unanswered question',async()=>{
 const f=await fixture();try{
  let next=0;const worker=createWorkerEngine({...f.io,interpret:model(f,async()=>{next=(await f.ingest({text:'another',messageId:2})).id;})});
  await f.ingest({text:'start',messageId:1});await worker.processOne();await worker.deliver();assert.equal(f.messages.size,0);
  await f.db.query("update private.events set state='failed',turn_until=null where id=$1",[next]);await worker.deliver();assert.equal(f.messages.size,1);assert.equal(await f.expenseCount(),0);
 }finally{await f.db.close();}
});

test('two different drafts in the same conversation retain both questions',async()=>{
 const f=await fixture();try{
  let count=0;const worker=createWorkerEngine({...f.io,interpret:async(_input,c)=>{await save(c,f.rpc,count++===0?'51.27':'79.31');if(count===1)await f.ingest({text:'new subject',messageId:2});return {type:'clarify',question:'Datos del asunto '+count};}});
  await f.ingest({text:'start',messageId:1});await worker.runBatch();assert.equal(f.messages.size,2);assert.equal((await f.db.query<any>("select count(*)::int n from private.agent_drafts where state='pending'")).rows[0].n,2);assert.equal(f.calls.filter(x=>x.method==='editMessageText').length,0);
 }finally{await f.db.close();}
});

test('an arrival after claiming a question is checked again immediately before sending',async()=>{
 const f=await fixture();try{
  const worker=createWorkerEngine({...f.io,interpret:model(f)});await f.ingest({text:'start',messageId:1});await worker.processOne();let late=true;
  const rpc:WorkerIO['rpc']=async(op,data={})=>{const r=await f.rpc(op,data);if(op==='queue:outbox'&&r.id&&late){late=false;await f.ingest({text:'finish',messageId:2});}return r;};
  const current=createWorkerEngine({...f.io,rpc,interpret:model(f)});await current.deliver();assert.equal(f.messages.size,0);await current.runBatch();assert.equal(f.messages.size,1);assert.equal(await f.expenseCount(),1);
 }finally{await f.db.close();}
});

test('a newer completed continuation invalidates a claimed but unsent question',async()=>{
 const f=await fixture();try{
  const worker=createWorkerEngine({...f.io,interpret:model(f)});await f.ingest({text:'start',messageId:1});await worker.processOne();const old=await f.rpc('queue:outbox');
  await f.ingest({text:'finish',messageId:2});await worker.processOne();assert.equal((await f.rpc('queue:delivery_check',{id:old.id,token:old.token})).deliver,false);
  await worker.deliver();assert.equal(f.messages.size,1);assert.equal(await f.expenseCount(),1);
 }finally{await f.db.close();}
});

test('a failed edit followed by another update retains the original message target',async()=>{
 const f=await fixture();try{
  const worker=createWorkerEngine({...f.io,interpret:model(f)});await f.ingest({text:'start',messageId:1});await worker.runBatch();await f.ingest({text:'amount',messageId:2});await worker.processOne();
  const failed=createWorkerEngine({...f.io,telegram:async(method,body)=>{if(method==='editMessageText')throw Object.assign(Error('retry'),{editStatus:'unavailable'});return f.io.telegram(method,body);}});await failed.deliver();
  await f.ingest({text:'amount',messageId:3});await worker.processOne();await worker.deliver();assert.equal(f.messages.size,1);assert.match(f.messages.get(100)!,/actualizado/);assert.equal(await f.expenseCount(),0);
 }finally{await f.db.close();}
});

test('lease checks reject obsolete delivery and editing tokens',async()=>{
 const f=await fixture();try{
  const event=await f.ingest({text:'start',messageId:1});const lease=await f.rpc('queue:claim');await f.rpc('pro:conversation',{id:event.id,text:'start'});
  await f.rpc('agent:apply',{id:event.id,action:{type:'clarify',question:'Consulta'}});
  await f.rpc('queue:finish',{id:event.id,token:lease.turn_token});const delivery=await f.rpc('queue:outbox');assert.equal((await f.rpc('queue:delivery_check',{id:delivery.id,token:'obsolete'})).deliver,false);assert.equal((await f.rpc('queue:edit_done',{id:delivery.id,token:'obsolete'})).ok,false);
 }finally{await f.db.close();}
});

test('only one outstanding delivery for an actor can claim a message',async()=>{
 const f=await fixture();try{
  const worker=createWorkerEngine({...f.io,interpret:model(f)});await f.ingest({text:'start',messageId:1});await worker.processOne();await f.ingest({text:'another',messageId:2});await worker.processOne();
  const first=await f.rpc('queue:outbox');assert.ok(first.id);assert.equal((await f.rpc('queue:outbox')).id,undefined);
  await f.rpc('queue:sent',{id:first.id,token:first.token,telegram_message_id:999});assert.ok((await f.rpc('queue:outbox')).id);
 }finally{await f.db.close();}
});

test('a partially delivered multipart question is never suppressed or edited',async()=>{
 const f=await fixture();try{
  const worker=createWorkerEngine({...f.io,interpret:model(f)});await f.ingest({text:'start',messageId:1});await worker.processOne();
  await f.db.query("update private.outbox set message=$1,result=jsonb_set(result,'{message}',to_jsonb($1::text))",['Pregunta extensa '+ 'x'.repeat(6000)]);
  await f.io.telegram('sendMessage',{text:'Primera parte',message_id:100});
  const delivery=await f.rpc('queue:outbox');await f.rpc('queue:progress',{id:delivery.id,token:delivery.token,part:1,telegram_message_id:100});await f.rpc('queue:failed',{id:delivery.id,token:delivery.token});
  await f.ingest({text:'finish',messageId:2});await worker.processOne();await f.db.exec("update private.outbox set retry_at=now()-interval '1 second'");await worker.deliver();
  const old=(await f.db.query<any>('select superseded_by from private.outbox where id=$1',[delivery.id])).rows[0];assert.equal(old.superseded_by,null);assert.equal(f.calls.filter(x=>x.method==='editMessageText').length,0);assert.equal(await f.expenseCount(),1);
 }finally{await f.db.close();}
});

test('response subjects survive a post-commit metadata RPC outage',async()=>{
 const f=await fixture();try{
  const worker=createWorkerEngine({...f.io,interpret:model(f),rpc:async(op,data={})=>{if(op==='queue:response_metadata')throw Error('metadata RPC unavailable');return f.rpc(op,data);}});
  await f.ingest({text:'start',messageId:1});await worker.processOne();const row=(await f.db.query<any>('select response_subjects,response_session from private.outbox')).rows[0];assert.equal(row.response_subjects.length,1);assert.ok(row.response_session);
 }finally{await f.db.close();}
});

test('failure to persist response subjects rolls back the financial result and safely retries once',async()=>{
 const f=await fixture();try{
  const worker=createWorkerEngine({...f.io,interpret:model(f)});await f.ingest({text:'start',messageId:1});await worker.runBatch();const event=await f.ingest({text:'finish',messageId:2});
  await f.db.exec(`alter table private.outbox add constraint synthetic_metadata_outage check(event_id<>${event.id} or response_subjects is null) not valid`);
  await worker.processOne();assert.equal(await f.expenseCount(),0);assert.equal((await f.db.query<any>('select count(*)::int n from private.outbox where event_id=$1',[event.id])).rows[0].n,0);
  await f.db.exec('alter table private.outbox drop constraint synthetic_metadata_outage');await worker.processOne();await worker.deliver();assert.equal(await f.expenseCount(),1);
  assert.ok((await f.db.query<any>('select sent_at from private.outbox where event_id=$1',[event.id])).rows[0].sent_at);
 }finally{await f.db.close();}
});

test('lost edit progress acknowledgement reuses the edited message after a restart',async()=>{
 const f=await fixture();try{
  const worker=createWorkerEngine({...f.io,interpret:model(f)});await f.ingest({text:'start',messageId:1});await worker.runBatch();await f.ingest({text:'amount',messageId:2});await worker.processOne();let lose=true;
  const recovering=createWorkerEngine({...f.io,rpc:async(op,data={})=>{const r=await f.rpc(op,data);if(op==='queue:progress'&&lose){lose=false;throw Error('ack lost after commit');}return r;}});await recovering.deliver();await f.db.exec("update private.outbox set retry_at=now()-interval '1 second'");await recovering.deliver();assert.equal(f.messages.size,1);assert.equal(await f.expenseCount(),0);assert.equal(f.calls.filter(x=>x.method==='editMessageText').length,1);
 }finally{await f.db.close();}
});

test('replying to an updated pending message resolves its latest question and draft',async()=>{
 const f=await fixture();try{
  const worker=createWorkerEngine({...f.io,interpret:model(f)});await f.ingest({text:'start',messageId:1});await worker.runBatch();await f.ingest({text:'amount',messageId:2});await worker.runBatch();
  await f.ingest({text:'finish',messageId:3,replyTo:100});await worker.runBatch();assert.equal(await f.expenseCount(),1);assert.equal(f.messages.size,2);
  const latest=(await f.db.query<any>('select event_id from private.outbox where telegram_message_id=100 order by id desc limit 1')).rows[0];assert.ok(latest);
 }finally{await f.db.close();}
});

test('attempting to register an incomplete draft updates its question even without changing draft fields',async()=>{
 const f=await fixture();try{
  const worker=createWorkerEngine({...f.io,interpret:async(input,c)=>{if(input.text==='start'){await save(c,f.rpc);return {type:'clarify',question:'¿Personal o familiar?'};}const id=c.conversation.previous_draft_ids[0];const d=(await f.rpc('agent:draft_get',{id:c.event_id,draft_id:id})).draft;const result=await dispatchTool('registrar_movimiento',{draft_id:id,revision:d.revision},c,f.rpc);assert.equal(result.result.status,'needs_clarification');return {type:'clarify',question:'Para registrarlo falta indicar si fue personal o familiar.'};}});
  await f.ingest({text:'start',messageId:1});await worker.runBatch();await f.ingest({text:'register',messageId:2});await worker.runBatch();assert.equal(f.messages.size,1);assert.equal(await f.expenseCount(),0);assert.equal(f.calls.filter(x=>x.method==='editMessageText').length,1);
 }finally{await f.db.close();}
});

test('suppressed chains clear thinking for every original message after final delivery',async()=>{
 const f=await fixture();try{
  const worker=createWorkerEngine({...f.io,interpret:model(f)});await f.ingest({text:'start',messageId:1});await worker.processOne();await f.ingest({text:'amount',messageId:2});await worker.processOne();
  const intermediate=await f.rpc('queue:outbox');assert.ok(intermediate.id);await f.rpc('queue:failed',{id:intermediate.id,token:intermediate.token});
  await f.ingest({text:'finish',messageId:3});await worker.processOne();await worker.deliver();
  for(const id of [1,2])assert.ok(f.calls.some(x=>x.method==='setMessageReaction'&&x.body.message_id===id&&x.body.reaction.length===0),'clear suppressed message '+id);
 }finally{await f.db.close();}
});

test('forged foreign response subjects cannot be committed through the financial executor',async()=>{
 const f=await fixture();try{
  const other=await f.rpc('ingest',{update_id:500,actor:'202',name:'Otra persona',group:'-100123',payload:{actor:'202',text:'otro'}});const d=(await f.rpc('agent:draft_save',{id:other.id,fields:{memo:'Privado'}})).draft;
  const ev=await f.ingest({text:'own'});await assert.rejects(f.rpc('agent:apply',{id:ev.id,action:{type:'clarify',question:'No debe guardarse',_response_draft_ids:[d.id]}}),/foreign/);assert.equal((await f.db.query<any>('select count(*)::int n from private.outbox')).rows[0].n,0);
 }finally{await f.db.close();}
});

test('a newer applied result with an active turn lease still holds the older question',async()=>{
 const f=await fixture();try{
  const worker=createWorkerEngine({...f.io,interpret:model(f)});await f.ingest({text:'start',messageId:1});await worker.processOne();await f.ingest({text:'finish',messageId:2});let held=false;
  await createWorkerEngine({...f.io,interpret:model(f),rpc:async(op,data={})=>{const r=await f.rpc(op,data);if(op==='agent:apply')held=!(await f.rpc('queue:outbox')).id;return r;}}).processOne();assert.equal(held,true);assert.equal(await f.expenseCount(),1);
 }finally{await f.db.close();}
});

test('a crash after apply does not prevent supersession once its turn lease expires',async()=>{
 const f=await fixture();try{
  const worker=createWorkerEngine({...f.io,interpret:model(f)});await f.ingest({text:'start',messageId:1});await worker.processOne();const newer=await f.ingest({text:'finish',messageId:2});await worker.processOne();
  await f.db.query("update private.events set turn_until=now()-interval '1 second',turn_token='crashed' where id=$1",[newer.id]);await worker.deliver();assert.equal(f.messages.size,1);assert.match([...f.messages.values()][0],/Gasto registrado/);assert.equal(await f.expenseCount(),1);
 }finally{await f.db.close();}
});

test('scheduled reminders without a user event keep their independent delivery',async()=>{
 const f=await fixture();try{
  await f.db.query('insert into private.outbox(message,result) values($1,$2::jsonb)',['Recordatorio sintético',JSON.stringify({status:'reminder',message:'Recordatorio sintético'})]);
  await createWorkerEngine(f.io).deliver();assert.equal(f.messages.size,1);assert.ok((await f.db.query<any>('select sent_at from private.outbox')).rows[0].sent_at);
 }finally{await f.db.close();}
});

test('older pending responses cannot overwrite the latest revision after repeated follow-ups',async()=>{
 const f=await fixture();try{
  const worker=createWorkerEngine({...f.io,interpret:model(f)});await f.ingest({text:'start',messageId:1});await worker.runBatch();await f.ingest({text:'amount',messageId:2});await worker.processOne();await f.ingest({text:'amount',messageId:3});await worker.processOne();await worker.deliver();
  assert.equal(f.messages.size,1);assert.equal(f.calls.filter(x=>x.method==='editMessageText').length,1);const rows=(await f.db.query<any>('select id,superseded_by,sent_at from private.outbox order by id')).rows;assert.equal(rows[1].superseded_by,rows[2].id);assert.ok(rows[2].sent_at);assert.equal(await f.expenseCount(),0);
 }finally{await f.db.close();}
});

for(const status of ['uneditable','unchanged','unavailable'] as const)test('edit '+status+' has a safe delivery recovery',async()=>{
 const f=await fixture();try{
  const worker=createWorkerEngine({...f.io,interpret:model(f)});await f.ingest({text:'start',messageId:1});await worker.runBatch();await f.ingest({text:'amount',messageId:2});await worker.processOne();
  let failed=false;const recovery=createWorkerEngine({...f.io,telegram:async(method,body)=>{if(method==='editMessageText'&&!failed){failed=true;throw Object.assign(Error('sanitized edit failure'),{editStatus:status});}return f.io.telegram(method,body);}});
  await recovery.deliver();if(status==='unavailable'){assert.equal(f.messages.size,1);await f.db.exec("update private.outbox set retry_at=now()-interval '1 second'");await recovery.deliver();}
  assert.equal(f.messages.size,status==='uneditable'?2:1);assert.equal(await f.expenseCount(),0);assert.ok((await f.db.query<any>('select sent_at from private.outbox order by id desc limit 1')).rows[0].sent_at);
 }finally{await f.db.close();}
});

test('a final receipt never edits a previously committed financial receipt',async()=>{
 const f=await fixture();try{
  const worker=createWorkerEngine({...f.io,interpret:model(f)});await f.ingest({text:'start',messageId:1});await worker.runBatch();await f.ingest({text:'finish',messageId:2});await worker.runBatch();
  const count=f.calls.filter(x=>x.method==='editMessageText').length;
  await f.ingest({text:'another',messageId:3});await worker.runBatch();assert.equal(f.calls.filter(x=>x.method==='editMessageText').length,count);assert.equal(await f.expenseCount(),1);assert.match(f.messages.get(101)!,/Gasto registrado/);
 }finally{await f.db.close();}
});
