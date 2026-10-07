import {getRuntimeEnv} from './runtime-env.ts';
import {createInterpretationServices} from './interpretation.ts';
import {createFinancialModel} from './llm-provider.ts';
import {transcribeAudio} from './deepgram.ts';
import {getConfig} from './config.ts';
import {createTelegramClientCache} from './telegram-client.ts';
const required=(k:string)=>{const v=getConfig(k);if(!v)throw Error('Falta secreto '+k);return v;};
export function today(){return new Intl.DateTimeFormat('en-CA',{timeZone:'America/Bogota',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());}
export async function rpc(op:string,data:unknown={},signal?:AbortSignal):Promise<any>{
 const isPro=op.startsWith('approval:')||op.startsWith('worker:')||op.startsWith('queue:')||op.startsWith('ui:')||op.startsWith('routine:')||op.startsWith('family:')||op.startsWith('memory:')||op.startsWith('pro:')||op.startsWith('natural:')||op.startsWith('flow:')||op.startsWith('agent:');const url=required('SUPABASE_URL')+'/rest/v1/rpc/'+(op.startsWith('approval:')?'finance_approval':op.startsWith('worker:')?'finance_worker_context':op.startsWith('queue:')?'finance_queue':op.startsWith('ui:')?'finance_ui':op.startsWith('routine:')?'finance_routines':op.startsWith('family:')?'finance_family':op.startsWith('memory:')?'finance_memory':op==='agent:search'?'finance_movement_search':op==='agent:statement'?'finance_account_statement':op==='agent:trace'?'finance_worker_trace':op.startsWith('agent:')?'finance_agent':op.startsWith('flow:')?'finance_flow':op.startsWith('natural:')?'finance_natural':isPro?'finance_pro':'finance_api');const key=getRuntimeEnv('SUPABASE_SECRET_KEY')??required('SUPABASE_SERVICE_ROLE_KEY');
 const response=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json',apikey:key,Authorization:'Bearer '+key},body:JSON.stringify({op:isPro?op.split(':')[1]:op,data}),signal:signal?AbortSignal.any([signal,AbortSignal.timeout(20_000)]):AbortSignal.timeout(20_000)});
 if(!response.ok)throw Error('Error de base de datos ('+response.status+')');return response.json();
}
const telegramClient=createTelegramClientCache();
const currentTelegram=()=>telegramClient(required('TELEGRAM_BOT_TOKEN'));
export function telegram(method:string,body:Record<string,unknown>){return currentTelegram().telegram(method,body);}
export function telegramDocument(name:string,contents:string,route:Record<string,unknown>={}){return currentTelegram().telegramDocument(required('TELEGRAM_GROUP_ID'),name,contents,route);}
export function telegramFile(id:string){return currentTelegram().telegramFile(id);}
export async function transcribe(id:string){
 return transcribeAudio(await telegramFile(id),required('DEEPGRAM_API_KEY'));
}
function financialModel(deadline:number){return createFinancialModel({mode:'free',apiKey:required('OPENCODE_GO_API_KEY'),session:'finanzas-familiares-'+required('TELEGRAM_GROUP_ID'),deadline});}
export const {interpret,narrate,translateForEmbedding}=createInterpretationServices({model:financialModel,rpc:agentRpc,today,telegramFile});

async function agentRpc(op:string,data:any={},signal?:AbortSignal){
 if(op!=='memory:search')return rpc(op,data,signal);
 try{
  const response=await fetch(required('SUPABASE_URL')+'/functions/v1/memory',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+required('WORKER_SECRET')},body:JSON.stringify({action:'search',...data}),signal:signal?AbortSignal.any([signal,AbortSignal.timeout(18_000)]):AbortSignal.timeout(18_000)});
  if(!response.ok)throw Error('Memoria no disponible');return await response.json();
 }catch{signal?.throwIfAborted();return rpc('memory:search',data,signal);}
}
