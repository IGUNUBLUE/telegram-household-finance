import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {fauxProvider,fauxAssistantMessage as answer,fauxToolCall as call} from '@earendil-works/pi-ai/providers/faux';
import {z} from 'zod';
import {getDeclaredTools} from '@earendil-works/pi-ai/utils/transcript';
import {createFinancialFlue,flueToolInput} from '../scripts/lib/flue-agent.ts';
import * as v from 'valibot';
import {financialTools} from '../supabase/functions/_shared/agent-tools.ts';

const faux=fauxProvider({provider:'test-finance',models:[{id:'fixture',contextWindow:32000,maxTokens:1800}],tokensPerSecond:100000});
const tools=[{name:'read_balance',description:'Read authoritative balance',readOnly:true,inputSchema:z.object({account:z.string()})},{name:'prepare',description:'Prepare exact account balance',readOnly:false,inputSchema:z.object({amount_cop:z.string(),owner:z.string().optional()})}];
let runtime:Awaited<ReturnType<typeof createFinancialFlue>>;
before(async()=>{runtime=await createFinancialFlue({provider:faux.provider,model:'test-finance/fixture',tools});});
after(async()=>{await runtime.close();});
let count=0;
const run=(dispatch:Parameters<typeof runtime.run>[0]['dispatch'],extra:Partial<Parameters<typeof runtime.run>[0]>={})=>runtime.run({key:'synthetic-'+(++count),instructions:'Use only registered financial tools. Answer naturally.',text:'mensaje',dispatch,timeoutMs:2000,...extra});
test('Flue preserves integer cents and returns prepared action without claiming a commit',async()=>{
 faux.setResponses([answer(call('prepare',{amount_cop:'1234567.89'}))]);let writes=0;
 const r=await run(async(name,args)=>{assert.equal(name,'prepare');assert.equal((args as any).amount_cop,'1234567.89');writes++;return {action:{type:'pro',proposal:{amount:'123456789'}}};});
 assert.equal(r.proposal.amount,'123456789');assert.equal(writes,1);assert.equal(faux.state.callCount,1);
});
test('Flue reads an absent result and can answer without asking for irrelevant details',async()=>{
 faux.setResponses([answer(call('read_balance',{account:'Banco Alfa'})),answer('No aparece registrada.')]);
 const r=await run(async()=>({result:{found:false}}));assert.equal(r.question,'No aparece registrada.');
});
test('a parallel mutation batch is rejected before the first effect',async()=>{
 faux.setResponses([answer([call('prepare',{amount_cop:'1'}),call('prepare',{amount_cop:'2'})])]);let writes=0;
 await assert.rejects(run(async()=>{writes++;return {action:{type:'post'}};}));assert.equal(writes,0);
});
test('only registered financial tools are exposed and arbitrary calls never run',async()=>{
 let exposed:string[]=[];
 faux.setResponses([async context=>{exposed=getDeclaredTools(context.messages).map(t=>t.name);return answer(call('bash',{command:'ls'}));}]);let effects=0;
 await assert.rejects(run(async()=>{effects++;return {};}));assert.equal(effects,0);assert.deepEqual(exposed,tools.map(t=>t.name));
});
test('a truncated response containing a tool call cannot dispatch',async()=>{
 faux.setResponses([answer(call('prepare',{amount_cop:'1'}),{stopReason:'length'})]);let effects=0;
 await assert.rejects(run(async()=>{effects++;return {};}));assert.equal(effects,0);
});
test('two concurrent actors keep separate verified tool dispatch contexts',async()=>{
 // Each response follows its own transcript, independently of scheduling order.
 const response=(context:any)=>context.messages.some((m:any)=>m.role==='assistant'&&m.content.some((p:any)=>p.type==='toolCall'))?answer('Saldo comprobado.'):answer(call('read_balance',{account:context.messages.some((m:any)=>m.role==='user'&&JSON.stringify(m.content).includes('202'))?'Banco Beta':'Banco Alfa'}));
 faux.setResponses([response,response,response,response]);
 const actors:string[]=[];
 await Promise.all(['101','202'].map(actor=>run(async(_name,args)=>{assert.equal((args as any).account,actor==='101'?'Banco Alfa':'Banco Beta');actors.push(actor);return {result:{actor}};},{key:'actor-'+actor,text:'Consulta para '+actor})));
 assert.deepEqual(actors.sort(),['101','202']);
});
test('a timed out late tool cannot hand an action back to the worker',async()=>{
 faux.setResponses([answer(call('prepare',{amount_cop:'1'}))]);
 await assert.rejects(run(async(_name,_args,signal)=>{await new Promise(r=>setTimeout(r,100));assert.equal(signal.aborted,true);return {action:{type:'post'}};},{timeoutMs:35}));
});
test('a repeated admission returns the durable result without a second effect',async()=>{
 faux.setResponses([answer(call('prepare',{amount_cop:'1'}))]);let effects=0;
 const options={key:'same-admission',dispatch:async()=>{effects++;return {action:{type:'post',amount:'100'}};}};
 assert.equal((await run(options.dispatch,options)).amount,'100');assert.equal((await run(options.dispatch,options)).amount,'100');assert.equal(effects,1);
});
test('all existing financial contracts convert and reject invalid fractional or extra arguments',()=>{
 for(const tool of financialTools)assert.doesNotThrow(()=>flueToolInput(tool.inputSchema));
 const schema=flueToolInput(z.object({day:z.number().int().min(1).max(31),amount:z.string().regex(/^[0-9]+(?:[.][0-9]{1,2})?$/),items:z.array(z.string()).min(1).max(2)}));
 assert.equal(v.safeParse(schema,{day:1,amount:'250.13',items:['uno']}).success,true);
 for(const data of [{day:1.5,amount:'250.13',items:['uno']},{day:32,amount:'250.13',items:['uno']},{day:1,amount:'250.133',items:['uno']},{day:1,amount:'250.13',items:[]},{day:1,amount:'250.13',items:['uno'],actor:'202'}])assert.equal(v.safeParse(schema,data).success,false);
});
test('the native provider receives the authoritative application instructions and optional schemas',async()=>{
 let prompt='',schema:any;
 faux.setResponses([async context=>{prompt=context.messages.filter(m=>m.role==='system').map(m=>m.content).join('\n');schema=getDeclaredTools(context.messages).find(t=>t.name==='prepare')?.parameters;return answer('Hola.');}]);
 await run(async()=>({}),{instructions:'Fecha local: 2026-10-01. No inventes filtros. APLICACION_AUTORIZADA'});
 assert.match(prompt,/APLICACION_AUTORIZADA/);
 assert.doesNotMatch(prompt,/^Date:/m);
 assert.equal(schema.required.includes('owner'),false);
});
test('the final round cannot execute another read or mutation',async()=>{
 faux.setResponses([answer(call('read_balance',{account:'Banco Alfa'})),answer(call('prepare',{amount_cop:'1'}))]);let reads=0,writes=0;
 await assert.rejects(run(async name=>{if(name==='prepare')writes++;else reads++;return {result:{balance:'1'}};},{maxSteps:2}));
 assert.equal(reads,1);assert.equal(writes,0);
});
