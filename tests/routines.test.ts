import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {vector} from '@electric-sql/pglite-pgvector';
import {readFileSync,readdirSync} from 'node:fs';
const db=new PGlite({extensions:{vector}});
const core=async(op:string,data:any={})=>(await db.query<{r:any}>('select public.finance_api($1,$2::jsonb) r',[op,JSON.stringify(data)])).rows[0].r;
const pro=async(op:string,data:any={})=>(await db.query<{r:any}>('select public.finance_pro($1,$2::jsonb) r',[op,JSON.stringify(data)])).rows[0].r;
let seq=10000;
async function event(actor='101',payload:any={}){const id=seq++;await core('ingest',{update_id:id,actor,name:actor,group:'-100123',payload});return id;}
before(async()=>{await db.exec('create role anon; create role authenticated; create role service_role bypassrls; create schema vault; create table vault.decrypted_secrets(name text, decrypted_secret text); grant usage on schema vault to service_role; grant select on vault.decrypted_secrets to service_role;');for(const f of readdirSync('supabase/migrations').filter(f=>!f.endsWith('_worker_schedule.sql')).sort())await db.exec(readFileSync('supabase/migrations/'+f,'utf8'));await core('init',{group:'-100123'});await event('202');const id=await event();await core('apply',{id,action:{type:'account',name:'Banco',kind:'asset',owner:'101',amount:'10000000',date:'2025-12-27'}});});
after(()=>db.close());
const routine=async(op:string,data:any={})=>(await db.query<{r:any}>('select public.finance_routines($1,$2::jsonb) r',[op,JSON.stringify(data)])).rows[0].r;
const agent=async(op:string,data:any={})=>(await db.query<{r:any}>('select public.finance_agent($1,$2::jsonb) r',[op,JSON.stringify(data)])).rows[0].r;
const action=async(actor:string,a:any)=>agent('apply',{id:await event(actor),action:{type:'routine',...a}});
let rule:string,occurrence:string;
test('Monthly schedules prompt once, clamp day31, and never post automatically',async()=>{
 const n=(await db.query<any>('select count(*)::int n from private.transactions')).rows[0].n;
 const r=await action('101',{command:'recurring_create',label:'Administración',amount_cop:'120000',account:'Banco',category:'Vivienda',scope:'family',start:'2026-01-31',day:31});rule=r.rule_id;
 await routine('due',{today:'2026-01-31'});await routine('due',{today:'2026-01-31'});
 const ctx=await routine('context',{id:await event()});occurrence=ctx.recurring_pending[0].id;
 assert.equal(ctx.recurring_rules[0].next_due,'2026-02-28');assert.equal(ctx.recurring_pending.length,1);
 assert.equal((await db.query<any>('select count(*)::int n from private.transactions')).rows[0].n,n);
});
test('Confirmed recurrence reuses a durable draft and posts exactly once',async()=>{
 const id=await event();const prepared=await routine('prepare',{id,occurrence,date:'2026-01-31'});
 const again=await routine('prepare',{id:await event(),occurrence,date:'2026-01-31'});assert.equal(again.draft.id,prepared.draft.id);
 const d=prepared.draft;const data={id:await event(),action:{type:'post',...d.fields,amount:String(BigInt(d.fields.amount_cop)*100n),_draft_id:d.id,_draft_revision:d.revision}};
 const posted=await agent('apply',data);assert.equal(posted.status,'ok');assert.deepEqual(await agent('apply',data),posted);
 assert.equal((await routine('context',{id:await event()})).recurring_pending.length,0);
 await assert.rejects(routine('prepare',{id:await event(),occurrence,date:'2026-01-31'}));
});
test('Recurring edits are isolated and paused rules do not create new notices',async()=>{
 await assert.rejects(action('202',{command:'recurring_toggle',target:rule,enabled:false}));
 await action('101',{command:'recurring_toggle',target:rule,enabled:false});await routine('due',{today:'2026-03-31'});
 assert.equal((await routine('context',{id:await event()})).recurring_pending.length,0);
});
test('Monthly review uses month-end balances and cannot claim unverified reconciliation',async()=>{
 const id=await event();const review=await routine('review',{id,month:'2026-08-01'});
 assert.equal(review.accounts[0].balance,'-2000000'); // Opening minus January expense
 assert.equal(review.accounts[0].checked,false);
 await assert.rejects(action('101',{command:'close_finish',month:'2026-08-01',accept_pending:false}));
 await routine('check',{id:await event(),month:'2026-08-01',account:'Banco',balance_cop:'-20000'});
 const done=await action('101',{command:'close_finish',month:'2026-08-01',accept_pending:false});assert.equal(done.review.state,'reviewed');
 await core('apply',{id:await event(),action:{type:'post',kind:'expense',amount:'10000',account:'Banco',payer:'101',scope:'family',date:'2026-08-20',category:'Comida',memo:'Ajuste tardío'}});
 const changed=await routine('review',{id:await event(),month:'2026-08-01'});assert.equal(changed.changed_since_review,true);assert.equal(changed.accounts[0].checked,false);
});
test('Review can retain explicit pending issues without changing balances; access is private',async()=>{
 const done=await action('101',{command:'close_finish',month:'2026-08-01',accept_pending:true});assert.equal(done.review.state,'reviewed_with_pending');
 await db.exec('set role service_role');try{await routine('context',{id:await event()});}finally{await db.exec('reset role');}
 for(const role of ['anon','authenticated'])assert.equal((await db.query<any>("select has_function_privilege($1,'public.finance_routines(text,jsonb)','EXECUTE') p",[role])).rows[0].p,false);
});
test('Difference is calculated in SQL and a reversed recurring payment becomes pending',async()=>{
 const review=await routine('check',{id:await event(),month:'2026-08-01',account:'Banco',balance_cop:'-10000'});
 assert.equal(review.accounts[0].difference,'1010000');
 const tx=(await db.query<any>('select transaction_id from private.recurring_occurrences where id=$1',[occurrence])).rows[0].transaction_id;
 await core('apply',{id:await event(),action:{type:'reverse',target:String(tx),reason:'pago equivocado'}});
 await routine('due',{today:'2026-03-31'});
 assert.ok((await routine('context',{id:await event()})).recurring_pending.some((x:any)=>x.id===occurrence));
});
test('Future months are refused and late postings invalidate equal-balance checks',async()=>{
 await assert.rejects(routine('review',{id:await event(),month:'2099-01-01'}));
 const month='2026-08-01';const r=await routine('review',{id:await event(),month});
 const balance=String(BigInt(r.accounts[0].balance)/100n);
 await routine('check',{id:await event(),month,account:'Banco',balance_cop:balance});
 const tx=await core('apply',{id:await event(),action:{type:'post',kind:'expense',amount:'10000',account:'Banco',payer:'101',scope:'family',date:'2026-08-21',category:'Comida',memo:'temporal'}});
 await core('apply',{id:await event(),action:{type:'reverse',target:String(tx.transaction_id),reason:'anulado'}});
 assert.equal((await routine('review',{id:await event(),month})).accounts[0].checked,false);
});
test('Accounts opened after cutoff remain unknown at historical close',async()=>{
 await core('apply',{id:await event(),action:{type:'account',name:'Nueva',kind:'asset',owner:'101',amount:'0',date:'2026-09-27'}});
 const r=await routine('review',{id:await event(),month:'2026-08-01'});
 assert.equal(r.accounts.find((x:any)=>x.name==='Nueva').balance_known,false);
});
test('Updating a recurring rule is atomic and replies resolve only own reminder',async()=>{
 const result=await action('101',{command:'recurring_update',target:rule,label:'Administración nueva',amount_cop:'130000',account:'Banco',category:'Vivienda',scope:'family',day:5,start:'2026-10-05'});
 assert.equal(result.status,'ok');
 const ctx=await routine('context',{id:await event()});assert.equal(ctx.recurring_rules[0].amount_cop,'130000');assert.equal(ctx.recurring_rules[0].enabled,true);
 await db.query("update private.outbox set telegram_message_id=9911 where result->>'occurrence_id'=$1",[occurrence]);
 const replied=await routine('context',{id:await event('101',{replyTo:9911})});assert.equal(replied.recurring_reply.id,occurrence);
 const other=await routine('context',{id:await event('202',{replyTo:9911})});assert.equal(other.recurring_reply,null);
});
test('Decimal recurring amounts and observed closing balances keep exact cents',async()=>{
 const created=await action('101',{command:'recurring_create',label:'Suscripción decimal',amount_cop:'123.19',account:'Banco',category:'Servicios',scope:'family',day:28,start:'2026-09-28'});
 assert.ok(created.rule_id);await routine('due',{today:'2026-09-28'});
 const ctx=await routine('context',{id:await event()});const occurrence=ctx.recurring_pending.find((x:any)=>x.label==='Suscripción decimal');
 const prepared=await routine('prepare',{id:await event(),occurrence:occurrence.id,date:'2026-09-28'});
 assert.equal(prepared.draft.fields.amount_cop,'123.19');
 const checked=await routine('check',{id:await event(),month:'2026-08-01',account:'Banco',balance_cop:'-10000.19'});
 assert.equal(checked.accounts.find((x:any)=>x.name==='Banco').observed,'-1000019');
 await assert.rejects(action('101',{command:'recurring_create',label:'Inválido',amount_cop:'123.199',account:'Banco',category:'Servicios',scope:'family',day:28,start:'2026-09-28'}));
});
test('Monthly review asks only about accounts and pockets owned by its actor, while totals stay shared',async()=>{
 await core('apply',{id:await event('202'),action:{type:'account',name:'Banco Beta',kind:'asset',owner:'202',amount:'100000',date:'2026-07-01'}});
 await core('apply',{id:await event('202'),action:{type:'account',name:'Tarjeta Alfa Sam',kind:'liability',owner:'202',amount:'50000',date:'2026-07-01'}});
 await core('apply',{id:await event('202'),action:{type:'post',kind:'expense',account:'Banco Beta',amount:'12319',payer:'202',scope:'family',category:'Servicios',date:'2026-09-01',memo:'Compartido'}});
 const preview=await pro('act',{id:await event(),action:{command:'stage',proposal:{command:'pocket',account:'Banco',name:'Ahorro',amount:'100',date:'2026-09-01'}}});
 const pocket=await pro('act',{id:await event(),action:{command:'confirm',target:preview.proposal_id}});
 assert.equal(pocket.status,'ok');
 const own=await routine('review',{id:await event(),month:'2026-09-01'});
 const wife=await routine('review',{id:await event('202'),month:'2026-09-01'});
 assert.ok(own.accounts.every((a:any)=>a.owner==='101'));
 assert.ok(own.accounts.some((a:any)=>a.name==='Banco · Ahorro'));
 assert.ok(!own.accounts.some((a:any)=>a.name==='Banco Beta'||a.name==='Tarjeta Alfa Sam'));
 assert.deepEqual(wife.accounts.map((a:any)=>a.name),['Banco Beta','Tarjeta Alfa Sam']);
 assert.ok(wife.accounts.every((a:any)=>a.owner==='202'));
 assert.equal(own.report.expense,wife.report.expense);
 const all=await core('report',{from:'2026-09-01',to:'2026-09-30',scope:'all',actor:'101'});
 assert.equal(own.report.expense,all.expense);assert.equal(own.report.income,all.income);
});
test('Another actor cannot verify a foreign balance through either RPC or an agent tool',async()=>{
 const before=(await db.query<any>('select actor,month,checks from private.monthly_reviews order by actor,month')).rows;
 const id=await event();
 await assert.rejects(routine('check',{id,month:'2026-09-01',account:'Banco Beta',balance_cop:'876.81'}));
 assert.deepEqual((await db.query<any>('select actor,month,checks from private.monthly_reviews order by actor,month')).rows,before);
 const {dispatchTool}=await import('../supabase/functions/_shared/agent-tools.ts');
 const context={...(await core('context')),actor:'101',event_id:id};
 let called=false;await assert.rejects(dispatchTool('comprobar_saldo_cierre',{month:'2026-09-01',account:'Banco Beta',balance_cop:'876.81'},context,async()=>{called=true;return {}; }));
 assert.equal(called,false);
});
test('An owner completes their own monthly review without verifying the other persons accounts',async()=>{
 const month='2026-09-01';await routine('check',{id:await event('202'),month,account:'Banco Beta',balance_cop:'876.81'});
 await routine('check',{id:await event('202'),month,account:'Tarjeta Alfa Sam',balance_cop:'500'});
 const result=await action('202',{command:'close_finish',month,accept_pending:false});
 assert.equal(result.review.state,'reviewed');assert.equal(result.review.issues,0);
 assert.ok(result.review.accounts.every((a:any)=>a.owner==='202'&&a.checked));
 const other=await routine('review',{id:await event(),month});assert.ok(other.accounts.some((a:any)=>!a.checked));
});
