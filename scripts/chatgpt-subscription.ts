/** Local feasibility probe. Never reads the production ledger or sends Telegram messages. */
import {createServer} from 'node:http';
import {openSubscriptionSession,writeProtectedJson} from './lib/subscription-session.ts';
import {homedir} from 'node:os';import {join} from 'node:path';import {spawn} from 'node:child_process';
import {createLoginAttempt,completeLogin,type SubscriptionCredentials} from './lib/subscription-auth.ts';
import {createSubscriptionModel} from '../supabase/functions/_shared/subscription-provider.ts';
import {evaluateFramework,frameworkEvaluationCases} from '../supabase/functions/_shared/framework-evaluation.ts';
import {parseSubscriptionOptions} from './lib/subscription-options.ts';
import {selectSubscriptionModel} from './lib/subscription-catalog.ts';
let options:ReturnType<typeof parseSubscriptionOptions>;
try{options=parseSubscriptionOptions(process.argv.slice(2));}catch(e){console.error(e instanceof Error?e.message:'Opciones inválidas');process.exit(1);}
const dir=join(homedir(),'.config','finanzas-familiares'),file=join(dir,'chatgpt-subscription.json');
const session=await openSubscriptionSession({directory:dir,allowMissing:true});
const save=writeProtectedJson;
try{
 let stored=session.credentials();
 const host={id:session.hostId};
 if(!stored||!options.probeOnly){
  let settled=false;let attempt:ReturnType<typeof createLoginAttempt>;
  let resolveLogin:(value:SubscriptionCredentials)=>void=()=>{};let rejectLogin:(error:Error)=>void=()=>{};
  const received=new Promise<SubscriptionCredentials>((resolve,reject)=>{resolveLogin=resolve;rejectLogin=reject;});
  const server=createServer(async(req,res)=>{
   const callback=new URL(req.url??'/',attempt.redirectUri);
   if(callback.pathname!=='/auth/callback'){res.writeHead(404);res.end();return;}
   if(settled||callback.searchParams.get('state')!==attempt.state){res.writeHead(400);res.end('Solicitud inválida.');return;}
   settled=true;
   try{const credentials=await completeLogin(attempt,callback);res.writeHead(200,{'content-type':'text/plain; charset=utf-8','cache-control':'no-store'});res.end('Conexión autorizada. Puedes cerrar esta ventana.');resolveLogin(credentials);}
   catch{res.writeHead(400);res.end('No se pudo autorizar el plan de ChatGPT.');rejectLogin(Error('No se pudo autorizar el plan de ChatGPT.'));}
  });
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(options.port,'127.0.0.1',()=>resolve());});
  const address=server.address();if(!address||typeof address==='string')throw Error('No se pudo abrir el callback local');
  attempt=createLoginAttempt('http://127.0.0.1:'+address.port+'/auth/callback',host.id,stored);
  console.log('Autoriza Finanzas Familiares en ChatGPT. No compartas contraseñas ni códigos en el chat.');console.log(attempt.url);
  if(options.noOpen)console.log('Abre el enlace en tu navegador. Si el proceso corre en un VPS, mantén un túnel SSH al puerto '+address.port+'.');
  if(!options.noOpen){
   const child=process.platform==='win32'?spawn('rundll32',['url.dll,FileProtocolHandler',attempt.url],{stdio:'ignore'}):spawn(process.platform==='darwin'?'open':'xdg-open',[attempt.url],{stdio:'ignore'});
   child.on('error',()=>console.log('Abre el enlace anterior en el navegador de este equipo.'));child.unref();
  }
  const timer=setTimeout(()=>rejectLogin(Error('Autorización expirada; vuelve a ejecutar el comando')),5*60_000);
  try{stored=await received;await session.save(stored);}finally{clearTimeout(timer);await new Promise<void>(resolve=>server.close(()=>resolve()));}
 }
 if(!stored)throw Error('Falta conexión de ChatGPT');
 const accessToken=session.accessToken;
 const catalog=await fetch('https://api.openai.com/v1/models',{headers:{Authorization:'Bearer '+await accessToken()},signal:AbortSignal.timeout(20_000)});
 if(!catalog.ok)throw Error('No se pudo comprobar el catálogo de tu plan ('+catalog.status+')');
 const model=selectSubscriptionModel(await catalog.json(),options.model??stored.model??'gpt-6-luna');
 const report:any={provider:'chatgpt-subscription',model,production_activated:false,fixtures:[]};
 for(const name of frameworkEvaluationCases){
  const result=await evaluateFramework(name,createSubscriptionModel({accessToken,model,deadline:Date.now()+65_000}));
  report.fixtures.push({fixture:name,passed:result.passed,tools:result.metrics?.tools,rounds:result.metrics?.rounds});
  console.log(name+': '+(result.passed?'OK':'FALLÓ'));if(!result.passed)throw Error('La prueba '+name+' no pasó. No se activó el proveedor.');
 }
 stored={...session.credentials()!,model};await session.save(stored);await save(join(dir,'subscription-probe.json'),report);
 console.log('Prueba completada. El modelo y las herramientas funcionaron con datos ficticios. El bot de producción todavía no cambió de proveedor.');
}catch(e){console.error(e instanceof Error?e.message:'No se pudo completar la conexión');process.exitCode=1;}
finally{await session.close();}
