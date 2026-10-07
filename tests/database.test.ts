import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {vector} from '@electric-sql/pglite-pgvector';
import {readFileSync,readdirSync} from 'node:fs';
const db=new PGlite({extensions:{vector}});
const call=async(op:string,data:unknown={})=>(await db.query<{r:any}>('select public.finance_api($1,$2::jsonb) r',[op,JSON.stringify(data)])).rows[0].r;
let seq=1;
async function action(a:any){const id=seq++;await call('ingest',{update_id:id,actor:'101',name:'Alex',group:'-100123',payload:{}});return call('apply',{id,action:a});}
before(async()=>{await db.exec('create role anon; create role authenticated; create role service_role bypassrls; create schema vault; create table vault.decrypted_secrets(name text, decrypted_secret text); grant usage on schema vault to service_role; grant select on vault.decrypted_secrets to service_role;');for(const f of readdirSync('supabase/migrations').filter(f=>!f.endsWith('_worker_schedule.sql')).sort())await db.exec(readFileSync('supabase/migrations/'+f,'utf8'));await call('init',{group:'-100123'});});
after(()=>db.close());
test('accounts and opening balances are not income',async()=>{
 await action({type:'account',name:'Banco',kind:'asset',owner:'101',amount:'10000000',date:'2026-09-01'});
 await action({type:'account',name:'Tarjeta',kind:'liability',owner:'101',amount:'0',date:'2026-09-01'});
 const r=await call('report',{from:'2026-09-01',to:'2026-09-30',scope:'all'});assert.equal(r.income,'0');assert.equal(r.balances.find((x:any)=>x.name==='Banco').balance,'10000000');
});
test('expense on credit and later card payment only count one expense',async()=>{
 await action({type:'post',kind:'expense',account:'Tarjeta',amount:'1000000',date:'2026-09-20',category:'Mercado',scope:'family',payer:'101',memo:'compra'});
 await action({type:'post',kind:'transfer',account:'Banco',other:'Tarjeta',amount:'1000000',date:'2026-09-21',scope:'family',payer:'101',memo:'pago tarjeta'});
 const r=await call('report',{from:'2026-09-01',to:'2026-09-30',scope:'all'});assert.equal(r.expense,'1000000');assert.equal(r.balances.find((x:any)=>x.name==='Tarjeta').balance,'0');assert.equal(r.balances.find((x:any)=>x.name==='Banco').balance,'9000000');
});
test('retry same event cannot post twice',async()=>{const id=seq++;await call('ingest',{update_id:id,actor:'101',name:'Alex',group:'-100123',payload:{}});const a={type:'post',kind:'income',account:'Banco',amount:'100000',date:'2026-09-22',category:'Salario',scope:'personal',payer:'101',memo:'nomina'};const r=await call('apply',{id,action:a});assert.deepEqual(await call('apply',{id,action:a}),r);});
test('possible duplicate stays pending until explicit confirmation',async()=>{
 const a={type:'post',kind:'expense',account:'Banco',amount:'12345',date:'2026-09-22',category:'Cafe',scope:'personal',payer:'101',memo:'cafe'};
 await action(a);const r=await action(a);assert.equal(r.status,'duplicate');
 assert.equal((await action({...a,memo:'OCR varió el comercio'})).status,'duplicate');
 const p=await call('report',{from:'2026-09-22',to:'2026-09-22',scope:'all'});assert.equal(p.expense,'12345');
});
test('reverse once, never delete financial history',async()=>{
 const r=await action({type:'post',kind:'expense',account:'Banco',amount:'50000',date:'2026-09-23',category:'Taxi',scope:'family',payer:'101',memo:'error'});
 await action({type:'reverse',target:r.transaction_id,reason:'registrado por error'});
 await assert.rejects(()=>action({type:'reverse',target:r.transaction_id,reason:'repetido'}));
 const p=await call('report',{from:'2026-09-23',to:'2026-09-23',scope:'all'});assert.equal(p.expense,'0');
 await assert.rejects(()=>db.exec('delete from private.entries'));
});
test('reject other groups and third household member',async()=>{
 await assert.rejects(()=>call('ingest',{update_id:seq++,actor:'101',name:'Alex',group:'123',payload:{}}));
 await call('ingest',{update_id:seq++,actor:'102',name:'Esposa',group:'-100123',payload:{}});
 await assert.rejects(()=>call('ingest',{update_id:seq++,actor:'103',name:'Otro',group:'-100123',payload:{}}));
});
test('anonymous role cannot read ledger or call RPC',async()=>{
 await db.exec('set role anon');try{await assert.rejects(()=>call('report',{}));await assert.rejects(()=>db.query('select * from private.entries'));}finally{await db.exec('reset role');}
});
test('reject negative amount and missing payer',async()=>{
 await assert.rejects(()=>action({type:'post',kind:'income',account:'Banco',amount:'-1',date:'2026-09-23',scope:'family',payer:'101',category:'x'}));
 await assert.rejects(()=>action({type:'post',kind:'income',account:'Banco',amount:'1',date:'2026-09-23',scope:'family',payer:'999',category:'x'}));
});
test('outbox is durable and report is computed at execution',async()=>{
 await db.exec('update private.outbox set sent_at=now() where sent_at is null');
 const r=await action({type:'report',from:'2026-09-01',to:'2026-09-30',scope:'all'});
 assert.equal(r.status,'ok');assert.equal(r.report.expense,'1012345');
 const o=await call('outbox');assert.ok(o.some((m:any)=>m.result.report?.expense==='1012345'));
 const target=o.find((m:any)=>m.result.report?.expense==='1012345');await call('sent',{id:target.id});
 assert.ok(!(await call('outbox')).some((m:any)=>m.id===target.id));
});
test('limit blocks moving liability or receivable into income',async()=>{
 await assert.rejects(()=>action({type:'post',kind:'income',account:'Tarjeta',amount:'10000',date:'2026-09-24',category:'Nomina',scope:'family',payer:'101'}));
});
test('budgets and reminders are persisted with author and month',async()=>{
 const b=await action({type:'budget',scope:'family',category:'Mercado',month:'2026-09-01',amount:'150000000'});
 assert.equal(b.status,'ok');
 const p=await call('report',{from:'2026-09-01',to:'2026-09-30',scope:'family'});
 assert.equal(p.budgets.find((x:any)=>x.category==='Mercado').limit,'150000000');
 const m=await action({type:'reminder',label:'arriendo',date:'2026-09-25'});assert.equal(m.status,'ok');
 const due=await call('due',{today:'2026-09-25'});
 assert.ok(due.some((x:any)=>x.message.includes('arriendo')));
 assert.deepEqual(await call('due',{today:'2026-09-25'}),due);
});
test('duplicate confirmation consumes one pending proposal exactly once',async()=>{
 const a={type:'post',kind:'expense',account:'Banco',amount:'12345',date:'2026-09-22',category:'Cafe',scope:'personal',payer:'101',memo:'cafe'};
 const id=seq++;await call('ingest',{update_id:id,actor:'101',name:'Alex',group:'-100123',payload:{text:'recibo'}});
 assert.equal((await call('apply',{id,action:a})).status,'duplicate');
 await assert.rejects(()=>action({...a,confirm_duplicate:true}));
 const r=await action({...a,confirm_duplicate:true,pending_event_id:String(id)});assert.equal(r.status,'ok');
 await assert.rejects(()=>action({...a,confirm_duplicate:true,pending_event_id:String(id)}));
 assert.equal((await call('pending',{id})).status,'unknown');
 assert.deepEqual((await db.query<{payload:any}>('select payload from private.events where id=$1',[id])).rows[0].payload,{});
});
test('pending duplicate can be fetched only as an event action',async()=>{
 const id=seq++;await call('ingest',{update_id:id,actor:'101',name:'Alex',group:'-100123',payload:{}});
 const a={type:'post',kind:'expense',account:'Banco',amount:'12345',date:'2026-09-22',category:'Cafe',scope:'personal',payer:'101',memo:'cafe'};
 const r=await call('apply',{id,action:a});assert.equal(r.status,'duplicate');
 const pending=await call('pending',{id});assert.equal(pending.action.memo,'cafe');
 assert.equal((await call('pending',{id:999999})).status,'unknown');
});
test('history includes signed category amount and audit reason',async()=>{
 const h=await call('history');
 assert.ok(h.some((r:any)=>r.kind==='expense'&&r.amount==='12345'));
 assert.ok(h.some((r:any)=>r.kind==='reverse'&&r.reverses));
});
test('exceeded budget creates one durable alert per threshold',async()=>{
 await action({type:'budget',scope:'family',category:'Mercado',month:'2026-09-01',amount:'1000000'});
 const out=await call('due',{today:'2026-09-27'});
 assert.ok(out.some((x:any)=>x.message.includes('Mercado')));
 assert.deepEqual(await call('due',{today:'2026-09-27'}),out);
});
test('personal budget belongs to beneficiary when another member pays',async()=>{
 await action({type:'budget',scope:'personal',beneficiary:'102',category:'Regalo',month:'2026-09-01',amount:'100000'});
 await action({type:'post',kind:'expense',account:'Banco',amount:'100000',date:'2026-09-24',category:'Regalo',scope:'personal',payer:'101',beneficiary:'102',memo:'para ella'});
 const p=await call('report',{from:'2026-09-01',to:'2026-09-30',scope:'personal'});
 assert.ok(p.budgets.some((x:any)=>x.owner==='102'&&x.category==='Regalo'));
 const h=await call('history');assert.ok(h.some((x:any)=>x.memo==='para ella'&&x.payer==='101'&&x.beneficiary==='102'));
});
test('failed third processing attempt is visible as an outbox notice',async()=>{
 await db.exec('update private.outbox set sent_at=now() where sent_at is null');
 let id:string|undefined;
 for(let n=0;n<3;n++){const claimed=await call('claim');id??=String(claimed.id);assert.equal(String(claimed.id),id);await call('fail',{id});}
 const out=await call('outbox');assert.ok(out.some((x:any)=>String(x.event_id)===id&&x.message.includes('solicitud')));
});
test('worker context returns only named accounts and known people',async()=>{
 const c=await call('context');
 assert.deepEqual(c.members.map((m:any)=>m.id).sort(),['101','102']);
 assert.ok(c.accounts.some((a:any)=>a.name==='Banco'&&a.kind==='asset'));
 assert.ok(c.accounts.every((a:any)=>!a.name.startsWith('expense:')));
});
test('CSV source exposes the complete signed ledger including corrections',async()=>{
 const x=await call('export');
 assert.ok(x.some((e:any)=>e.kind==='reverse'&&BigInt(e.delta)<0n));
 assert.ok(x.some((e:any)=>e.account==='Banco'&&e.date==='2026-09-20')===false);
 assert.ok(x.some((e:any)=>e.account==='Tarjeta'&&e.date==='2026-09-20'));
});

test('runtime config is restricted to server role and fixed secret names',async()=>{
 await db.exec("insert into vault.decrypted_secrets values ('TELEGRAM_GROUP_ID','-100123'),('UNRELATED_SECRET','do-not-return')");
 await db.exec('set role anon');try{await assert.rejects(()=>db.query('select public.finance_runtime_config()'));}finally{await db.exec('reset role');}
 await db.exec('set role service_role');try{const r=await db.query<{config:any}>('select public.finance_runtime_config() config');assert.deepEqual(r.rows[0].config,{TELEGRAM_GROUP_ID:'-100123'});}finally{await db.exec('reset role');}
});

test('Reply route survives payload cleanup and delivery claims exclude other workers',async()=>{
 const id=seq++;await call('ingest',{update_id:id,actor:'101',name:'Alex',group:'-100123',payload:{messageId:123,threadId:7}});
 await call('apply',{id,action:{type:'history'}});
 const row=(await db.query<{payload:any}>('select payload from private.events where id=$1',[id])).rows[0];assert.deepEqual(row.payload,{});
 let items:any[]=[];for(let i=0;i<10;i++){const batch=await call('outbox');items.push(...batch);if(!batch.length)break;}
 const reply=items.find(x=>Number(x.event_id)===id);assert.equal(reply.messageId,123);assert.equal(reply.threadId,7);
 assert.deepEqual(await call('outbox'),[]);
});
