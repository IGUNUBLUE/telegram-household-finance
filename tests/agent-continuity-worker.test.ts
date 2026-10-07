import {test} from 'node:test';import assert from 'node:assert/strict';
import {workerDatabase} from './fixtures/worker-database.ts';
import {createWorkerEngine,type WorkerIO} from '../supabase/functions/_shared/worker-engine.ts';
import {dispatchTool} from '../supabase/functions/_shared/agent-tools.ts';
const io=(f:Awaited<ReturnType<typeof workerDatabase>>,extra:Partial<WorkerIO>):WorkerIO=>({rpc:f.rpc,getConfig:()=>'-100123',canClaim:async()=>true,log:()=>{},today:()=> '2026-10-03',transcribe:async()=>'',narrate:async()=>'',interpret:async()=>({type:'clarify',question:'Consulta sintética'}),telegram:async()=>({message_id:43}),telegramDocument:async()=>({message_id:43}),...extra});

test('incomplete linked account confirmation persists the same focus even if narration is unavailable',async()=>{
 const f=await workerDatabase();try{
  const seed=await f.ingest({text:'Cuenta y gasto sintéticos'});const lease=await f.rpc('queue:claim');await f.rpc('pro:conversation',{id:seed.id,text:'Cuenta y gasto sintéticos'});
  const d=(await f.rpc('agent:draft_save',{id:seed.id,fields:{kind:'expense',account:'Cuenta ficticia',amount_cop:'9.13',payer:'101',date:'2026-10-03',memo:'Compra ficticia'}})).draft;
  const c={...await f.rpc('worker:context',{id:seed.id}),actor:'101',event_id:seed.id};
  const stage=await dispatchTool('preparar_cuenta',{name:'Cuenta ficticia',kind:'asset',owner:'101',date:'2026-10-03',balance_known:true,amount_cop:'0',drafts:[{draft_id:d.id,revision:d.revision}]},c,f.rpc);
  const preview=await f.rpc('agent:apply',{id:seed.id,action:stage.action});await f.rpc('queue:finish',{id:seed.id,token:lease.turn_token});
  await f.ingest({callback:'pconfirm:'+preview.proposal_id,text:''});let narrative=0;
  const worker=createWorkerEngine(io(f,{narrate:async(_r,context)=>{narrative++;assert.deepEqual(context.turn_focus.draft_ids,[d.id]);throw Error('Synthetic model unavailable');}}));
  await worker.processOne();assert.equal(narrative,1);
  const next=await f.ingest({text:'Personal'});const conversation=await f.rpc('pro:conversation',{id:next.id,text:'Personal'});assert.deepEqual(conversation.previous_draft_ids,[d.id]);
  assert.equal((await f.rpc('agent:draft_get',{id:next.id,draft_id:d.id})).draft.state,'pending');
 }finally{await f.db.close();}
});

test('standalone account creation does not resume an older draft sharing the account name',async()=>{
 const f=await workerDatabase();try{
  const old=await f.ingest({text:'Pendiente antiguo'});await f.rpc('queue:claim');const d=(await f.rpc('agent:draft_save',{id:old.id,fields:{memo:'Pendiente antiguo',account:'Cuenta ficticia'}})).draft;
  await f.rpc('agent:apply',{id:old.id,action:{type:'clarify',question:'Faltan datos'}});
  const token=(await f.db.query<any>('select turn_token from private.events where id=$1',[old.id])).rows[0].turn_token;await f.rpc('queue:finish',{id:old.id,token});
  await f.ingest({text:'Crea únicamente la cuenta'});let narrations=0;
  await createWorkerEngine(io(f,{interpret:async()=>({type:'pro',command:'account',name:'Cuenta ficticia',kind:'asset',owner:'101',amount:'0',date:'2026-10-03'}),narrate:async()=>{narrations++;return 'No debería retomar el pendiente';}})).processOne();
  assert.equal(narrations,0);assert.equal((await f.db.query<any>('select state from private.agent_drafts where id=$1',[d.id])).rows[0].state,'pending');
 }finally{await f.db.close();}
});

test('current multi-operation request preserves and narrates a newly created pending item after posting another',async()=>{
 const f=await workerDatabase();try{
  await f.rpc('agent:apply',{id:(await f.ingest({})).id,action:{type:'account',name:'Banco ficticio',kind:'asset',owner:'101',amount:'0',date:'2026-10-03'}});
  await f.ingest({text:'Dos operaciones ficticias'});let pendingId='',narrations=0;
  const worker=createWorkerEngine(io(f,{interpret:async(_input,c)=>{
   const common={kind:'expense',amount_cop:'12.19',account:'Banco ficticio',payer:'101',date:'2026-10-03'};
   const saved=await dispatchTool('actualizar_asuntos',{items:[{item_key:'one',fields:{...common,scope:'personal',beneficiary:'101',memo:'Pedido actual completo'}},{item_key:'two',fields:{...common,amount_cop:'19.23',memo:'Pedido actual incompleto'}}]},c,f.rpc);
   const [first,second]=saved.result.drafts;pendingId=second.id;return (await dispatchTool('registrar_movimiento',{draft_id:first.id,revision:first.revision},c,f.rpc)).action;
  },narrate:async(_r,c)=>{narrations++;assert.equal(c.drafts.length,1);assert.equal(c.drafts[0].id,pendingId);return '¿El segundo gasto fue personal o familiar?';}}));
  await worker.processOne();assert.equal(narrations,1);
  const next=await f.ingest({text:'Familiar'});const conversation=await f.rpc('pro:conversation',{id:next.id,text:'Familiar'});assert.deepEqual(conversation.previous_draft_ids,[pendingId]);
  assert.equal((await f.db.query<any>("select count(*)::int n from private.transactions where kind='expense'")).rows[0].n,1);
 }finally{await f.db.close();}
});

test('precommit RPC failure recovers current focus from saved event provenance without repeating interpretation or posting',async()=>{
 const f=await workerDatabase();try{
  await f.rpc('agent:apply',{id:(await f.ingest({})).id,action:{type:'account',name:'Banco ficticio',kind:'asset',owner:'101',amount:'0',date:'2026-10-03'}});
  const event=await f.ingest({text:'Dos operaciones con reintento'});let pendingId='',interpretations=0,narrations=0,fail=true;
  const worker=createWorkerEngine(io(f,{rpc:async(op,data:any={})=>{if(op==='agent:apply'&&data.id===event.id&&fail){fail=false;throw Error('Synthetic precommit outage');}return f.rpc(op,data);},interpret:async(_input,c)=>{
   interpretations++;const common={kind:'expense',amount_cop:'12.19',account:'Banco ficticio',payer:'101',date:'2026-10-03'};
   const saved=await dispatchTool('actualizar_asuntos',{items:[{item_key:'one',fields:{...common,scope:'personal',beneficiary:'101',memo:'Completo'}},{item_key:'two',fields:{...common,amount_cop:'19.23',memo:'Incompleto'}}]},c,f.rpc);
   const [first,second]=saved.result.drafts;pendingId=second.id;return (await dispatchTool('registrar_movimiento',{draft_id:first.id,revision:first.revision},c,f.rpc)).action;
  },narrate:async(_r,c)=>{narrations++;assert.equal(c.drafts[0].id,pendingId);return '¿Personal o familiar?';}}));
  await worker.processOne();assert.equal((await f.db.query<any>("select count(*)::int n from private.transactions where kind='expense'")).rows[0].n,0);
  await worker.processOne();assert.equal(interpretations,1);assert.equal(narrations,1);
  assert.equal((await f.db.query<any>("select count(*)::int n from private.transactions where kind='expense'")).rows[0].n,1);
  const next=await f.ingest({text:'Personal'});assert.deepEqual((await f.rpc('pro:conversation',{id:next.id,text:'Personal'})).previous_draft_ids,[pendingId]);
 }finally{await f.db.close();}
});
