import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {vector} from '@electric-sql/pglite-pgvector';
import {readFileSync,readdirSync} from 'node:fs';
import {dispatchTool} from '../supabase/functions/_shared/agent-tools.ts';
const db=new PGlite({extensions:{vector}});
const core=async(op:string,data:any={})=>(await db.query<{r:any}>('select public.finance_api($1,$2::jsonb) r',[op,JSON.stringify(data)])).rows[0].r;
const agent=async(op:string,data:any={})=>(await db.query<{r:any}>('select public.finance_agent($1,$2::jsonb) r',[op,JSON.stringify(data)])).rows[0].r;
const pro=async(op:string,data:any={})=>(await db.query<{r:any}>('select public.finance_pro($1,$2::jsonb) r',[op,JSON.stringify(data)])).rows[0].r;
const flow=async(op:string,data:any={})=>(await db.query<{r:any}>('select public.finance_flow($1,$2::jsonb) r',[op,JSON.stringify(data)])).rows[0].r;
let seq=20000;
async function event(actor='101'){const id=seq++;await core('ingest',{update_id:id,actor,name:actor,group:'-100123',payload:{}});return id;}
const fields=(memo:string,amount_cop='88003')=>({kind:'expense',amount_cop,account:'Banco Beta',payer:'101',scope:'personal',date:'2026-09-30',memo});
const snapshot=async()=>(await db.query<{r:any}>("select jsonb_build_object('transactions',(select count(*) from private.transactions),'entries',(select count(*) from private.entries),'balances',(select jsonb_agg(x order by x.account_id) from (select account_id,sum(delta)::text amount from private.entries group by account_id) x)) r")).rows[0].r;
before(async()=>{await db.exec('create role anon; create role authenticated; create role service_role bypassrls; create schema vault; create table vault.decrypted_secrets(name text, decrypted_secret text); grant usage on schema vault to service_role; grant select on vault.decrypted_secrets to service_role;');for(const f of readdirSync('supabase/migrations').filter(f=>!f.endsWith('_worker_schedule.sql')).sort())await db.exec(readFileSync('supabase/migrations/'+f,'utf8'));await core('init',{group:'-100123'});await event('202');});
after(()=>db.close());

test('Several payments in one message survive atomically, retry without duplication and remain private',async()=>{
 const id=await event();const data={id,items:[{item_key:'claro',fields:fields('Claro móvil')},{item_key:'ibis',fields:{...fields('Ibis Bravo','350000'),category:'Donación'}}]};
 const before=await snapshot();const result=await agent('drafts_save',data);
 assert.equal(result.drafts.length,2);assert.equal(result.drafts[0].fields.category,'Por clasificar');assert.equal(result.drafts[1].fields.category,'Donación');
 assert.deepEqual(await agent('drafts_save',data),result);
 assert.deepEqual(await snapshot(),before);
 assert.equal((await agent('context',{id:await event('202')})).drafts.length,0);
 const bad={id:await event(),items:[{item_key:'good',fields:fields('Rollback')},{item_key:'bad',fields:{actor:'202'}}]};
 await assert.rejects(agent('drafts_save',bad));assert.equal((await db.query<{n:number}>('select count(*)::int n from private.agent_drafts where origin_event=$1',[bad.id])).rows[0].n,0);
 await assert.rejects(agent('drafts_save',{id,items:[{item_key:'claro',fields:fields('Changed intent','1')}]}));
});

test('Updating a legacy uncategorized draft has a stable retry receipt',async()=>{
 const d=(await agent('draft_save',{id:await event(),fields:fields('Legacy category')})).draft;
 await db.query("update private.agent_drafts set fields=fields-'category' where id=$1",[d.id]);
 const id=await event();const args={id,draft_id:d.id,revision:d.revision,fields:{scope:'family'}};
 const updated=await agent('draft_save',args);assert.equal(updated.draft.fields.category,'Por clasificar');
 assert.deepEqual(await agent('draft_save',args),updated);
 assert.equal((await agent('draft_get',{id:await event(),draft_id:d.id})).draft.revision,d.revision+1);
});

test('Salary already used as opening balance is exposed as a conflict and cannot be posted twice',async()=>{
 const d=(await agent('draft_save',{id:await event(),fields:{...fields('Sueldo','2468100'),kind:'income',category:'Salario'}})).draft;
 await core('apply',{id:await event(),action:{type:'account',name:'Banco Beta',kind:'asset',owner:'101',amount:'246810000',date:'2026-09-30'}});
 const loaded=(await agent('draft_get',{id:await event(),draft_id:d.id})).draft;
 assert.equal(loaded.issues[0].code,'opening_overlap');assert.equal(loaded.issues[0].amount_cents,'246810000');
 const before=await snapshot();const action={type:'post',...d.fields,amount:'246810000',_draft_id:d.id,_draft_revision:d.revision};
 const id=await event();const result=await agent('apply',{id,action});assert.equal(result.status,'clarify');assert.match(result.message,/saldo inicial/);
 assert.deepEqual(await agent('apply',{id,action}),result);assert.deepEqual(await snapshot(),before);
 assert.equal((await agent('draft_get',{id:await event(),draft_id:d.id})).draft.state,'pending');
});

test('An income described after opening is not falsely treated as the same money',async()=>{
 const d=(await agent('draft_save',{id:await event(),fields:{...fields('Nuevo ingreso','2468100'),kind:'income',category:'Salario'}})).draft;
 assert.deepEqual((await agent('draft_get',{id:await event(),draft_id:d.id})).draft.issues,[]);
});

test('Explicit additional income can resolve an opening warning with audit, ownership and revision checks',async()=>{
 const d=(await agent('draft_save',{id:await event(),fields:{...fields('Otro ingreso','321.19'),kind:'income',account:'Extra',category:'Otros ingresos'}})).draft;
 const opening=await core('apply',{id:await event(),action:{type:'account',name:'Extra',kind:'asset',owner:'101',amount:'32119',date:'2026-09-30'}});
 const args={draft_id:d.id,revision:d.revision,opening_transaction_id:String(opening.transaction_id)};
 await assert.rejects(agent('draft_distinct_income',{id:await event('202'),...args}));
 await assert.rejects(agent('draft_distinct_income',{id:await event(),...args,opening_transaction_id:'1'}));
 const before=await snapshot();const id=await event();const ctx={...(await core('context')),actor:'101',event_id:id};
 const result=await dispatchTool('distinguir_ingreso_adicional',args,ctx,async(_op,data)=>agent('draft_distinct_income',data));
 assert.deepEqual(result.result.draft.issues,[]);assert.equal(result.result.draft.revision,d.revision+1);
 assert.deepEqual((await agent('draft_distinct_income',{id,...args})).draft,result.result.draft);
 assert.deepEqual(await snapshot(),before);
 await assert.rejects(agent('draft_distinct_income',{id:await event(),...args}));
 const fresh=result.result.draft;const posted=await dispatchTool('registrar_movimiento',{draft_id:fresh.id,revision:fresh.revision},{...ctx,event_id:await event()},async(_op,data)=>agent('draft_get',data));
 assert.equal((await agent('apply',{id:await event(),action:posted.action})).status,'ok');
 assert.equal((await db.query<{n:number}>("select count(*)::int n from private.pro_audit where operation='draft_distinct_income'")).rows[0].n,1);
});

test('Multiple open conversations retain the latest exchange and explicit replies retain their original thread',async()=>{
 const first=await event();const a=await pro('conversation',{id:first,text:'¿Dónde recibiste el sueldo?',force_new:true});
 const second=await event();const b=await pro('conversation',{id:second,text:'¿El gasto fue personal o familiar?',force_new:true});
 const c=await pro('conversation',{id:await event(),text:'Personal'});
 assert.equal(c.session,b.session);assert.equal(c.ambiguous,undefined);assert.ok(c.turns.some((t:any)=>t.text==='¿El gasto fue personal o familiar?'));
 await db.query('update private.events set message_id=777 where id=$1',[first]);
 const reply=await event();await db.query("update private.events set payload=jsonb_build_object('replyTo',777) where id=$1",[reply]);
 assert.equal((await pro('conversation',{id:reply,text:'Banco Beta'})).session,a.session);
 const next=await pro('conversation',{id:await event(),text:'Sí'});assert.equal(next.session,a.session);
 assert.ok(next.other_sessions.every((s:any)=>s.actor===undefined||s.actor==='101'));
});

test('Draft guide reuses known facts, separates registered payments and catches invalid debt counterpart',async()=>{
 const d=(await agent('draft_save',{id:await event(),fields:{...fields('Pago adelanto','123450'),kind:'repayment',other:'Banco Beta'}})).draft;
 const context={...(await core('context')),...(await agent('context',{id:await event()})),actor:'101',event_id:await event()};
 const outcome=await dispatchTool('consultar_borradores',{},context,async(_op,data)=>agent('context',data));
 const pending=outcome.result.conversation_guide.pending.find((x:any)=>x.draft_id===d.id);
 assert.equal(pending.known.account,'Banco Beta');assert.deepEqual(pending.missing_fields,[]);assert.equal(pending.blockers[0].code,'same_account');assert.equal(pending.ready,false);
 await assert.rejects(agent('draft_get',{id:await event('202'),draft_id:d.id}));
});

test('A group of complete payments posts once with exact cents; invalid or duplicate groups roll back',async()=>{
 const saved=await agent('drafts_save',{id:await event(),items:[{item_key:'a',fields:fields('Pago conjunto A','123.19')},{item_key:'b',fields:fields('Pago conjunto B','456.78')}]});
 const ctx={...(await core('context')),actor:'101',event_id:await event()};
 await pro('conversation',{id:ctx.event_id,text:'Registra ambos pagos',force_new:true});
 const args={drafts:saved.drafts.map((d:any)=>({draft_id:d.id,revision:d.revision}))};
 const {action}=await dispatchTool('registrar_movimientos',args,ctx,async(_op,data)=>agent('draft_get',data));
 const data={id:ctx.event_id,action};const before=await snapshot();const result=await agent('apply',data);
 assert.equal(result.status,'ok');assert.equal(result.receipts.length,2);assert.equal(result.receipts[0].receipt.amount,'12319');
 assert.deepEqual(await agent('apply',data),result);
 const after=await snapshot();assert.equal(after.transactions,before.transactions+2);assert.equal(after.entries,before.entries+4);
 const follow=await event();await pro('conversation',{id:follow,text:'¿Quedaron registrados?'});
 const status=await flow('status',{id:follow});assert.equal(status.registered,true);assert.equal(status.transaction_ids.length,2);
 assert.deepEqual(status.transaction_ids.map(String).sort(),result.receipts.map((r:any)=>String(r.transaction_id)).sort());
 for(const d of saved.drafts)assert.equal((await agent('draft_get',{id:await event(),draft_id:d.id})).draft.state,'completed');
 const fresh=await agent('drafts_save',{id:await event(),items:[{item_key:'new',fields:fields('Should roll back','5.01')},{item_key:'dupe',fields:fields('Pago conjunto A','123.19')}]});
 const next=await event();const second=await dispatchTool('registrar_movimientos',{drafts:fresh.drafts.map((d:any)=>({draft_id:d.id,revision:d.revision}))},{...ctx,event_id:next},async(_op,data)=>agent('draft_get',data));
 assert.equal((await agent('apply',{id:next,action:second.action})).status,'clarify');assert.deepEqual(await snapshot(),after);
 for(const d of fresh.drafts)assert.equal((await agent('draft_get',{id:await event(),draft_id:d.id})).draft.state,'pending');
 const foreignAction={...action,items:action.items.map((a:any)=>({...a,_draft_revision:a._draft_revision+1}))};
 await assert.rejects(agent('apply',{id:await event('202'),action:foreignAction}));assert.deepEqual(await snapshot(),after);
});
