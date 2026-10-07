import test from 'node:test';
import assert from 'node:assert/strict';
import {createOpenAI} from '@ai-sdk/openai';
import {runAgent} from '../supabase/functions/_shared/agent.ts';
import {call,message,response,providerFetch} from './fixtures/provider.ts';
const input=[{role:'user' as const,content:'¿Cuánto tenemos?'}];
const modelFor=(fetcher:typeof fetch)=>createOpenAI({apiKey:'synthetic-test-only',baseURL:'https://test.invalid/v1',fetch:fetcher}).responses('gpt-6-luna');

test('SDK agent continues a query with its result, private storage and bounded usage',async()=>{
 const transport=providerFetch([response([call('listar_cuentas',{})]),response([message('Banco Alfa está registrada.')])]);let reads=0;let metrics:any;
 const r=await runAgent({model:modelFor(transport.fetcher),instructions:'',messages:input,dispatch:async()=>{reads++;return {result:{accounts:['Banco Alfa']}};},onMetrics:m=>{metrics=m;}});
 assert.match(r.question,/Banco Alfa/);assert.equal(reads,1);assert.equal(transport.requests.length,2);
 assert.equal(transport.requests[0].body.store,false);assert.equal(transport.requests[0].body.parallel_tool_calls,false);assert.equal(transport.requests[0].body.max_output_tokens,1800);
 assert.ok(JSON.stringify(transport.requests[1].body.input).includes('Banco Alfa'));assert.equal(metrics.rounds,2);assert.equal(metrics.input_tokens,24);
});
test('SDK rejects simultaneous calls before executing either one',async()=>{
 const transport=providerFetch([response([call('listar_cuentas',{},'one'),call('consultar_borradores',{},'two')])]);let effects=0;
 await assert.rejects(runAgent({model:modelFor(transport.fetcher),instructions:'',messages:input,dispatch:async()=>{effects++;return {result:{}};}} as any),/simultáneas/);
 assert.equal(effects,0);
});
test('Multiple read-only queries can answer an account question without triggering the mutation guard',async()=>{
 const transport=providerFetch([response([call('listar_cuentas',{},'one'),call('buscar_movimientos',{account:'Banco Alfa'},'two')]),response([message('Banco Alfa tiene un ingreso registrado.')])]);let reads=0;
 const r=await runAgent({model:modelFor(transport.fetcher),instructions:'',messages:input,dispatch:async()=>{reads++;return {result:{movements:[{memo:'Sueldo'}]}};}});
 assert.equal(reads,2);assert.match(r.question,/ingreso/);
});
test('A query followed by a proposed write in the same response executes neither',async()=>{
 const transport=providerFetch([response([call('listar_cuentas',{},'one'),call('registrar_movimiento',{draft_id:'8',revision:2},'two')])]);let effects=0;
 await assert.rejects(runAgent({model:modelFor(transport.fetcher),instructions:'',messages:input,dispatch:async()=>{effects++;return {};}}),/simultáneas/);
 assert.equal(effects,0);
});
test('The last query round is reserved for answering from existing results',async()=>{
 const transport=providerFetch([response([call('listar_cuentas',{})]),response([call('listar_cuentas',{})]),response([call('listar_cuentas',{})]),response([call('listar_cuentas',{})]),response([message('El saldo registrado está explicado por los movimientos consultados.')])]);
 const r=await runAgent({model:modelFor(transport.fetcher),instructions:'',messages:input,dispatch:async()=>({result:{accounts:['Banco Alfa']}})});
 assert.match(r.question,/saldo registrado/);
 // Responses SDK omits tool_choice entirely when no tools are active.
 assert.notEqual(transport.requests[4].body.tool_choice,'auto');
 assert.ok(!transport.requests[4].body.tools?.length);
});
test('A validated terminal operation stops SDK generations and executes only outside the agent',async()=>{
 const transport=providerFetch([response([call('registrar_movimiento',{draft_id:'8',revision:2})]),response([message('No debe llamarse')])]);let prepared=0;
 const r=await runAgent({model:modelFor(transport.fetcher),instructions:'',messages:input,dispatch:async()=>{prepared++;return {action:{type:'post',amount:'12319',_draft_id:'8'}};}});
 assert.equal(r.amount,'12319');assert.equal(transport.requests.length,1);assert.equal(prepared,1);
});
test('A pending movement can still prepare its terminal registration on the fourth step',async()=>{
 const transport=providerFetch([response([call('actualizar_borrador',{fields:{memo:'Compra'}})]),response([call('consultar_borradores',{})]),response([call('listar_cuentas',{})]),response([call('registrar_movimiento',{draft_id:'8',revision:2})])]);
 const r=await runAgent({model:modelFor(transport.fetcher),instructions:'',messages:input,dispatch:async(name)=>name==='registrar_movimiento'?{action:{type:'post',amount:'12319'}}:{result:{drafts:[]}}});
 assert.equal(r.type,'post');assert.ok(transport.requests[3].body.tools?.length);
});
test('Read-only lookups do not suppress an explicitly requested fourth-step correction',async()=>{
 const transport=providerFetch([response([call('buscar_movimientos',{account:'Banco Alfa'})]),response([call('ver_movimiento',{target:'3'})]),response([call('listar_cuentas',{})]),response([call('proponer_correccion',{target:'3',field:'amount',amount_cop:'200'})])]);
 const r=await runAgent({model:modelFor(transport.fetcher),instructions:'',messages:[{role:'user',content:'Corrige el monto del movimiento a 200'}],dispatch:async(name)=>name==='proponer_correccion'?{action:{type:'pro',command:'stage'}}:{result:{}}});
 assert.equal(r.type,'pro');assert.equal(transport.requests.length,4);assert.ok(transport.requests[3].body.tools?.length);
});
test('SDK enforces four query rounds and refuses unknown tools without effects',async()=>{
 const transport=providerFetch([response([call('execute_sql',{query:'delete'})])]);let effects=0;
 const r=await runAgent({model:modelFor(transport.fetcher),instructions:'',messages:input,dispatch:async()=>{effects++;return {result:{}};}});
 assert.equal(effects,0);assert.equal(transport.requests.length,5);assert.match(r.question,/no pude/i);
});
test('SDK passes receipt image bytes to the same multimodal request',async()=>{
 const transport=providerFetch([response([message('Veo el recibo.')])]);
 await runAgent({model:modelFor(transport.fetcher),instructions:'',messages:[{role:'user',content:[{type:'text',text:'Este recibo'},{type:'file',data:new Uint8Array([1,2,3]),mediaType:'image/jpeg'}]}],dispatch:async()=>({})});
 const body=transport.requests[0].body;assert.ok(JSON.stringify(body.input).includes('data:image/jpeg;base64,AQID'));
});
test('Provider transport errors are redacted before callers can log credentials or payloads',async()=>{
 const transport=providerFetch([new Error('secret-test-key and receipt-private-text')]);
 await assert.rejects(runAgent({model:modelFor(transport.fetcher),instructions:'',messages:input,dispatch:async()=>({})} as any),e=>String(e).includes('IA no disponible')&&!String(e).includes('secret-test-key')&&!String(e).includes('receipt-private-text'));
});

test('Semantic translation uses the same private SDK provider and keeps text as data',async()=>{
 const {translateForSearch,createFinancialModel}=await import('../supabase/functions/_shared/llm-provider.ts');
 const transport=providerFetch([response([message('food for the cat')])]);
 const r=await translateForSearch('comida para el gato',createFinancialModel({apiKey:'synthetic',session:'synthetic-session',deadline:Date.now()+15_000,fetch:transport.fetcher}));
 assert.equal(r,'food for the cat');assert.equal(transport.requests[0].body.store,false);assert.equal(transport.requests[0].body.max_output_tokens,350);
 assert.equal(transport.requests[0].headers.get('x-opencode-session'),'synthetic-session');
 assert.match(JSON.stringify(transport.requests[0].body.input),/comida para el gato/);
});
test('An incomplete provider response executes no financial operation',async()=>{
 const transport=providerFetch([response([call('registrar_movimiento',{draft_id:'8',revision:2})],{status:'incomplete',incomplete_details:{reason:'max_output_tokens'}})]);let effects=0;
 await assert.rejects(runAgent({model:modelFor(transport.fetcher),instructions:'',messages:input,dispatch:async()=>{effects++;return {};}}),/incompleta/);
 assert.equal(effects,0);
});

test('Expired tool work cannot return a terminal action or start another RPC',async()=>{
 const transport=providerFetch([response([call('registrar_movimiento',{draft_id:'8',revision:2})])]);let sawAbort=false;let laterCalls=0;
 await assert.rejects(runAgent({model:modelFor(transport.fetcher),instructions:'',messages:input,timeoutMs:15,dispatch:async(_name,_args,signal)=>{
  await new Promise(resolve=>setTimeout(resolve,40));sawAbort=signal.aborted;
  return {action:{type:'post',amount:'12319'}};
 }}),/IA no disponible/);
 assert.equal(sawAbort,true);assert.equal(transport.requests.length,1);
 const {abortableRpc}=await import('../supabase/functions/_shared/tools/types.ts');
 const signal=AbortSignal.timeout(10);
 const rpc=abortableRpc(async()=>{laterCalls++;await new Promise(resolve=>setTimeout(resolve,30));return {};},signal);
 await assert.rejects(rpc('first'));
 await assert.rejects(rpc('next'));
 assert.equal(laterCalls,1);
});
