import test from 'node:test';
import assert from 'node:assert/strict';
import {runAgent} from '../supabase/functions/_shared/agent.ts';
import {message,call,response} from './fixtures/provider.ts';
import * as provider from '../supabase/functions/_shared/subscription-provider.ts';
function fixture(events:any[][]){
 const requests:any[]=[];
 const fetcher:typeof fetch=async(url,init)=>{
  requests.push({url:String(url),headers:new Headers(init?.headers),body:JSON.parse(String(init?.body))});
  const text=events[Math.min(requests.length-1,events.length-1)].map(e=>'data: '+JSON.stringify(e)+'\r\n\r\n').join('');
  const bytes=new TextEncoder().encode(text);
  return new Response(new ReadableStream({start(c){for(let i=0;i<bytes.length;i+=13)c.enqueue(bytes.slice(i,i+13));c.close();}}),{headers:{'content-type':'text/event-stream'}});
 };
 return {requests,fetcher};
}
const opts=(fetcher:typeof fetch)=>({accessToken:async()=>'synthetic-token',model:'gpt-6-luna',deadline:Date.now()+60_000,fetch:fetcher});
function withoutContentType(fetcher:typeof fetch):typeof fetch{
 return async(url,init)=>{const r=await fetcher(url,init);return new Response(r.body,{status:r.status});};
}
test('Completed subscription events without Content-Type remain usable',async()=>{
 const f=fixture([[{type:'response.completed',response:response([message('¿Cuánto debes hoy?')])}]]);
 const r=await runAgent({model:provider.createSubscriptionModel(opts(withoutContentType(f.fetcher))),instructions:'',messages:[{role:'user',content:'Tengo una tarjeta'}],dispatch:async()=>{throw Error('No tool expected');}});
 assert.equal(r.type,'clarify');assert.equal(r.question,'¿Cuánto debes hoy?');
});
test('Missing Content-Type never permits partial tool output',async()=>{
 const f=fixture([[{type:'response.output_item.done',output_index:0,item:call('registrar_movimiento',{draft_id:'8',revision:1})}]]);let writes=0;
 await assert.rejects(runAgent({model:provider.createSubscriptionModel(opts(withoutContentType(f.fetcher))),instructions:'',messages:[{role:'user',content:'Registra'}],dispatch:async()=>{writes++;return {};}}),/IA no disponible/);
 assert.equal(writes,0);
});
test('Completed subscription reconstructs output from finished items when terminal output is empty',async()=>{
 const f=fixture([[{type:'response.output_item.done',output_index:0,item:call('buscar_movimientos',{amount_cop:'190000',from_account:'Banco Beta',to_account:'Banco Alfa'})},{type:'response.completed',response:response([])}],[{type:'response.output_item.done',output_index:0,item:message('No aparece registrada.')},{type:'response.completed',response:response([])}]]);
 let reads=0;
 const r=await runAgent({model:provider.createSubscriptionModel(opts(f.fetcher)),instructions:'',messages:[{role:'user',content:'¿Existe?'}],dispatch:async()=>{reads++;return {result:{exists:false}};}});
 assert.equal(reads,1);assert.equal(r.question,'No aparece registrada.');
});
test('Finished items without terminal completion cannot execute tools',async()=>{
 const f=fixture([[{type:'response.output_item.done',output_index:0,item:call('registrar_movimiento',{draft_id:'8',revision:1})}]]);let writes=0;
 await assert.rejects(runAgent({model:provider.createSubscriptionModel(opts(f.fetcher)),instructions:'',messages:[{role:'user',content:'Registra'}],dispatch:async()=>{writes++;return {};}}),/IA no disponible/);
 assert.equal(writes,0);
});
for(const [name,events] of [
 ['duplicate output indexes',[{type:'response.output_item.done',output_index:0,item:call('registrar_movimiento',{draft_id:'8',revision:1})},{type:'response.output_item.done',output_index:0,item:message('Listo')},{type:'response.completed',response:response([])}]],
 ['gapped output indexes',[{type:'response.output_item.done',output_index:1,item:call('registrar_movimiento',{draft_id:'8',revision:1})},{type:'response.completed',response:response([])}]],
 ['incomplete terminal status',[{type:'response.output_item.done',output_index:0,item:call('registrar_movimiento',{draft_id:'8',revision:1})},{type:'response.completed',response:{...response([]),status:'incomplete'}}]],
] as const)test('Reconstructed subscription output rejects '+name+' before financial effects',async()=>{
 const f=fixture([[...events]]);let writes=0;
 await assert.rejects(runAgent({model:provider.createSubscriptionModel(opts(f.fetcher)),instructions:'',messages:[{role:'user',content:'Registra'}],dispatch:async()=>{writes++;return {};}}),/IA no disponible/);
 assert.equal(writes,0);
});
test('An explicitly incompatible Content-Type is rejected',async()=>{
 const f=fixture([[{type:'response.completed',response:response([message('Respuesta')])}]]);
 const fetcher:typeof fetch=async(url,init)=>{const r=await f.fetcher(url,init);return new Response(r.body,{headers:{'content-type':'text/html'}});};
 await assert.rejects(runAgent({model:provider.createSubscriptionModel(opts(fetcher)),instructions:'',messages:[{role:'user',content:'Consulta'}],dispatch:async()=>{throw Error('No tool expected');}}),/IA no disponible/);
});
test('Subscription transport uses OAuth, private streaming and namespaced financial tools',async()=>{
 assert.equal(typeof provider.createSubscriptionModel,'function');
 const f=fixture([[{type:'response.completed',response:response([{...call('buscar_movimientos',{amount_cop:'190000',from_account:'Banco Beta',to_account:'Banco Alfa'}),namespace:'finance'}])}],[{type:'response.completed',response:response([message('No aparece registrada esa transferencia.')])}]]);
 let reads=0;
 const r=await runAgent({model:provider.createSubscriptionModel(opts(f.fetcher)),instructions:'Asistente financiero',messages:[{role:'user',content:'¿Existe la transferencia?'}],dispatch:async()=>{reads++;return {result:{exists:false,total_matches:0,complete:true,movements:[]}};}});
 assert.equal(reads,1);assert.match(r.question,/No aparece/);
 const q=f.requests[0];assert.equal(q.url,'https://api.openai.com/v1/responses');assert.equal(q.headers.get('authorization'),'Bearer synthetic-token');assert.equal(q.body.stream,true);assert.equal(q.body.store,false);assert.equal(q.body.max_output_tokens,undefined);assert.equal(q.body.tools[0].type,'namespace');assert.equal(q.body.tools[0].name,'finance');assert.ok(q.body.input.every((m:any)=>m.role!=='system'));
 assert.equal(JSON.parse(f.requests[1].body.input.find((p:any)=>p.type==='function_call_output').output).exists,false);
});
test('Partial subscription output cannot execute a financial tool',async()=>{
 const f=fixture([[{type:'response.output_item.done',item:call('registrar_movimiento',{draft_id:'8',revision:1})}]]);let writes=0;
 await assert.rejects(runAgent({model:provider.createSubscriptionModel(opts(f.fetcher)),instructions:'',messages:[{role:'user',content:'Registra'}],dispatch:async()=>{writes++;return {};}}),/IA no disponible/);assert.equal(writes,0);
});
test('A subscription usage failure after streamed text executes no operation and hides details',async()=>{
 const f=fixture([[{type:'response.output_text.delta',delta:'private-text'},{type:'response.failed',response:{error:{code:'subscription_sharing_usage_limit_exceeded',message:'synthetic-token'}}}]]);
 let writes=0;await assert.rejects(runAgent({model:provider.createSubscriptionModel(opts(f.fetcher)),instructions:'',messages:[{role:'user',content:'Registra'}],dispatch:async()=>{writes++;return {};}}),e=>String(e).includes('IA no disponible')&&!String(e).includes('synthetic-token')&&!String(e).includes('private-text'));assert.equal(writes,0);
});
