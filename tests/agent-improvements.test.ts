import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {workerDatabase} from './fixtures/worker-database.ts';
import {dispatchTool} from '../supabase/functions/_shared/agent-tools.ts';
import {conversationGuide} from '../supabase/functions/_shared/conversation-guide.ts';
import {needsNarration} from '../supabase/functions/_shared/worker-flow.ts';
import {normalizeAction,formatResult} from '../supabase/functions/_shared/domain.ts';
import {formatPro} from '../supabase/functions/_shared/pro.ts';

let f:Awaited<ReturnType<typeof workerDatabase>>;
before(async()=>{f=await workerDatabase();await f.rpc('agent:apply',{id:(await f.ingest({})).id,action:{type:'account',name:'Origen ficticio',kind:'asset',owner:'101',amount:'50000000',date:'2026-10-03'}});await f.rpc('ingest',{update_id:999,actor:'202',name:'Otra persona',group:'-100123',payload:{actor:'202'}});});
after(async()=>f.db.close());
const context=async()=>({...await f.rpc('worker:context',{id:(await f.ingest({})).id}),actor:'101',event_id:(await f.ingest({})).id,turn_focus:{draft_ids:[] as string[]}});
const snapshot=async()=>(await f.db.query<any>("select jsonb_build_object('transactions',(select count(*) from private.transactions),'entries',(select count(*) from private.entries),'accounts',(select count(*) from private.accounts)) value")).rows[0].value;
const fields=(account='Origen ficticio')=>({kind:'expense',amount_cop:'123.19',account,payer:'101',beneficiary:'101',scope:'personal',date:'2026-10-03',category:'Compras',memo:'Operación sintética'});

test('external counterparties persist separately from household identity, with exact cents and no extra members',async()=>{
 const c=await context();const before=await snapshot();
 const saved=await dispatchTool('actualizar_borrador',{fields:{...fields(),kind:'income',payer:undefined,counterparty:'Cliente externo ficticio'}},c,f.rpc);
 assert.equal(saved.result.draft.fields.payer,'101');assert.equal(saved.result.draft.fields.counterparty,'Cliente externo ficticio');
 const {action}=await dispatchTool('registrar_movimiento',{draft_id:saved.result.draft.id,revision:saved.result.draft.revision},c,f.rpc);
 const result=await f.rpc('agent:apply',{id:c.event_id,action});assert.equal(result.status,'ok');
 const row=(await f.db.query<any>('select payer,counterparty from private.transactions where id=$1',[result.transaction_id])).rows[0];assert.deepEqual(row,{payer:'101',counterparty:'Cliente externo ficticio'});
 assert.equal(result.receipt.counterparty,row.counterparty);assert.match(formatResult(result),/Cliente externo ficticio/);assert.equal(result.receipt.amount,'12319');
 assert.equal((await f.db.query<any>('select count(*)::int n from private.members')).rows[0].n,2);
 assert.deepEqual(await f.rpc('agent:apply',{id:c.event_id,action}),result);assert.equal((await snapshot()).transactions,before.transactions+1);
 assert.throws(()=>normalizeAction({...fields(),type:'post',payer:'999',counterparty:'Proveedor'},c),/Pagador desconocido/);
});

test('external-party changes cannot bypass stored draft versions or immutable accounting',async()=>{
 const c=await context();const d=(await f.rpc('agent:draft_save',{id:c.event_id,fields:{...fields(),counterparty:'Comercio ficticio'}})).draft;
 const action={...normalizeAction({...d.fields,type:'post'},c),_draft_id:d.id,_draft_revision:d.revision,counterparty:'Otra identidad'};
 const before=await snapshot();await assert.rejects(f.rpc('agent:apply',{id:c.event_id,action}),/differs/);assert.deepEqual(await snapshot(),before);
 await assert.rejects(f.rpc('agent:draft_save',{id:c.event_id,fields:{counterparty:'x'.repeat(121)}}));
});

test('focus retains all context while narrating only the current related pending operations',()=>{
 const background={id:'1',actor:'101',state:'pending',fields:{memo:'Un asunto antiguo'}};
 const active={id:'2',actor:'101',state:'pending',fields:{memo:'Operación actual'}};
 const c={actor:'101',drafts:[background,active],turn_focus:{draft_ids:['2']}};
 const guide=conversationGuide(c);assert.equal(guide.pending.length,2);assert.deepEqual(guide.active_pending.map((d:any)=>d.draft_id),['2']);assert.deepEqual(guide.background_pending.map((d:any)=>d.draft_id),['1']);
 const result={status:'ok',receipt:{amount:'12319'}};
 assert.equal(needsNarration(result,{...c,turn_focus:{draft_ids:[]}}),false);assert.equal(needsNarration(result,c),true);
 assert.equal(needsNarration(result,{...c,drafts:[background,{...active,state:'completed'}]}),false);
 assert.equal(needsNarration({status:'ok',account_created:true,account_name:'Destino ficticio'},{...c,turn_focus:{draft_ids:[]}}),false);
 assert.equal(needsNarration({status:'ok',account_created:true,account_name:'Destino ficticio'},{...c,drafts:[background,{...active,fields:{account:'Destino ficticio'}}],turn_focus:{draft_ids:[]}}),false);
 assert.equal(needsNarration({status:'ok',account_created:true,account_name:'Destino ficticio',linked_pending:['2']},{...c,drafts:[background,{...active,fields:{account:'Destino ficticio'}}],turn_focus:{draft_ids:[]}}),true);
});

test('read-only draft queries do not activate old work; mutating a draft marks its focus',async()=>{
 const c=await context();await dispatchTool('consultar_borradores',{},c,f.rpc);assert.deepEqual(c.turn_focus.draft_ids,[]);
 const outcome=await dispatchTool('actualizar_borrador',{fields:{memo:'Nuevo asunto sintético'}},c,f.rpc);assert.deepEqual(c.turn_focus.draft_ids,[outcome.result.draft.id]);
 assert.deepEqual(outcome.result.conversation_guide.active_pending.map((d:any)=>d.draft_id),c.turn_focus.draft_ids);
});

async function linked(name:string,kind='transfer',incomplete=false){
 const c=await context();const d=(await f.rpc('agent:draft_save',{id:c.event_id,fields:{...fields(kind==='transfer'?'Origen ficticio':name),kind,...kind==='transfer'?{other:name}:{},...incomplete?{scope:null}:{}}})).draft;
 const outcome=await dispatchTool('preparar_cuenta',{name,kind:'asset',owner:'101',date:'2026-10-03',balance_known:true,amount_cop:'0',drafts:[{draft_id:d.id,revision:d.revision}]},c,f.rpc);
 const preview=await f.rpc('agent:apply',{id:c.event_id,action:outcome.action});assert.match(formatPro(preview)!,/Operación sintética/);
 return {c,d,preview,action:outcome.action};
}

test('one account confirmation executes explicitly linked transfers, with retry deduplication',async()=>{
 const {d,preview}=await linked('Destino ficticio');const before=await snapshot();const id=(await f.ingest({})).id;
 const data={id,action:{type:'pro',command:'confirm',target:String(preview.proposal_id)}};const result=await f.rpc('agent:apply',data);
 assert.equal(result.status,'ok');assert.equal(result.account_created,true);assert.equal(result.receipts.length,1);assert.equal(result.receipts[0].receipt.other,'Destino ficticio');assert.equal(result.receipts[0].receipt.amount,'12319');
 assert.equal((await f.rpc('agent:draft_get',{id,draft_id:d.id})).draft.state,'completed');assert.deepEqual(await f.rpc('agent:apply',data),result);
 const next=await snapshot();assert.equal(next.transactions,before.transactions+2);assert.equal(next.entries,before.entries+2);assert.match(formatPro(result)!,/Destino ficticio/);
 const repeat=await f.rpc('agent:apply',{...data,id:(await f.ingest({})).id});assert.equal(repeat.status,'ok');assert.deepEqual(await snapshot(),next);
});

test('account prerequisites work for income and preserve incomplete expenses without registering them',async()=>{
 const income=await linked('Cuenta de cobros','income');let id=(await f.ingest({})).id;
 const result=await f.rpc('agent:apply',{id,action:{type:'pro',command:'confirm',target:String(income.preview.proposal_id)}});assert.equal(result.receipts[0].receipt.kind,'income');
 const expense=await linked('Cuenta incompleta','expense',true);id=(await f.ingest({})).id;
 const before=await snapshot();const pending=await f.rpc('agent:apply',{id,action:{type:'pro',command:'confirm',target:String(expense.preview.proposal_id)}});
 assert.equal(pending.account_created,true);assert.equal(pending.receipts,undefined);assert.deepEqual(pending.linked_pending,[expense.d.id]);assert.equal((await snapshot()).entries,before.entries);
 assert.equal((await f.rpc('agent:draft_get',{id,draft_id:expense.d.id})).draft.state,'pending');
});

test('changed linked drafts and foreign proposals cannot cause a partial account or movement',async()=>{
 const {c,d,preview}=await linked('Destino cambiado');const changed=(await f.ingest({})).id;
 await f.rpc('agent:draft_save',{id:changed,draft_id:d.id,revision:d.revision,fields:{amount_cop:'7'}});
 const before=await snapshot();const result=await f.rpc('agent:apply',{id:(await f.ingest({})).id,action:{type:'pro',command:'confirm',target:String(preview.proposal_id)}});
 assert.equal(result.status,'clarify');assert.deepEqual(await snapshot(),before);
 const foreign=await f.rpc('ingest',{update_id:1000,actor:'202',name:'Otra persona',group:'-100123',payload:{actor:'202'}});
 const denied=await f.rpc('agent:apply',{id:foreign.id,action:{type:'pro',command:'confirm',target:String(preview.proposal_id)}});assert.equal(denied.status,'clarify');assert.deepEqual(await snapshot(),before);
 await assert.rejects(dispatchTool('preparar_cuenta',{name:'Unrelated',kind:'asset',owner:'101',date:'2026-10-03',balance_known:true,amount_cop:'0',drafts:[{draft_id:d.id,revision:d.revision+1}]},{...c,event_id:(await f.ingest({})).id},f.rpc));
});

test('conversation focus survives separate messages, isolates actors, and drops completed work',async()=>{
 const c=await context();const session=await f.rpc('pro:conversation',{id:c.event_id,text:'Pedido sintético',force_new:true});
 const d=(await f.rpc('agent:draft_save',{id:c.event_id,fields:{memo:'Asunto activo persistido'}})).draft;
 await f.rpc('pro:finish_conversation',{id:c.event_id,answer:'Falta el importe',active_draft_ids:[d.id]});
 const next=(await f.ingest({})).id;const resumed=await f.rpc('pro:conversation',{id:next,text:'125 pesos'});
 assert.equal(resumed.session,session.session);assert.deepEqual(resumed.previous_draft_ids,[d.id]);
 const foreign=await f.rpc('ingest',{update_id:1002,actor:'202',name:'Otra persona',group:'-100123',payload:{actor:'202'}});
 await f.rpc('pro:conversation',{id:foreign.id,text:'Otro asunto',force_new:true});
 await assert.rejects(f.rpc('pro:finish_conversation',{id:foreign.id,answer:'No debe ver ese borrador',active_draft_ids:[d.id]}),/focus/i);
 await f.rpc('agent:draft_cancel',{id:next,draft_id:d.id,revision:d.revision});
 await f.rpc('pro:finish_conversation',{id:next,answer:'Descartado',active_draft_ids:[d.id]});
 const last=await f.rpc('pro:conversation',{id:(await f.ingest({})).id,text:'Otra consulta'});assert.deepEqual(last.previous_draft_ids,[]);
});

test('external counterparties are searchable and survive corrections and reversals',async()=>{
 const c=await context();const d=(await f.rpc('agent:draft_save',{id:c.event_id,fields:{...fields(),amount_cop:'987.43',memo:'Cobro sintético único',kind:'income',counterparty:'Empresa imaginaria'}})).draft;
 const {action}=await dispatchTool('registrar_movimiento',{draft_id:d.id,revision:d.revision},c,f.rpc);const posted=await f.rpc('agent:apply',{id:c.event_id,action});
 const search=await f.rpc('agent:search',{id:(await f.ingest({})).id,query:'Empresa imaginaria'});assert.equal(search.exists,true);assert.equal(search.movements[0].counterparty,'Empresa imaginaria');
 const staged=await f.rpc('agent:apply',{id:(await f.ingest({})).id,action:{type:'pro',command:'stage',proposal:{command:'correct',target:String(posted.transaction_id),field:'amount',value:'25019'}}});
 const corrected=await f.rpc('agent:apply',{id:(await f.ingest({})).id,action:{type:'pro',command:'confirm',target:String(staged.proposal_id)}});assert.equal(corrected.status,'ok');
 const rows=(await f.db.query<any>('select counterparty from private.transactions where id=$1 or reverses=$2',[corrected.transaction_id,posted.transaction_id])).rows;
 assert.equal(rows.length,2);assert.ok(rows.every((r:any)=>r.counterparty==='Empresa imaginaria'));
});
