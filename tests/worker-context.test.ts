import {test} from 'node:test';
import assert from 'node:assert/strict';
import {workerDatabase} from './fixtures/worker-database.ts';
import {createWorkerEngine,type WorkerIO} from '../supabase/functions/_shared/worker-engine.ts';

const ledger=async(f:Awaited<ReturnType<typeof workerDatabase>>)=>(await f.db.query<{value:unknown}>("select jsonb_build_object('transactions',(select coalesce(jsonb_agg(to_jsonb(t) order by id),'[]') from private.transactions t),'entries',(select coalesce(jsonb_agg(to_jsonb(e) order by id),'[]') from private.entries e),'drafts',(select coalesce(jsonb_agg(to_jsonb(d) order by id),'[]') from private.agent_drafts d),'turns',(select coalesce(jsonb_agg(to_jsonb(c) order by event_id),'[]') from private.conversation_turns c)) value")).rows[0].value;

test('batched context preserves all legacy fields, merge precedence and actor-owned pending items',async()=>{
 const f=await workerDatabase();try{
  const opening=await f.ingest({text:'Cuenta ficticia'});
  await f.rpc('agent:apply',{id:opening.id,action:{type:'account',name:'Principal prueba',kind:'asset',owner:'101',amount:'25013',date:'2026-10-02'}});
  const first=await f.ingest({text:'Arriendo pendiente'});
  await f.rpc('agent:draft_save',{id:first.id,fields:{kind:'expense',memo:'Arriendo privado 101',amount_cop:'915000'}});
  const second=await f.rpc('ingest',{update_id:1001,actor:'202',name:'Otra persona',group:'-100123',payload:{actor:'202',text:'Otro pendiente'}});
  await f.rpc('agent:draft_save',{id:second.id,fields:{kind:'expense',memo:'Pendiente privado 202'}});
  await f.db.query("insert into private.preferences(actor,merchant,account,category,scope) values ('101','Tienda ficticia','Principal prueba','Mercado','family')");
  const snapshot=await ledger(f);
  for(const event of [first,second]){
   const data={id:event.id};
   const expected={...await f.rpc('context'),...await f.rpc('pro:context',data),...await f.rpc('natural:context',data),...await f.rpc('agent:context',data),...await f.rpc('routine:context',data)};
   const actual=await f.rpc('worker:context',{...data,actor:'forged',phase:'initial'});
   assert.deepEqual(actual,expected);
   assert.equal(actual.actor,event.id===first.id?'101':'202');
   assert.equal(actual.drafts.length,1);
   assert.equal(actual.drafts[0].fields.memo,event.id===first.id?'Arriendo privado 101':'Pendiente privado 202');
   if(event.id===first.id){assert.equal(actual.preferences[0].merchant,'Tienda ficticia');assert.equal(actual.accounts.find((a:any)=>a.name==='Principal prueba').owner,'101');}
   const refreshed=await f.rpc('worker:context',{...data,phase:'refresh'});
   assert.deepEqual(refreshed,{...await f.rpc('context'),...await f.rpc('agent:context',data)});
  }
  assert.deepEqual(await ledger(f),snapshot);
 }finally{await f.db.close();}
});

test('batched context denies client roles and rejects invalid event, operation and phase',async()=>{
 const f=await workerDatabase();try{
  const ev=await f.ingest({text:'Contexto ficticio'});
  for(const role of ['anon','authenticated']){
   await f.db.exec('set role '+role);
   await assert.rejects(f.rpc('worker:context',{id:ev.id}),/permission denied/);
   await f.db.exec('reset role');
  }
  await f.db.exec('set role service_role');
  assert.equal((await f.rpc('worker:context',{id:ev.id})).actor,'101');
  await assert.rejects(f.rpc('worker:context',{id:99999}),/unknown event/);
  await assert.rejects(f.rpc('worker:apply',{id:ev.id}),/unsupported context operation/);
  await assert.rejects(f.rpc('worker:context',{id:ev.id,phase:'arbitrary'}),/unsupported context phase/);
  await f.db.exec('reset role');
 }finally{await f.db.close();}
});

test('worker loads complete initial and fresh narration contexts in one request per phase',async()=>{
 const f=await workerDatabase();try{
  const pending=await f.ingest({text:'Pendiente ficticio'});await f.rpc('queue:claim');
  await f.rpc('agent:draft_save',{id:pending.id,fields:{memo:'Revisar un pendiente',account:'Nueva cuenta'}});
  await f.rpc('proposal',{id:pending.id,action:{type:'clarify',question:'Falta un dato'}});
  await f.rpc('agent:apply',{id:pending.id,action:{type:'clarify',question:'Falta un dato'}});
  await f.rpc('queue:finish',{id:pending.id,token:(await f.db.query<any>('select turn_token from private.events where id=$1',[pending.id])).rows[0].turn_token});
  const event=await f.ingest({text:'Crear cuenta ficticia'});
  const requests:{op:string;phase?:string}[]=[];let interpreted:any,refreshed:any;
  const io:WorkerIO={rpc:async(op,data:any={})=>{requests.push({op,phase:data.phase});return f.rpc(op,data);},getConfig:()=>'-100123',canClaim:async()=>true,log:()=>{},today:()=> '2026-10-02',transcribe:async()=>'',telegramDocument:async()=>({message_id:43}),telegram:async()=>({message_id:43}),interpret:async(input,context)=>{interpreted=context;context.turn_focus.draft_ids.push(context.drafts[0].id);return {type:'pro',command:'account',name:'Nueva cuenta',kind:'asset',owner:'101',amount:'25013',date:'2026-10-02'};},narrate:async(result,context)=>{refreshed=context;return 'La cuenta y el pendiente quedaron disponibles.';}};
  await createWorkerEngine(io).processOne();
  assert.equal(interpreted.actor,'101');assert.equal(interpreted.event_id,event.id);assert.ok(interpreted.event_attempt_token);assert.equal(interpreted.drafts[0].fields.memo,'Revisar un pendiente');assert.ok(interpreted.conversation.turns.some((t:any)=>t.text==='Crear cuenta ficticia'));
  assert.ok(refreshed.accounts.some((a:any)=>a.name==='Nueva cuenta'));assert.ok(refreshed.conversation);
  const contextOps=new Set(['context','pro:context','natural:context','agent:context','routine:context','worker:context']);
  assert.deepEqual(requests.filter(r=>contextOps.has(r.op)),[{op:'worker:context',phase:'initial'},{op:'worker:context',phase:'refresh'}]);
  assert.equal((await f.db.query<any>('select count(*)::int n from private.transactions')).rows[0].n,1);
 }finally{await f.db.close();}
});

test('failed batched context prevents model work and retries without duplicate ledger effects',async()=>{
 const f=await workerDatabase();try{
  const ev=await f.ingest({text:'Cuenta ficticia tras fallo de contexto'});let interpretations=0;
  const io:WorkerIO={rpc:f.rpc,getConfig:()=>'-100123',canClaim:async()=>true,log:()=>{},today:()=> '2026-10-02',transcribe:async()=>'',narrate:async()=>'',telegramDocument:async()=>({message_id:43}),telegram:async()=>({message_id:43}),interpret:async()=>{interpretations++;return {type:'account',name:'Una sola cuenta',kind:'asset',owner:'101',amount:'25013',date:'2026-10-02'};}};
  const engine=createWorkerEngine(io);
  await f.db.exec('alter function public.finance_routines(text,jsonb) rename to finance_routines_unavailable');
  await engine.processOne();
  assert.equal(interpretations,0);
  assert.equal((await f.db.query<any>('select count(*)::int n from private.transactions')).rows[0].n,0);
  assert.equal((await f.db.query<any>('select state from private.events where id=$1',[ev.id])).rows[0].state,'new');
  await f.db.exec('alter function public.finance_routines_unavailable(text,jsonb) rename to finance_routines');
  await engine.processOne();
  assert.equal(interpretations,1);
  assert.equal((await f.db.query<any>('select count(*)::int n from private.transactions')).rows[0].n,1);
 }finally{await f.db.close();}
});

test('HTTP RPC routes grouped context to the real backend function with intact input',async()=>{
 const f=await workerDatabase(),originalFetch=globalThis.fetch;
 const previousUrl=process.env.SUPABASE_URL,previousKey=process.env.SUPABASE_SERVICE_ROLE_KEY;
 try{
  process.env.SUPABASE_URL='https://fictional.invalid';process.env.SUPABASE_SERVICE_ROLE_KEY='fictional-key';
  const ev=await f.ingest({text:'Contexto por HTTP'});let path='';
  globalThis.fetch=async(input,init)=>{
   const url=new URL(String(input));path=url.pathname;
   const body=JSON.parse(String(init?.body));
   const endpoint=url.pathname.split('/').at(-1)!;
   assert.ok(['finance_api','finance_worker_context'].includes(endpoint));
   try{const r=await f.db.query<any>(`select public.${endpoint}($1,$2::jsonb) value`,[body.op,JSON.stringify(body.data)]);return Response.json(r.rows[0].value);}
   catch{return new Response('Backend failure',{status:500});}
  };
  const {rpc}=await import('../supabase/functions/_shared/io.ts');
  assert.equal((await rpc('worker:context',{id:ev.id,phase:'initial'})).actor,'101');
  assert.equal(path,'/rest/v1/rpc/finance_worker_context');
 }finally{globalThis.fetch=originalFetch;if(previousUrl===undefined)delete process.env.SUPABASE_URL;else process.env.SUPABASE_URL=previousUrl;if(previousKey===undefined)delete process.env.SUPABASE_SERVICE_ROLE_KEY;else process.env.SUPABASE_SERVICE_ROLE_KEY=previousKey;await f.db.close();}
});
