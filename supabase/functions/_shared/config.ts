import {getRuntimeEnv} from './runtime-env.ts';
const names=['TELEGRAM_GROUP_ID','TELEGRAM_BOT_TOKEN','OPENCODE_GO_API_KEY','TELEGRAM_WEBHOOK_SECRET','WORKER_SECRET','DEEPGRAM_API_KEY','FINANCE_EXECUTOR','FLUE_DATABASE_PASSWORD'];
const initial=Object.fromEntries(names.map(name=>[name,getRuntimeEnv(name)]));
let values:Record<string,string|undefined>={...initial};
export function getConfig(name:string):string|undefined{return names.includes(name)?values[name]:getRuntimeEnv(name);}
let pending:Promise<void>|undefined;
let loadedAt=0;
export async function loadRuntimeConfig():Promise<void>{
 if(loadedAt&&Date.now()-loadedAt<60_000)return;
 if(pending)return pending;
 pending=(async()=>{
  const url=getRuntimeEnv('SUPABASE_URL');
  const key=getRuntimeEnv('SUPABASE_SERVICE_ROLE_KEY');
  if(!url||!key)throw Error('Configuración de Supabase no disponible');
  const res=await fetch(url+'/rest/v1/rpc/finance_runtime_config',{method:'POST',headers:{apikey:key,Authorization:'Bearer '+key,'Content-Type':'application/json'},body:'{}',signal:AbortSignal.timeout(10_000)});
  if(!res.ok)throw Error('No se pudo cargar configuración privada');
  const config=await res.json();
  values=Object.fromEntries(names.map(name=>[name,typeof config[name]==='string'?config[name].trim():initial[name]]));
  loadedAt=Date.now();
 })();
 try{await pending;}finally{pending=undefined;}
}
