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
before(async()=>{await db.exec('create role anon; create role authenticated; create role service_role bypassrls; create schema vault; create table vault.decrypted_secrets(name text, decrypted_secret text); grant usage on schema vault to service_role; grant select on vault.decrypted_secrets to service_role;');for(const f of readdirSync('supabase/migrations').filter(f=>!f.endsWith('_worker_schedule.sql')).sort())await db.exec(readFileSync('supabase/migrations/'+f,'utf8'));await core('init',{group:'-100123'});await event('202');const id=await event();await core('apply',{id,action:{type:'account',name:'Banco',kind:'asset',owner:'101',amount:'10000000',date:'2026-09-27'}});});
after(()=>db.close());
test('Conversation isolates actors and expires after 48 hours',async()=>{
 const id=await event();const c=await pro('conversation',{id,text:'Gasté 15000'});assert.equal(c.turns.length,1);
 const next=await event();const continued=await pro('conversation',{id:next,text:'Banco'});assert.equal(continued.session,c.session);assert.equal(continued.turns.length,2);
 const wife=await pro('conversation',{id:await event('202'),text:'Gasté 20000'});assert.notEqual(wife.session,c.session);
 await db.exec("update private.conversations set expires_at=now()-interval '1 hour'");
 assert.notEqual((await pro('conversation',{id:await event(),text:'Nuevo'})).session,c.session);
});
test('Preference staging requires confirmation and is idempotent',async()=>{
 const id=await event();const result=await pro('act',{id,action:{command:'stage',proposal:{command:'preference',merchant:'Netflix',account:'Banco',category:'Suscripciones',scope:'family'}}});
 assert.equal((await pro('context',{id})).preferences.length,0);
 const confirm=await event();const applied=await pro('act',{id:confirm,action:{command:'confirm',target:result.proposal_id}});assert.equal(applied.status,'ok');
 assert.deepEqual(await pro('act',{id:confirm,action:{command:'confirm',target:result.proposal_id}}),applied);
 assert.equal((await pro('context',{id})).preferences.length,1);
});
test('Planning reserves money without posting financial transactions',async()=>{
 const id=await event();const n=(await db.query<{n:number}>('select count(*)::int n from private.transactions')).rows[0].n;
 await pro('act',{id,action:{command:'commitment',label:'Arriendo',amount:'2000000',due:'2026-10-01',project:'hogar'}});
 const p=await pro('act',{id:await event(),action:{command:'planning',to:'2026-10-05'}});assert.equal(p.planning.available,'8000000');
 assert.equal((await db.query<{n:number}>('select count(*)::int n from private.transactions')).rows[0].n,n);
});

test('Correction reverses and replaces atomically; stale confirmation cannot post twice',async()=>{
 const id=await event();const original=await core('apply',{id,action:{type:'post',kind:'expense',account:'Banco',amount:'1500000',date:'2026-09-27',category:'Mercado',scope:'family',payer:'101',memo:'test correction'}});
 const corr=await pro('act',{id:await event(),action:{command:'correct',target:original.transaction_id,field:'amount',value:'2000000'}});
 assert.equal(corr.status,'ok');assert.equal((await core('report',{from:'2026-09-01',to:'2026-09-30',scope:'all'})).expense,'2000000');
 const stale=await pro('act',{id:await event(),action:{command:'correct',target:original.transaction_id,field:'amount',value:'3000000'}});assert.equal(stale.status,'clarify');
});
test('Duplicate statement import is idempotent and matching cannot reuse a transaction',async()=>{
 const rows=[{date:'2026-09-27',delta:'-2000000',memo:'Mercado'},{date:'2026-09-27',delta:'-2000000',memo:'Otro mercado'}];
 const imported=await pro('act',{id:await event(),action:{command:'statement',account:'Banco',rows}});assert.ok(imported.batch_id);
 const again=await pro('act',{id:await event(),action:{command:'statement',account:'Banco',rows}});assert.match(again.message,/ya estaba/);
 const result=await pro('act',{id:await event(),action:{command:'reconcile',target:imported.batch_id}});assert.equal(result.rows[0].candidates.length,1);
 const target=result.rows[0].candidates[0].id;
 await pro('act',{id:await event(),action:{command:'match',line:result.rows[0].id,target}});
 await assert.rejects(pro('act',{id:await event(),action:{command:'match',line:result.rows[1].id,target}}));
});
test('Another member cannot confirm someone else proposal',async()=>{
 const staged=await pro('act',{id:await event(),action:{command:'stage',proposal:{command:'summary',enabled:true}}});
 const result=await pro('act',{id:await event('202'),action:{command:'confirm',target:staged.proposal_id}});assert.equal(result.status,'clarify');
});
test('Pro action delivers through durable outbox and preserves response message mapping',async()=>{
 const id=await event();const r=await core('apply',{id,action:{type:'pro',command:'planning',to:'2026-10-05'}});assert.equal(r.status,'planning');
 const out=(await db.query<{id:number}>('select id from private.outbox where event_id=$1',[id])).rows[0];
 await core('sent',{id:out.id,telegram_message_id:999});
 assert.equal((await db.query<{mid:number}>('select telegram_message_id::int mid from private.outbox where id=$1',[out.id])).rows[0].mid,999);
});

test('Explicit reply resumes the right pending conversation and never another actor',async()=>{
 const root=await event('101',{messageId:1234,replyTo:98765});const c=await pro('conversation',{id:root,text:'Recibo pendiente'});
 const res=await core('apply',{id:root,action:{type:'clarify',question:'¿Qué cuenta?'}});
 const out=(await db.query<{id:number}>('select id from private.outbox where event_id=$1',[root])).rows[0];await core('sent',{id:out.id,telegram_message_id:4321});
 const follow=await pro('conversation',{id:await event('101',{replyTo:4321}),text:'Banco'});assert.equal(follow.session,c.session);
 const wrong=await pro('conversation',{id:await event('202',{replyTo:4321}),text:'Banco'});assert.notEqual(wrong.session,c.session);
});
test('Correcting reconciled transaction releases obsolete match',async()=>{
 const old=(await db.query<{id:number}>('select matched_transaction::int id from private.statement_lines where matched_transaction is not null limit 1')).rows[0];
 const corrected=await pro('act',{id:await event(),action:{command:'correct',target:old.id,field:'amount',value:'2100000'}});assert.equal(corrected.status,'ok');
 assert.equal((await db.query<{n:number}>('select count(*)::int n from private.statement_lines where matched_transaction=$1',[old.id])).rows[0].n,0);
});
test('Two workers cannot claim the same actor concurrently',async()=>{
 await db.exec("update private.events set state='done' where state in ('new','working')");
 const one=await event('101');const two=await event('101');const wife=await event('202');
 assert.equal((await core('claim')).id,one);assert.equal((await core('claim')).id,wife);assert.equal((await core('claim')).id,undefined);
});

test('Weekly summaries respect Bogota schedule, opt-in and deduplication',async()=>{
 await db.exec("update private.summary_settings set enabled=false,last_week=null");
 await db.query("select private.finance_weekly('2026-09-28T13:00:00Z')");
 assert.equal((await db.query<{n:number}>("select count(*)::int n from private.outbox where result->>'status'='weekly'")).rows[0].n,0);
 await db.exec('update private.summary_settings set enabled=true');
 await db.query("select private.finance_weekly('2026-09-28T12:59:00Z')");
 assert.equal((await db.query<{n:number}>("select count(*)::int n from private.outbox where result->>'status'='weekly'")).rows[0].n,0);
 await db.query("select private.finance_weekly('2026-09-28T13:00:00Z')");await db.query("select private.finance_weekly('2026-09-28T14:00:00Z')");
 assert.equal((await db.query<{n:number}>("select count(*)::int n from private.outbox where result->>'status'='weekly'")).rows[0].n,1);
});

test('Cancelling invalidates old proposal confirmation buttons',async()=>{
 const p=await pro('act',{id:await event(),action:{command:'stage',proposal:{command:'summary',enabled:true}}});
 await pro('act',{id:await event(),action:{command:'cancel'}});
 assert.equal((await pro('act',{id:await event(),action:{command:'confirm',target:p.proposal_id}})).status,'clarify');
});
test('A transfer can reconcile once in each of its two accounts',async()=>{
 await core('apply',{id:await event(),action:{type:'account',name:'Ahorros',kind:'asset',owner:'101',amount:'0',date:'2026-09-27'}});
 const tx=await core('apply',{id:await event(),action:{type:'post',kind:'transfer',account:'Banco',other:'Ahorros',amount:'10000',date:'2026-09-27',scope:'family',payer:'101'}});
 for(const [account,delta] of [['Banco','-10000'],['Ahorros','10000']]){
  const imported=await pro('act',{id:await event(),action:{command:'statement',account,rows:[{date:'2026-09-27',delta,memo:'Transferencia'}]}});
  const result=await pro('act',{id:await event(),action:{command:'reconcile',target:imported.batch_id}});
  assert.ok(result.rows[0].candidates.some((c:any)=>c.id===tx.transaction_id));
  assert.equal((await pro('act',{id:await event(),action:{command:'match',line:result.rows[0].id,target:tx.transaction_id}})).status,'ok');
 }
});

test('Account creation preserves explicitly requested household owner',async()=>{
 const id=await event('101');await pro('act',{id,action:{command:'account',name:'Cuenta esposa',kind:'asset',owner:'202',amount:'0',date:'2026-09-27'}});
 assert.equal((await db.query<{owner:string}>("select owner from private.accounts where name='Cuenta esposa'")).rows[0].owner,'202');
});
test('Duplicate confirmation rejects a different actor and expired proposals',async()=>{
 const a={type:'post',kind:'expense',account:'Banco',amount:'12300',date:'2026-09-27',category:'Cafe',scope:'personal',payer:'101'};
 await core('apply',{id:await event(),action:a});const pending=await event();assert.equal((await core('apply',{id:pending,action:a})).status,'duplicate');
 await assert.rejects(core('apply',{id:await event('202'),action:{...a,confirm_duplicate:true,pending_event_id:String(pending)}}));
 await db.query("update private.events set created_at=now()-interval '49 hours' where id=$1",[pending]);
 await assert.rejects(core('apply',{id:await event('101'),action:{...a,confirm_duplicate:true,pending_event_id:String(pending)}}));
});

test('Pro database privileges deny public clients',async()=>{
 const rows=(await db.query<{ok:boolean}>("select not has_function_privilege('anon','public.finance_pro(text,jsonb)','execute') and not has_function_privilege('authenticated','public.finance_pro(text,jsonb)','execute') ok")).rows;
 assert.equal(rows[0].ok,true);
 await db.exec('set role anon');await assert.rejects(db.query('select * from private.preferences'));await db.exec('reset role');
});

test('Natural context exposes only own pending confirmations and reference names',async()=>{
 const p=await pro('act',{id:await event('101'),action:{command:'stage',proposal:{command:'summary',enabled:true}}});
 const id=await event('202');const result=(await db.query<{r:any}>("select public.finance_natural('context',$1::jsonb) r",[JSON.stringify({id})])).rows[0].r;
 assert.ok(!result.pending_proposals.some((x:any)=>x.id===p.proposal_id));assert.ok(Array.isArray(result.goals));
});

test('Creating an account does not close the parent expense conversation',async()=>{
 const id=await event('101',{replyTo:876543,messageId:876123});await pro('conversation',{id,text:'Gasté 63000 en almuerzo de ejemplo con Banco Alfa'});
 const proposal=await pro('act',{id,action:{command:'stage',proposal:{command:'account',name:'Banco Alfa test',kind:'asset',owner:'101',date:'2026-09-27',amount:'0',balance_known:false}}});
 const confirmation=await event('101',{replyTo:876123});
 await pro('conversation',{id:confirmation,text:'Confirmo'});
 await core('apply',{id:confirmation,action:{type:'pro',command:'confirm',target:proposal.proposal_id}});
 await pro('finish_conversation',{id:confirmation,answer:'Cuenta creada',close:true});
 const status=(await db.query<{state:string}>('select state from private.conversations where id=$1',[id])).rows[0];assert.equal(status.state,'open');
});
test('Unknown opening balance is explicit in balances and planning',async()=>{
 const report=await core('report',{from:'2026-09-01',to:'2026-09-30',scope:'all'});assert.equal(report.balances.find((a:any)=>a.name==='Banco Alfa test').balance_known,false);
 const plan=await pro('act',{id:await event(),action:{command:'planning',to:'2026-10-05'}});assert.ok(plan.planning.unknown_accounts.includes('Banco Alfa test'));
});

test('Registration status uses actual ledger and follow-up delivery retains context',async()=>{
 const parent=await event('101',{replyTo:93456,messageId:93457});await pro('conversation',{id:parent,text:'Gasto pendiente'});
 const created=await core('apply',{id:parent,action:{type:'pro',command:'account',name:'Pendiente status',kind:'asset',owner:'101',date:'2026-09-27',amount:'0',balance_known:false}});
 const status=(await db.query<{r:any}>("select public.finance_flow('status',$1::jsonb) r",[JSON.stringify({id:parent})])).rows[0].r;assert.equal(status.registered,false);
 await db.query("select public.finance_flow('resume_account',$1::jsonb)",[JSON.stringify({id:parent,message:'Cuenta creada. ¿Era personal o familiar?'})]);
 assert.match((await db.query<{m:string}>("select result->>'message' m from private.outbox where event_id=$1",[parent])).rows[0].m,/personal o familiar/);
});
test('Conversational explanations survive storage beyond the old 200 character cutoff',async()=>{
 const question='Me refiero a la deuda actual de la tarjeta, no al cupo máximo. '.repeat(5);
 const result=await core('apply',{id:await event(),action:{type:'clarify',question}});
 assert.equal(result.message,question);
});
const agent=async(op:string,data:any)=>(await db.query<{r:any}>('select public.finance_agent($1,$2::jsonb) r',[op,JSON.stringify(data)])).rows[0].r;
test('Draft persists outside conversation and isolates both spouses',async()=>{
 const id=await event();const d=await agent('draft_save',{id,draft_id:null,revision:null,fields:{kind:'expense',amount_cop:'63000',account:'Banco Alfa',memo:'almuerzo de ejemplo'}});
 assert.equal(d.draft.fields.amount_cop,'63000');
 await db.exec("update private.conversations set state='expired'");
 assert.ok((await agent('context',{id:await event()})).drafts.some((x:any)=>x.id===d.draft.id));
 assert.equal((await agent('context',{id:await event('202')})).drafts.length,0);
 await assert.rejects(agent('draft_save',{id:await event('202'),draft_id:d.draft.id,revision:1,fields:{amount_cop:'1'}}));
});
test('Draft retries are idempotent and stale changes are rejected',async()=>{
 const id=await event();const args={id,draft_id:null,revision:null,fields:{kind:'expense',amount_cop:'63000'}};
 const d=await agent('draft_save',args);assert.deepEqual(await agent('draft_save',args),d);
 const next=await event();const updated=await agent('draft_save',{id:next,draft_id:d.draft.id,revision:1,fields:{account:'Banco'}});
 assert.equal(updated.draft.revision,2);assert.equal(updated.draft.sources.account,next);
 await assert.rejects(agent('draft_save',{id:await event(),draft_id:d.draft.id,revision:1,fields:{amount_cop:'20'}}));
});
test('Account creation leaves pending expense intact and committed expense completes atomically',async()=>{
 const d=(await agent('draft_save',{id:await event(),fields:{kind:'expense',amount_cop:'63000',account:'Banco',scope:'family',payer:'101',date:'2026-09-28',category:'Comida',memo:'draft integration'}})).draft;
 await agent('apply',{id:await event(),action:{type:'pro',command:'stage',proposal:{command:'account',name:'Nueva',kind:'asset',owner:'101',amount:'0',balance_known:false,date:'2026-09-28'}}});
 assert.equal((await agent('draft_get',{id:await event(),draft_id:d.id})).draft.state,'pending');
 const id=await event();const action={type:'post',kind:'expense',amount:'6300000',account:'Banco',scope:'family',payer:'101',date:'2026-09-28',category:'Comida',memo:'draft integration',_draft_id:d.id,_draft_revision:d.revision};
 const r=await agent('apply',{id,action});assert.equal(r.status,'ok');
 assert.equal((await agent('draft_get',{id:await event(),draft_id:d.id})).draft.state,'completed');
 assert.deepEqual(await agent('apply',{id,action}),r);
 await assert.rejects(agent('apply',{id:await event(),action}));
});
test('A failed ledger write cannot complete a draft',async()=>{
 const d=(await agent('draft_save',{id:await event(),fields:{amount_cop:'100'}})).draft;
 await assert.rejects(agent('apply',{id:await event(),action:{type:'post',account:'Missing',amount:'10000',_draft_id:d.id,_draft_revision:d.revision}}));
 assert.equal((await agent('draft_get',{id:await event(),draft_id:d.id})).draft.state,'pending');
});
test('Narration can only annotate committed unsent receipts and preserves transaction identity',async()=>{
 const id=await event();await assert.rejects(agent('narrate',{id,text:'Guardado'}));
 const base=await agent('apply',{id,action:{type:'reminder',label:'Consultar deuda',date:'2026-10-01'}});
 const narrated=await agent('narrate',{id,text:'Te lo recordaré ese día.'});assert.equal(narrated.status,base.status);
 assert.equal(narrated.narration,'Te lo recordaré ese día.');
 assert.deepEqual(await agent('narrate',{id,text:'Otro texto'}),narrated);
});
test('Agent tables and RPC are inaccessible to public roles',async()=>{
 const rows=(await db.query<{name:string;rls:boolean}>("select relname name,relrowsecurity rls from pg_class join pg_namespace n on n.oid=relnamespace where n.nspname='private' and relname in ('agent_drafts','agent_draft_receipts','agent_traces')")).rows;
 assert.equal(rows.length,3);assert.ok(rows.every(x=>x.rls));
 const rights=(await db.query<{a:boolean;b:boolean}>("select has_function_privilege('anon','public.finance_agent(text,jsonb)','execute') a,has_function_privilege('authenticated','public.finance_agent(text,jsonb)','execute') b")).rows[0];assert.equal(rights.a,false);assert.equal(rights.b,false);
});
test('Unknown draft fields are rejected and cancellation cannot change the ledger',async()=>{
 await assert.rejects(agent('draft_save',{id:await event(),fields:{actor:'202'}}));
 const d=(await agent('draft_save',{id:await event(),fields:{memo:'cancel me'}})).draft;
 const before=(await db.query<{n:number}>('select count(*)::int n from private.transactions')).rows[0].n;
 await agent('draft_cancel',{id:await event(),draft_id:d.id,revision:d.revision});
 assert.equal((await agent('draft_get',{id:await event(),draft_id:d.id})).draft.state,'cancelled');
 assert.equal((await db.query<{n:number}>('select count(*)::int n from private.transactions')).rows[0].n,before);
});
test('SQL refuses action fields that diverge from its persisted draft',async()=>{
 const d=(await agent('draft_save',{id:await event(),fields:{kind:'expense',amount_cop:'63000',account:'Banco',scope:'family',payer:'101',date:'2026-09-28',category:'Comida',memo:'authoritative draft'}})).draft;
 await assert.rejects(agent('apply',{id:await event(),action:{type:'post',kind:'expense',amount:'100',account:'Banco',scope:'family',payer:'101',date:'2026-09-28',category:'Comida',memo:'authoritative draft',_draft_id:d.id,_draft_revision:d.revision}}));
 assert.equal((await agent('draft_get',{id:await event(),draft_id:d.id})).draft.state,'pending');
});
test('Duplicate confirmation completes its draft exactly once and stale buttons cannot post again',async()=>{
 const fields={kind:'expense',amount_cop:'8888',account:'Banco',scope:'family',payer:'101',date:'2026-09-28',category:'Comida',memo:'duplicate draft sequence'};
 const first={type:'post',kind:'expense',amount:'888800',account:'Banco',scope:'family',payer:'101',date:'2026-09-28',category:'Comida',memo:'duplicate draft sequence'};
 await agent('apply',{id:await event(),action:first});
 const d=(await agent('draft_save',{id:await event(),fields})).draft;
 const pendingId=await event();const action={...first,_draft_id:d.id,_draft_revision:d.revision};
 assert.equal((await agent('apply',{id:pendingId,action})).status,'duplicate');
 assert.equal((await agent('draft_get',{id:await event(),draft_id:d.id})).draft.state,'pending');
 const confirmId=await event();const confirmed={...action,confirm_duplicate:true,pending_event_id:pendingId};
 const result=await agent('apply',{id:confirmId,action:confirmed});assert.equal(result.status,'ok');
 assert.deepEqual(await agent('apply',{id:confirmId,action:confirmed}),result);
 await assert.rejects(agent('apply',{id:await event(),action:confirmed}));
});
test('Late narration cannot replace an already sent deterministic receipt',async()=>{
 const id=await event();const base=await agent('apply',{id,action:{type:'reminder',label:'Late narration test',date:'2026-10-01'}});
 const out=(await db.query<{id:number}>('select id from private.outbox where event_id=$1',[id])).rows[0];
 await core('sent',{id:out.id,telegram_message_id:987654});
 assert.deepEqual(await agent('narrate',{id,text:'Late generated response'}),base);
});
test('Read tools return ledger detail without settling event or caching a terminal pro action',async()=>{
 const id=await event();const tx=(await db.query<{id:number}>("select id::int from private.transactions where kind='expense' order by id limit 1")).rows[0];
 const detail=await agent('query',{id,action:{command:'detail',target:String(tx.id)}});assert.equal(detail.status,'detail');
 assert.equal((await db.query<{r:any}>('select result r from private.events where id=$1',[id])).rows[0].r,null);
 assert.equal((await db.query<{n:number}>('select count(*)::int n from private.pro_results where event_id=$1',[id])).rows[0].n,0);
});
const memory=async(op:string,data:any={})=>(await db.query<{r:any}>('select public.finance_memory($1,$2::jsonb) r',[op,JSON.stringify(data)])).rows[0].r;
const unitVector=(position=0)=>Array.from({length:384},(_,i)=>i===position?1:0);
test('Semantic memory isolates personal conversation even with identical embeddings',async()=>{
 const own=await event();await pro('conversation',{id:own,text:'Ahorro privado para comprar bicicleta'});
 const other=await event('202');await pro('conversation',{id:other,text:'Ahorro privado para comprar bicicleta'});
 await core('apply',{id:own,action:{type:'clarify',question:'Pendiente'}});
 await core('apply',{id:other,action:{type:'clarify',question:'Pendiente'}});
 await db.query("insert into private.memory_embeddings(key,source_hash,embedding) select key,md5(content),$1::extensions.vector from private.memory_sources where source_id in ($2,$3) and kind='conversation'",[JSON.stringify(unitVector()),String(own),String(other)]);
 const result=await memory('search',{id:own,query:'rodar',embedding:unitVector(),kind:'conversation'});
 assert.ok(result.matches.some((x:any)=>x.source_id===String(own)&&x.semantic_match&&!x.lexical_match));
 assert.ok(!result.matches.some((x:any)=>x.source_id===String(other)));
});
test('Reversed financial records disappear from semantic sources immediately',async()=>{
 const id=await event();const tx=await core('apply',{id,action:{type:'post',kind:'expense',amount:'765400',account:'Banco',payer:'101',scope:'family',date:'2026-09-28',category:'Mascotas',memo:'alimento felino semantico'}});
 assert.ok((await memory('search',{id,query:'felino',kind:'transaction'})).matches.some((x:any)=>x.source_id===String(tx.transaction_id)));
 await core('apply',{id:await event(),action:{type:'reverse',target:String(tx.transaction_id),reason:'test'}});
 assert.ok(!(await memory('search',{id,query:'felino',kind:'transaction'})).matches.some((x:any)=>x.source_id===String(tx.transaction_id)));
});
test('Indexer requires a live lease and rejects stale source content',async()=>{
 const jobs=await memory('next');assert.ok(jobs.length>0);
 const j=jobs[0];assert.equal((await memory('store',{key:j.key,hash:'incorrect',lease:j.lease,embedding:unitVector()})).stored,false);
 assert.equal((await memory('store',{key:j.key,hash:j.hash,lease:'wrong',embedding:unitVector()})).stored,false);
 assert.equal((await memory('store',{key:j.key,hash:j.hash,lease:j.lease,embedding:unitVector()})).stored,true);
 assert.equal((await memory('store',{key:j.key,hash:j.hash,lease:j.lease,embedding:unitVector()})).stored,false);
});

test('Memory RPC and index are closed to anonymous and authenticated roles',async()=>{
 for(const role of ['anon','authenticated']){
  const result=await db.query<{allowed:boolean}>("select has_function_privilege($1,'public.finance_memory(text,jsonb)','EXECUTE') allowed",[role]);
  assert.equal(result.rows[0].allowed,false);
 }
 await assert.rejects(memory('store',{embedding:null}));
});

test('Memory functions work under the actual server role',async()=>{
 await db.exec('set role service_role');
 try{const status=await memory('status');assert.ok(status.sources>0);await memory('next');}
 finally{await db.exec('reset role');}
});
test('Decimal drafts reach ledger with exact cents and reject third decimals',async()=>{
 const saved=await agent('draft_save',{id:await event(),fields:{kind:'expense',amount_cop:'123.19',account:'Banco',payer:'101',scope:'family',date:'2026-09-28',category:'Comida',memo:'decimal exacto'}});
 const d=saved.draft;const result=await agent('apply',{id:await event(),action:{type:'post',kind:'expense',amount:'12319',account:'Banco',payer:'101',scope:'family',date:'2026-09-28',category:'Comida',memo:'decimal exacto',_draft_id:d.id,_draft_revision:d.revision}});
 assert.equal(result.receipt.amount,'12319');
 const invalid=await agent('draft_save',{id:await event(),fields:{...d.fields,amount_cop:'123.199'}});
 await assert.rejects(agent('apply',{id:await event(),action:{type:'post',...d.fields,amount:'12320',_draft_id:invalid.draft.id,_draft_revision:invalid.draft.revision}}));
});
test('Unknown opening balance completion is confirmed, exact, balanced and idempotent',async()=>{
 const action={command:'opening_balance',account:'Banco Alfa test',amount:'25013',date:'2026-09-27'};
 await assert.rejects(pro('act',{id:await event(),action}));
 const p=await pro('act',{id:await event(),action:{command:'stage',proposal:action}});
 assert.equal((await pro('act',{id:await event('202'),action:{command:'confirm',target:p.proposal_id}})).status,'clarify');
 const id=await event();const r=await pro('act',{id,action:{command:'confirm',target:p.proposal_id}});
 assert.equal(r.opening_completed,true);assert.equal(r.opening_amount,'25013');
 assert.deepEqual(await pro('act',{id,action:{command:'confirm',target:p.proposal_id}}),r);
 const balance=(await core('report',{from:'2026-09-01',to:'2026-09-30',scope:'all'})).balances.find((a:any)=>a.name==='Banco Alfa test');assert.equal(balance.balance_known,true);
 const row=(await db.query<{amount:string;net:string}>("select sum(delta)::text net,sum(delta) filter(where ac.name='Banco Alfa test')::text amount from private.entries e join private.accounts ac on ac.id=e.account_id where transaction_id=$1",[r.transaction_id])).rows[0];assert.equal(row.amount,'25013');assert.equal(row.net,'0');
 const again=await pro('act',{id:await event(),action:{command:'stage',proposal:action}});await assert.rejects(pro('act',{id:await event(),action:{command:'confirm',target:again.proposal_id}}));
 await core('apply',{id:await event(),action:{type:'reverse',target:String(r.transaction_id),reason:'Corregir apertura'}});
 assert.equal((await db.query<{known:boolean}>("select balance_known known from private.accounts where name='Banco Alfa test'")).rows[0].known,false);
});
test('Opening completion handles debt, zero, owner permissions and historical cutoffs',async()=>{
 async function create(name:string,kind='asset'){await pro('act',{id:await event(),action:{command:'account',name,kind,owner:'101',amount:'0',balance_known:false,date:'2026-08-01'}});}
 async function stage(account:string,amount:string,date='2026-09-28',actor='101'){return pro('act',{id:await event(actor),action:{command:'stage',proposal:{command:'opening_balance',account,amount,date}}});}
 for(const [account,amount,kind] of [['Tarjeta Alfa pendiente','123456789','liability'],['Cero pendiente','0','asset']]){
  await create(account,kind);const p=await stage(account,amount);const r=await pro('act',{id:await event(),action:{command:'confirm',target:p.proposal_id}});assert.equal(r.opening_amount,amount);
  const sum=(await db.query<{n:string}>('select coalesce(sum(e.delta),0)::text n from private.entries e join private.accounts ac on ac.id=e.account_id where ac.name=$1',[account])).rows[0].n;assert.equal(sum,kind==='liability'?'-'+amount:amount);
 }
 const review=(await db.query<{r:any}>("select public.finance_routines('review',$1::jsonb) r",[JSON.stringify({id:await event(),month:'2026-08-01'})])).rows[0].r;
 assert.ok(JSON.stringify(review).includes('Tarjeta Alfa pendiente')); // inspect precise historical anchor below
 const accounts=review.accounts??review.review?.accounts;assert.ok(accounts);assert.equal(accounts.find((a:any)=>a.name==='Tarjeta Alfa pendiente').balance_known,false);
 await create('Saldo protegido');let p=await stage('Saldo protegido','100','2026-09-28','202');await assert.rejects(pro('act',{id:await event('202'),action:{command:'confirm',target:p.proposal_id}}));
 await core('apply',{id:await event(),action:{type:'post',kind:'expense',account:'Saldo protegido',amount:'100',date:'2026-09-27',category:'Comida',scope:'family',payer:'101'}});
 p=await stage('Saldo protegido','100');await assert.rejects(pro('act',{id:await event(),action:{command:'confirm',target:p.proposal_id}}));
 await db.exec('set role service_role');try{p=await stage('Saldo protegido','200','2026-09-26');const r=await pro('act',{id:await event(),action:{command:'confirm',target:p.proposal_id}});assert.equal(r.opening_completed,true);}finally{await db.exec('reset role');}
});
test('Pockets link to parent and transfer without changing income, expense or combined money',async()=>{
 const before=await core('report',{from:'2026-09-01',to:'2026-09-30',scope:'all'});
 const proposal=await pro('act',{id:await event(),action:{command:'stage',proposal:{command:'pocket',account:'Banco',name:'Emergencias',amount:'140034',date:'2026-09-28'}}});
 const confirmed=await pro('act',{id:await event(),action:{command:'confirm',target:proposal.proposal_id}});assert.equal(confirmed.pocket_created,true);
 const ctx=await core('context');assert.equal(ctx.accounts.find((a:any)=>a.name==='Banco · Emergencias').parent_account,'Banco');
 const report=await core('report',{from:'2026-09-01',to:'2026-09-30',scope:'all'});assert.equal(report.income,before.income);assert.equal(report.expense,before.expense);
 const group=report.pocket_groups.find((g:any)=>g.account==='Banco');assert.equal(group.pockets_total,'140034');assert.equal(BigInt(group.total),BigInt(group.available)+140034n);
 await core('apply',{id:await event(),action:{type:'post',kind:'transfer',account:'Banco',other:'Banco · Emergencias',amount:'10000',date:'2026-09-28',payer:'101',scope:'family'}});
 const after=await core('report',{from:'2026-09-01',to:'2026-09-30',scope:'all'});const moved=after.pocket_groups.find((g:any)=>g.account==='Banco');assert.equal(moved.total,group.total);assert.equal(moved.pockets_total,'150034');assert.equal(after.expense,before.expense);assert.equal(after.income,before.income);
 const repeat=await pro('act',{id:await event(),action:{command:'stage',proposal:{command:'pocket',account:'Banco',name:'emergencias',amount:'140034',date:'2026-09-28'}}});await assert.rejects(pro('act',{id:await event(),action:{command:'confirm',target:repeat.proposal_id}}));
 for(const [actor,account] of [['202','Banco'],['101','Banco · Emergencias']]){
  const p=await pro('act',{id:await event(actor),action:{command:'stage',proposal:{command:'pocket',account,name:'Invalid',amount:'0',date:'2026-09-28'}}});await assert.rejects(pro('act',{id:await event(actor),action:{command:'confirm',target:p.proposal_id}}));
 }
 await assert.rejects(pro('act',{id:await event(),action:{command:'pocket',account:'Banco',name:'Bypass',amount:'1',date:'2026-09-28'}}));
});
