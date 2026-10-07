import {test,before,after} from 'node:test';import assert from 'node:assert/strict';
import {approvalDatabase} from './fixtures/approval-database.ts';
let f:Awaited<ReturnType<typeof approvalDatabase>>;
const post=(extra:any={})=>({type:'post',kind:'expense',account:'Cuenta Uno',amount:'5127',date:'2026-10-05',payer:'101',scope:'family',category:'Compras',memo:'Compra ficticia',...extra});
before(async()=>{f=await approvalDatabase();await f.enable();});after(async()=>f?.db.close());
test('own movement records exact cents immediately',async()=>{const e=await f.event();const r=await f.rpc('agent:apply',{id:e.id,action:post()});assert.equal(r.status,'ok');assert.equal(r.receipt.amount,'5127');});
test('foreign family expense awaits actual account owner without changing balances',async()=>{
 const e=await f.event(),before=await f.snapshotLedger();const r=await f.rpc('agent:apply',{id:e.id,action:post({account:'Cuenta Dos',amount:'6127',payer:'101',_approval_id:'123',confirm_owner:true})});
 assert.equal(r.status,'approval_pending');assert.deepEqual(await f.snapshotLedger(),before);
 const row=(await f.db.query<any>('select required_members,reporter from private.approval_requests where id=$1',[r.request_id])).rows[0];assert.deepEqual(row,{required_members:['202'],reporter:'101'});
});
test('raw apply and pro account creation cannot bypass another owner including a zero opening',async()=>{
 for(const action of [post({account:'Cuenta Dos',amount:'7127'}),{type:'account',name:'Cuenta Nueva Ajena',kind:'asset',owner:'202',amount:'0',date:'2026-10-05'}]){
  const e=await f.event(),before=await f.snapshotLedger(),r=await f.rpc('apply',{id:e.id,action});assert.equal(r.status,'approval_pending');assert.deepEqual(await f.snapshotLedger(),before);
 }
 const e=await f.event(),before=await f.snapshotLedger();const r=await f.rpc('pro:act',{id:e.id,action:{command:'account',name:'Otra Cuenta Ajena',kind:'asset',owner:'202',amount:'0',date:'2026-10-05'}});assert.equal(r.status,'approval_pending');assert.deepEqual(await f.snapshotLedger(),before);
});
test('own transfer proceeds while independent cross-owner transfer stays pending',async()=>{
 const init=await f.event();await f.rpc('agent:apply',{id:init.id,action:{type:'account',name:'Reserva Uno',kind:'asset',owner:'101',amount:'0',date:'2026-10-05'}});
 const e=await f.event();const saved=await f.rpc('agent:drafts_save',{id:e.id,items:[{item_key:'own',fields:{kind:'transfer',account:'Cuenta Uno',other:'Reserva Uno',amount_cop:'83.19',date:'2026-10-05',payer:'101',scope:'family'}},{item_key:'foreign',fields:{kind:'transfer',account:'Cuenta Dos',other:'Cuenta Uno',amount_cop:'93.19',date:'2026-10-05',payer:'202',scope:'family'}}]});
 const items=saved.drafts.map((d:any)=>({...d.fields,type:'post',amount:d.fields.amount_cop==='83.19'?'8319':'9319',_draft_id:d.id,_draft_revision:d.revision}));
 const r=await f.rpc('agent:apply',{id:e.id,action:{type:'batch_post',items}});assert.equal(r.status,'ok');assert.equal(r.receipts.length,1);assert.equal(r.approval_requests.length,1);
 const drafts=(await f.db.query<any>('select state,transaction_id from private.agent_drafts where origin_event=$1 order by id',[e.id])).rows;
 assert.equal(drafts[0].state,'completed');assert.equal(drafts[1].state,'pending');assert.equal(drafts[1].transaction_id,null);
 const rows=(await f.db.query<any>('select delta::text from private.entries where transaction_id=$1 order by id',[r.receipts[0].transaction_id])).rows;assert.deepEqual(rows,[{delta:'-8319'},{delta:'8319'}]);
});
test('duplicate in a mixed group prevents both new postings and approval creation',async()=>{
 const e=await f.event();const saved=await f.rpc('agent:drafts_save',{id:e.id,items:[{item_key:'duplicate',fields:{kind:'expense',account:'Cuenta Uno',amount_cop:'51.27',date:'2026-10-05',payer:'101',scope:'family',category:'Compras'}},{item_key:'foreign',fields:{kind:'expense',account:'Cuenta Dos',amount_cop:'113.19',date:'2026-10-05',payer:'101',scope:'family',category:'Compras'}}]});
 const items=saved.drafts.map((d:any)=>({...d.fields,type:'post',amount:d.fields.amount_cop==='51.27'?'5127':'11319',_draft_id:d.id,_draft_revision:d.revision}));
 const before=await f.snapshotLedger(),count=(await f.db.query<any>('select count(*)::int n from private.approval_requests')).rows[0].n;
 const r=await f.rpc('agent:apply',{id:e.id,action:{type:'batch_post',items}});assert.notEqual(r.status,'ok');assert.deepEqual(await f.snapshotLedger(),before);assert.equal((await f.db.query<any>('select count(*)::int n from private.approval_requests')).rows[0].n,count);
});
test('correction into another owner account waits before reversing original transaction',async()=>{
 const e=await f.event(),tx=await f.rpc('agent:apply',{id:e.id,action:post({amount:'12317'})}),next=await f.event();const before=await f.snapshotLedger();
 const r=await f.rpc('pro:act',{id:next.id,action:{command:'correct',target:String(tx.transaction_id),field:'account',value:'Cuenta Dos'}});assert.equal(r.status,'approval_pending');assert.deepEqual(await f.snapshotLedger(),before);
});
test('incomplete or inconsistent foreign operations are rejected before creating requests',async()=>{
 for(const action of [post({account:'Cuenta Dos',amount:'0'}),post({account:'Cuenta Dos',date:'not-a-date'}),post({account:'Cuenta Dos',payer:'999'}),post({kind:'transfer',account:'Cuenta Dos',other:'missing'}),post({kind:'transfer',account:'Cuenta Dos',other:'Cuenta Dos'})]){
  const e=await f.event(),before=await f.snapshotLedger(),n=(await f.db.query<any>('select count(*)::int n from private.approval_requests')).rows[0].n;
  const r=await f.rpc('agent:apply',{id:e.id,action}).catch(()=>({status:'invalid'}));assert.notEqual(r.status,'approval_pending');assert.deepEqual(await f.snapshotLedger(),before);assert.equal((await f.db.query<any>('select count(*)::int n from private.approval_requests')).rows[0].n,n);
 }
});
test('forged draft revision and changed fields cannot get an owner approval request',async()=>{
 const e=await f.event(),d=(await f.rpc('agent:draft_save',{id:e.id,fields:{kind:'expense',account:'Cuenta Dos',amount_cop:'134.19',date:'2026-10-05',payer:'101',scope:'family',category:'Compras'}})).draft;
 for(const patch of [{_draft_revision:d.revision+1},{amount:'13519'},{memo:'Changed'}]){
  const before=await f.snapshotLedger();await assert.rejects(f.rpc('agent:apply',{id:e.id,action:{...d.fields,type:'post',amount:'13419',_draft_id:d.id,_draft_revision:d.revision,...patch}}));assert.deepEqual(await f.snapshotLedger(),before);
 }
});
test('new own account with a linked cross-owner movement waits before creating either',async()=>{
 const e=await f.event(),d=(await f.rpc('agent:draft_save',{id:e.id,fields:{kind:'transfer',account:'Cuenta Dos',other:'Cuenta Vinculada',amount_cop:'141.19',date:'2026-10-05',payer:'202',scope:'family'}})).draft;
 const stage=await f.rpc('agent:apply',{id:e.id,action:{type:'pro',command:'stage',proposal:{command:'account',name:'Cuenta Vinculada',kind:'asset',owner:'101',amount:'0',balance_known:true,date:'2026-10-05',linked_drafts:[{draft_id:d.id,revision:d.revision,fields:d.fields}]}}});
 const confirm=await f.event(),before=await f.snapshotLedger();const r=await f.rpc('agent:apply',{id:confirm.id,action:{type:'pro',command:'confirm',target:String(stage.proposal_id)}});
 assert.equal(r.status,'approval_pending');assert.deepEqual(await f.snapshotLedger(),before);assert.equal((await f.db.query<any>('select state from private.proposals where id=$1',[stage.proposal_id])).rows[0].state,'pending');
});
test('foreign income and debt payments derive permission from affected accounts rather than payer',async()=>{
 const e=await f.event();const r=await f.rpc('agent:apply',{id:e.id,action:post({kind:'income',account:'Cuenta Dos',amount:'15119',counterparty:'Cliente Externo'})});assert.equal(r.status,'approval_pending');
 const seed=await f.event('202');await f.rpc('agent:apply',{id:seed.id,action:{type:'account',name:'Deuda Dos',kind:'liability',owner:'202',amount:'0',date:'2026-10-05'}});
 const pay=await f.event(),before=await f.snapshotLedger(),result=await f.rpc('agent:apply',{id:pay.id,action:post({kind:'transfer',account:'Cuenta Uno',other:'Deuda Dos',amount:'16119',payer:'101'})});assert.equal(result.status,'approval_pending');assert.deepEqual(await f.snapshotLedger(),before);
});
test('only explicitly shared accounts allow a null owner',async()=>{
 await f.db.query("insert into private.accounts(name,kind,management_mode) values('Compartida','asset','shared'),('Sin Titular','asset','exclusive')");
 const e=await f.event();const r=await f.rpc('agent:apply',{id:e.id,action:post({account:'Compartida',amount:'17119'})});assert.equal(r.status,'ok');
 const next=await f.event(),before=await f.snapshotLedger();await assert.rejects(f.rpc('agent:apply',{id:next.id,action:post({account:'Sin Titular',amount:'18119'})}),/responsable/);assert.deepEqual(await f.snapshotLedger(),before);
});
test('entry trigger rejects an otherwise valid direct foreign posting without an approved execution',async()=>{
 const e=await f.event(),before=await f.snapshotLedger();
 await assert.rejects(f.db.transaction(async tx=>{const r=await tx.query<any>("insert into private.transactions(event_id,actor,date,kind,scope,payer) values($1,'101','2026-10-05','expense','family','101') returning id",[e.id]);await tx.query("insert into private.entries(transaction_id,account_id,delta) select $1,id,-19119 from private.accounts where name='Cuenta Dos'",[r.rows[0].id]);}),/approval required/);
 assert.deepEqual(await f.snapshotLedger(),before);
});
