import {test,before,after} from 'node:test';import assert from 'node:assert/strict';
import {approvalDatabase} from './fixtures/approval-database.ts';
let f:Awaited<ReturnType<typeof approvalDatabase>>,amount=21019;
before(async()=>{f=await approvalDatabase();await f.enable();});after(async()=>f?.db.close());
async function pending(){const e=await f.event(),action={type:'post',kind:'expense',account:'Cuenta Dos',amount:String(amount++),payer:'101',scope:'family',category:'Compras',memo:'Compra prueba',date:'2026-10-05'};const r=await f.rpc('agent:apply',{id:e.id,action});return {e,action,request:(await f.db.query<any>('select private.finance_approval_json($1) r',[r.request_id])).rows[0].r};}
async function decide(r:any,actor='202',decision='confirm',route:any={}){const e=await f.event(actor,'',{callback:(decision==='confirm'?'aconfirm:':'areject:')+r.id+':'+r.revision,...route});return f.rpc('approval:resolve',{id:e.id,request_id:r.id,revision:r.revision,decision});}
test('assigned owner confirmation posts once preserving reporter and exact cents',async()=>{
 const {action,request:r}=await pending();const result=await decide(r);assert.equal(result.status,'ok');
 const row=(await f.db.query<any>('select actor,payer from private.transactions where id=$1',[result.transaction_id])).rows[0];assert.deepEqual(row,{actor:'101',payer:'101'});
 assert.equal(result.receipt.amount,action.amount);const decisions=(await f.db.query<any>('select member_id,decision from private.approval_decisions where request_id=$1',[r.id])).rows;assert.deepEqual(decisions,[{member_id:'202',decision:'confirm'}]);
 const before=await f.snapshotLedger();await decide(r);assert.deepEqual(await f.snapshotLedger(),before);assert.equal((await f.db.query<any>('select state from private.approval_requests where id=$1',[r.id])).rows[0].state,'posted');
});
test('reporter and forged affirmative text cannot substitute for owner confirmation',async()=>{
 const {request:r}=await pending(),before=await f.snapshotLedger();const wrong=await decide(r,'101');assert.equal(wrong.status,'clarify');assert.deepEqual(await f.snapshotLedger(),before);
 for(const text of ['familiar','sí','Confirma todo']){const e=await f.event('202',text);const result=await f.rpc('approval:resolve',{id:e.id,request_id:r.id,revision:r.revision,decision:'confirm'});assert.equal(result.status,'clarify');assert.deepEqual(await f.snapshotLedger(),before);}
});
test('group and private confirmations resolve the same request with one financial result',async()=>{
 const {request:r}=await pending();const before=(await f.snapshotLedger()).transactions.length;
 await Promise.all([decide(r),decide(r,'202','confirm',{chatId:'202',chatType:'private'})]);
 const after=await f.snapshotLedger();assert.equal(after.transactions.length,before+1);assert.equal((await f.db.query<any>('select count(*)::int n from private.approval_decisions where request_id=$1',[r.id])).rows[0].n,1);
 const routes=(await f.db.query<any>("select chat_id,purpose from private.outbox where result->>'request_id'=$1",[r.id])).rows;assert.ok(routes.some((x:any)=>x.chat_id==='202'&&x.purpose==='approval_ack'));
});
test('rejection stops approval and never registers or revives the same request',async()=>{
 const {request:r}=await pending(),before=await f.snapshotLedger();const reject=await decide(r,'202','reject');assert.equal(reject.status,'approval_rejected');assert.deepEqual(await f.snapshotLedger(),before);
 await decide(r);assert.deepEqual(await f.snapshotLedger(),before);assert.equal((await f.db.query<any>('select state from private.approval_requests where id=$1',[r.id])).rows[0].state,'rejected');
});
test('changed draft fields invalidate approval and old button does not execute updated amount',async()=>{
 const e=await f.event(),d=(await f.rpc('agent:draft_save',{id:e.id,fields:{kind:'expense',account:'Cuenta Dos',amount_cop:'231.19',payer:'101',scope:'family',category:'Compras',date:'2026-10-05'}})).draft;
 const r=await f.rpc('agent:apply',{id:e.id,action:{...d.fields,type:'post',amount:'23119',_draft_id:d.id,_draft_revision:d.revision}}),q=(await f.db.query<any>('select private.finance_approval_json($1) r',[r.request_id])).rows[0].r;
 const next=await f.event();await f.rpc('agent:draft_save',{id:next.id,draft_id:d.id,revision:d.revision,fields:{amount_cop:'241.19'}});
 const before=await f.snapshotLedger();const old=await decide(q);assert.equal(old.status,'clarify');assert.deepEqual(await f.snapshotLedger(),before);assert.equal((await f.db.query<any>('select state from private.approval_requests where id=$1',[q.id])).rows[0].state,'superseded');
});
test('changing proposal contents invalidates the approval even when proposal ID is unchanged',async()=>{
 const e=await f.event(),stage=await f.rpc('agent:apply',{id:e.id,action:{type:'pro',command:'stage',proposal:{command:'account',name:'Propuesta Ajena',kind:'asset',owner:'202',amount:'25119',date:'2026-10-05'}}}),next=await f.event();
 const wait=await f.rpc('agent:apply',{id:next.id,action:{type:'pro',command:'confirm',target:String(stage.proposal_id)}}),q=(await f.db.query<any>('select private.finance_approval_json($1) r',[wait.request_id])).rows[0].r;
 await f.db.query("update private.proposals set action=jsonb_set(action,'{amount}','\"26119\"') where id=$1",[stage.proposal_id]);
 const before=await f.snapshotLedger();assert.equal((await decide(q)).status,'clarify');assert.deepEqual(await f.snapshotLedger(),before);assert.equal((await f.db.query<any>('select state from private.approval_requests where id=$1',[q.id])).rows[0].state,'superseded');
});
test('changed owner or expiry prevents stale confirmation and schedules no automatic posting',async()=>{
 const {request:r}=await pending();await f.db.query("update private.accounts set owner='101' where name='Cuenta Dos'");
 try{const before=await f.snapshotLedger();assert.equal((await decide(r)).status,'clarify');assert.deepEqual(await f.snapshotLedger(),before);}finally{await f.db.query("update private.accounts set owner='202' where name='Cuenta Dos'");}
 const {request:q}=await pending();await f.elapse(48*60*60*1000+1);const old=await f.snapshotLedger();assert.equal((await decide(q)).status,'clarify');assert.deepEqual(await f.snapshotLedger(),old);assert.equal((await f.db.query<any>('select state from private.approval_requests where id=$1',[q.id])).rows[0].state,'expired');
});
test('a duplicate recorded while waiting does not get silently confirmed by the owner',async()=>{
 const {action,request:r}=await pending(),e=await f.event('202');await f.rpc('agent:apply',{id:e.id,action});const before=await f.snapshotLedger();assert.equal((await decide(r)).status,'clarify');assert.deepEqual(await f.snapshotLedger(),before);
});
test('start enables only the verified private chat and never approves a pending movement',async()=>{
 const {request:r}=await pending(),before=await f.snapshotLedger(),e=await f.event('202','start confirmaciones',{chatId:'202',chatType:'private'});
 await f.rpc('approval:private_start',{id:e.id});assert.deepEqual(await f.snapshotLedger(),before);assert.equal((await f.db.query<any>('select chat_id,enabled from private.approval_private_chats where member_id=$1',['202'])).rows[0].enabled,true);assert.equal((await f.db.query<any>('select state from private.approval_requests where id=$1',[r.id])).rows[0].state,'pending');
});
test('a brief reply resolves by chat and topic even when message IDs collide',async()=>{
 const {request:r}=await pending(),{request:q}=await pending();
 for(const [request,chat,thread]of [[r,'-100123',12],[q,'202',null]] as const)await f.db.query("update private.approval_notices set state='sent',chat_id=$2,thread_id=$3,telegram_message_id=100 where request_id=$1 and member_id='202' and round=1",[request.id,chat,thread]);
 const unrelated=await f.event('202','sí',{chatId:'-100123',chatType:'supergroup',threadId:13,replyTo:100});assert.equal((await f.rpc('approval:reply_target',{id:unrelated.id})).found,false);
 const e=await f.event('202','sí',{chatId:'202',chatType:'private',replyTo:100});assert.equal((await f.rpc('approval:reply_target',{id:e.id})).id,q.id);assert.equal((await f.rpc('approval:resolve',{id:e.id,request_id:q.id,revision:q.revision,decision:'confirm'})).status,'ok');assert.equal((await f.db.query<any>('select state from private.approval_requests where id=$1',[r.id])).rows[0].state,'pending');
});
