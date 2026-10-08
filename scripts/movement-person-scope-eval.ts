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
 await f.db.exec("update private.members set name=case id when '101' then 'Alex' else 'Sam' end");
 const ids:Record<string,string>={};
 async function seed(label:string,actor:string,payer:string,account:string,kind:string,amount:string,day:string){
  const ev=await f.event(actor);const r=await f.rpc('agent:apply',{id:ev.id,action:{type:'post',kind,amount,account,payer,date:day,scope:'family',category:'Prueba',memo:label}});assert.ok(r.transaction_id);ids[label]=String(r.transaction_id);
 }
 await seed('Arriendo ficticio Sam','202','202','Cuenta Dos','income','11111','2026-10-06');
 for(let i=0;i<34;i++)await seed('Ingreso ficticio Alex '+i,'101','101','Cuenta Uno','income',String(22222+i),'2026-10-07');
 await seed('Recibido por Sam registrado por Alex','101','202','Cuenta Uno','income','33333','2026-10-08');
 await seed('Gasto pagado por Sam registrado por Alex','101','202','Cuenta Dos','expense','44444','2026-10-08');
 await seed('Registro reciente con fecha anterior','101','101','Cuenta Uno','income','55555','2026-10-05');
 await f.enable();
 const globalTurn={turns:[{text:'Dame el último ingreso del hogar',answer:'Recibido por Sam registrado por Alex, en Cuenta Uno.'}]};
 const ownTurn={turns:[{text:'Dame la última entrada que realicé',answer:'Arriendo ficticio Sam, en Cuenta Dos.'}]};
 const cases=[
  {name:'own latest registered original wording',actor:'202',text:'Dame la última entrada que realicé',scope:'mine',role:'author',sort:'registered',target:ids['Arriendo ficticio Sam']},
  {name:'own latest recorded paraphrase',actor:'202',text:'¿Cuál fue el último ingreso que anoté?',scope:'mine',role:'author',sort:'registered',target:ids['Arriendo ficticio Sam']},
  {name:'own received income differs from author',actor:'202',text:'Muéstrame el último ingreso que recibí',scope:'mine',role:'payer',sort:'date',target:ids['Recibido por Sam registrado por Alex']},
  {name:'own paid expense differs from author',actor:'202',text:'Dame mi último gasto, lo que pagué yo',scope:'mine',role:'payer',sort:'date',target:ids['Gasto pagado por Sam registrado por Alex']},
  {name:'no own authored expense avoids household fallback',actor:'202',text:'¿Cuál es el último gasto que registré yo?',scope:'mine',role:'author',sort:'registered',empty:true},
  {name:'own managed account movements differ from recipient',actor:'202',text:'Último ingreso de las cuentas que yo administro',scope:'mine',role:'account_owner',sort:'date',target:ids['Arriendo ficticio Sam']},
  {name:'named other member author',actor:'101',text:'Dame el último ingreso registrado por Sam',scope:'member',role:'author',member:'202',sort:'registered',target:ids['Arriendo ficticio Sam']},
  {name:'named other member recipient',actor:'101',text:'Dame el último ingreso recibido por Sam',scope:'member',role:'payer',member:'202',sort:'date',target:ids['Recibido por Sam registrado por Alex']},
  {name:'explicit global financial date',actor:'202',text:'Dame el ingreso más reciente de todo el hogar por fecha',scope:'all',sort:'date',target:ids['Recibido por Sam registrado por Alex']},
  {name:'explicit global last registration',actor:'202',text:'Dame el último ingreso registrado entre los dos',scope:'all',sort:'registered',target:ids['Registro reciente con fecha anterior']},
  {name:'global to own context',actor:'202',text:'Ahora solo el último ingreso que registré yo',scope:'mine',role:'author',sort:'registered',target:ids['Arriendo ficticio Sam'],conversation:globalTurn},
  {name:'own to global context',actor:'202',text:'Ahora muéstrame el último ingreso registrado de todos',scope:'all',sort:'registered',target:ids['Registro reciente con fecha anterior'],conversation:ownTurn},
  {name:'named member correction keeps author relation',actor:'101',text:'Solo de Sam',scope:'member',role:'author',member:'202',sort:'registered',target:ids['Arriendo ficticio Sam'],conversation:{turns:[{text:'Dame la última entrada que realicé',answer:'Registro reciente con fecha anterior, de Alex.'}]}},
  {name:'own income total over a period',actor:'202',text:'¿Cuánto recibí de ingresos del 6 al 8 de octubre de 2026?',scope:'mine',role:'payer',from:'2026-10-06',to:'2026-10-08',total:'444.44'},
  {name:'own historical list includes family records',actor:'202',text:'Lista los ingresos que registré en octubre de 2026, aunque sean familiares',scope:'mine',role:'author',from:'2026-10-01',to:'2026-10-31',target:ids['Arriendo ficticio Sam']},
  {name:'ambiguous own movements asks relationship',actor:'202',text:'Dame mis movimientos',ambiguous:true},
 ];
 for(const c of cases){const start=Date.now();let metrics:any;try{
  const ev=await f.event(c.actor,c.text),lease=await f.rpc('queue:claim');assert.equal(lease.id,ev.id);
  const context={...await f.rpc('worker:context',{id:ev.id}),actor:c.actor,event_id:ev.id,event_attempt_token:lease.turn_token,turn_focus:{draft_ids:[]},conversation:c.conversation??await f.rpc('pro:conversation',{id:ev.id,text:c.text,force_new:true})};
  const reads:any[]=[],before=await f.snapshotLedger();const checked=createFlueInterpretationServices({runtime,today:()=>date,telegramFile:async()=>{throw Error('No Telegram');},rpc:async(op,data,signal)=>{const r=await f.rpc(op,data);if(op==='agent:search')reads.push({args:data,result:r});return r;}});
  const action=await checked.interpret({text:c.text},context,m=>{metrics=m;});assert.equal(action.type,'clarify');
  if('ambiguous' in c){assert.ok(action.question.includes('?'));assert.doesNotMatch(action.question,/\d|\bCuenta (?:Uno|Dos)\b/,'An ambiguous relationship must not attribute financial facts before clarification');assert.match(action.question,/registr|recib|pag|administr|cuenta|autor/i);}
  else{
   assert.ok(reads.length,'Expected a verified movement query');
   const read=reads.at(-1),filter=read.result.person_filter;
   assert.equal(filter.scope,c.scope);assert.equal(filter.member_id,c.scope==='all'?null:('member' in c?c.member:c.actor));
   if('role' in c)assert.equal(filter.role,c.role);
   if('sort' in c)assert.equal(read.result.sort_by,c.sort);
   if('target' in c)assert.equal(read.result.movements[0]?.id,c.target);
   if('empty' in c)assert.equal(read.result.exists,false);
   if('from' in c){assert.equal(read.args.from,c.from);assert.equal(read.args.to,c.to);}
   if('total' in c){assert.equal(read.result.totals_cop.income,c.total);assert.match(action.question,/\b444[,.]44\b/);}
   if('target' in c&&c.target===ids['Arriendo ficticio Sam'])assert.ok(!action.question.includes('Cuenta Uno'),'Wrong account in own result');
  }
  await f.rpc('agent:apply',{id:ev.id,action});await f.rpc('queue:finish',{id:ev.id,token:lease.turn_token});assert.deepEqual(await f.snapshotLedger(),before);
  results.push({name:c.name,passed:true,elapsed_ms:Date.now()-start,rounds:metrics.rounds,answer:action.question,tools:metrics.tools.map((t:any)=>t.name)});
 }catch(error){results.push({name:c.name,passed:false,elapsed_ms:Date.now()-start,error:error instanceof Error?error.message:'failure'});await f.db.exec("update private.events set state='done',turn_until=null,turn_token=null where state in ('new','working')");}console.log(JSON.stringify(results.at(-1)));}
 console.log(JSON.stringify({suite:'movement_person_scope',synthetic_only:true,prompt:PROMPT_VERSION,cases:results.length,passed:results.filter(r=>r.passed).length,results}));if(results.some(r=>!r.passed))process.exitCode=1;
}finally{await runtime.close();await f.db.close();}
