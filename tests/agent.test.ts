import test from 'node:test';
import assert from 'node:assert/strict';
(globalThis as any).Deno={env:{get:()=>undefined}};
const {handlePro}=await import('../supabase/functions/_shared/pro.ts');
const context={members:[{id:'101',name:'Alex'}],accounts:[]};
test('Agentic conversation does not turn a question containing no sé into account creation',async()=>{
 const text='No se, a que te refieres con saldo pendiente, hablas del cupo max?';
 const result=await handlePro({id:1,actor:'101',name:'Alex',group:'-1',text},text,context,{mode:{kind:'account_balance',draft:{name:'Tarjeta Alfa',kind:'liability',owner:'101'}}},true);
 assert.equal(result,null);
});
const {runAgent,AGENT_MODEL}=await import('../supabase/functions/_shared/agent.ts');
const {createOpenAI}=await import('@ai-sdk/openai');
const {providerFetch,response,message,call}=await import('./fixtures/provider.ts');
function fixture(replies:any[]){
 const transport=providerFetch(replies);
 const model=createOpenAI({apiKey:'synthetic',baseURL:'https://test.invalid/v1',fetch:transport.fetcher}).responses(AGENT_MODEL);
 return {...transport,model,instructions:'',messages:[{role:'user' as const,content:'mensaje'}]};
}
test('A conceptual answer can finish without any financial tool or write',async()=>{
 const f=fixture([response([message('Me refiero a lo que debes hoy, no al cupo.')])]);let calls=0;
 const r=await runAgent({...f,dispatch:async()=>{calls++;return {};}});
 assert.equal(f.requests[0].body.model,AGENT_MODEL);assert.equal(f.requests[0].body.store,false);
 assert.equal(r.type,'clarify');assert.match(r.question,/debes/);assert.equal(calls,0);
});
test('Agent reads SQL results before answering and does not execute a write',async()=>{
 const f=fixture([response([call('consultar_saldos',{from:'2026-09-01',to:'2026-09-28',scope:'all'})]),response([message('Llevas $63.000 COP en gastos.')])]);
 const r=await runAgent({...f,dispatch:async()=>({result:{expense:'6300000'}})});
 assert.match(JSON.stringify(f.requests[1].body.input),/6300000/);assert.match(r.question,/63.000/);
});
test('Invalid financial arguments are returned to the model for clarification',async()=>{
 const f=fixture([response([call('preparar_cuenta',{name:'Tarjeta Alfa'})]),response([message('¿Qué nombre tiene la cuenta?')])]);let effects=0;
 const r=await runAgent({...f,dispatch:async()=>{effects++;throw Error('Nombre obligatorio');}});
 assert.equal(r.type,'clarify');assert.match(r.question,/nombre/);assert.equal(effects,0);
 assert.match(JSON.stringify(f.requests[1].body.input),/error/i);
});
test('Tool loop has a finite limit and forbids arbitrary tools',async()=>{
 const f=fixture([response([call('execute_sql',{query:'delete'})])]);let reads=0;
 const r=await runAgent({...f,dispatch:async()=>{reads++;return {};}});
 assert.equal(reads,0);assert.equal(f.requests.length,5);assert.equal(r.type,'clarify');
});
test('Validated action stops generation before a second mutation can occur',async()=>{
 const f=fixture([response([call('registrar_movimiento',{draft_id:'1',revision:1})])]);
 const r=await runAgent({...f,dispatch:async()=>({action:{type:'post',amount:'6300000'}})});
 assert.equal(r.amount,'6300000');assert.equal(f.requests.length,1);
});
test('Account preview explains unknown debt without exposing schema or actor IDs',async()=>{
 const {formatPro}=await import('../supabase/functions/_shared/pro.ts');
 const text=formatPro({status:'preview',proposal:{command:'account',name:'Tarjeta Alfa',kind:'liability',owner:'101',ownerName:'Alex',balance_known:false,amount:'0'}})!;
 assert.match(text,/deuda actual/);assert.doesNotMatch(text,/liability|ID titular|101|\$0/);
});
