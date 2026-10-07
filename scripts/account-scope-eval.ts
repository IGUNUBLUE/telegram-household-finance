/** Real model; isolated synthetic ledger; no Telegram, production DB or OAuth refresh. */
import assert from 'node:assert/strict';
import {readProtectedJson,type SubscriptionSession} from './lib/subscription-session.ts';
import type {SubscriptionCredentials} from './lib/subscription-auth.ts';
import {createProtectedPiProvider} from './lib/pi-provider.ts';
import {createFinancialFlue} from './lib/flue-agent.ts';
import {createFlueInterpretationServices} from './lib/flue-interpretation.ts';
import {financialTools} from '../supabase/functions/_shared/agent-tools.ts';
import {approvalDatabase} from '../tests/fixtures/approval-database.ts';
import {PROMPT_VERSION} from '../supabase/functions/_shared/agent-prompt.ts';
const args=process.argv.slice(2);if(args.length!==3||args[0]!=='--synthetic'||args[1]!=='--credential-file')throw Error('Requires --synthetic --credential-file PATH');
const session={accessToken:async()=>{const c=await readProtectedJson<SubscriptionCredentials>(args[2]);if(!c||c.issuer!=='https://auth.openai.com'||c.expires_at<Date.now()+60000)throw Error('Owner token unavailable; no refresh attempted');return c.access_token;}} as SubscriptionSession;
const catalog=await fetch('https://api.openai.com/v1/models',{headers:{Authorization:'Bearer '+await session.accessToken()},signal:AbortSignal.timeout(20000)});if(!catalog.ok)throw Error('Catalog unavailable');
const runtime=await createFinancialFlue({provider:createProtectedPiProvider(session,await catalog.json()) as unknown as Parameters<typeof createFinancialFlue>[0]['provider'],tools:financialTools});
const f=await approvalDatabase(),results:any[]=[];
const date=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Bogota',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
try{
 for(const [actor,name,kind,amount] of [['101','Banco Pino','asset','1234521'],['101','Deuda Pino','liability','23419'],['202','Banco Coral','asset','9876517'],['202','Deuda Coral','liability','78923']]){
  const e=await f.event(actor);await f.rpc('agent:apply',{id:e.id,action:{type:'account',name,kind,owner:actor,amount,date:'2026-09-01'}});
 }
 const cases=[
  {name:'original own wording',actor:'101',text:'Como están mis cuentas?',scope:'mine'},
  {name:'own money paraphrase',actor:'101',text:'¿Cuánto dinero tengo y qué debo en las cuentas que administro?',scope:'mine'},
  {name:'other member own overview',actor:'202',text:'Muéstrame mis cuentas con sus saldos y deudas.',scope:'mine'},
  {name:'explicit all accounts',actor:'101',text:'Muestra el total de todas las cuentas.',scope:'all'},
  {name:'explicit global',actor:'202',text:'Dame el global de dinero y deudas del hogar.',scope:'all'},
  {name:'own after global',actor:'101',text:'Ahora solo mis cuentas, las que yo administro.',scope:'mine',conversation:{turns:[{text:'Dame el global',answer:'Banco Pino $12.345,21 y Banco Coral $98.765,17; deudas de los dos.'}]}},
  {name:'global after own',actor:'101',text:'Ahora dame el global de todas las cuentas, entre los dos.',scope:'all',conversation:{turns:[{text:'¿Mis cuentas?',answer:'Banco Pino $12.345,21; Deuda Pino $234,19.'}]}},
  {name:'own historical date',actor:'101',text:'¿Cómo estaban mis cuentas al 30 de septiembre de 2026?',scope:'mine',as_of:'2026-09-30'},
  {name:'explicit between both',actor:'101',text:'¿Cuánto tenemos entre los dos en nuestras cuentas?',scope:'all'},
  {name:'specific account stays specific',actor:'101',text:'¿Cuánto tiene Banco Coral?',scope:'account'},
 ];
 for(const c of cases){const start=Date.now();let metrics:any;try{
  const ev=await f.event(c.actor,c.text),lease=await f.rpc('queue:claim');assert.equal(lease.id,ev.id);
  const context={...await f.rpc('worker:context',{id:ev.id}),actor:c.actor,event_id:ev.id,event_attempt_token:lease.turn_token,turn_focus:{draft_ids:[]},conversation:c.conversation??await f.rpc('pro:conversation',{id:ev.id,text:c.text,force_new:true})};
  const reads:any[]=[],before=await f.snapshotLedger();const checked=createFlueInterpretationServices({runtime,today:()=>date,telegramFile:async()=>{throw Error('No Telegram');},rpc:async(op,data,signal)=>{const r=await f.rpc(op,data);if(op==='family:overview'||op==='agent:statement')reads.push({op,scope:r.account_scope,as_of:r.as_of,owners:r.accounts?.map((a:any)=>a.owner),account:data.account});return r;}});
  const action=await checked.interpret({text:c.text},context,m=>{metrics=m;});assert.equal(action.type,'clarify');assert.ok(reads.length);
  if(c.scope==='account'){assert.ok(reads.every(r=>r.op==='agent:statement'&&r.account==='Banco Coral'));assert.ok(!action.question.includes('Banco Pino'));}
  else{assert.ok(reads.every(r=>r.op==='family:overview'&&r.scope===c.scope&&r.as_of===('as_of' in c?c.as_of:date)));if(c.scope==='mine'){assert.ok(reads.every(r=>r.owners.every((o:any)=>o===c.actor)));assert.ok(!action.question.includes(c.actor==='101'?'Coral':'Pino'));}else{assert.ok(reads.every(r=>r.owners.includes('101')&&r.owners.includes('202')));}}
  await f.rpc('agent:apply',{id:ev.id,action});await f.rpc('queue:finish',{id:ev.id,token:lease.turn_token});assert.deepEqual(await f.snapshotLedger(),before);
  results.push({name:c.name,passed:true,elapsed_ms:Date.now()-start,rounds:metrics.rounds,answer:action.question,tools:metrics.tools.map((t:any)=>t.name)});
 }catch(error){results.push({name:c.name,passed:false,elapsed_ms:Date.now()-start,error:error instanceof Error?error.message:'failure'});await f.db.exec("update private.events set state='done',turn_until=null,turn_token=null where state in ('new','working')");}console.log(JSON.stringify(results.at(-1)));}
 console.log(JSON.stringify({suite:'account_scope',synthetic_only:true,prompt:PROMPT_VERSION,cases:results.length,passed:results.filter(r=>r.passed).length,results}));if(results.some(r=>!r.passed))process.exitCode=1;
}finally{await runtime.close();await f.db.close();}
