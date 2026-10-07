/** Private Node backend. No HTTP listener, shell tools or financial state on disk. */
import {dirname} from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';
import {loadWorkerConfig} from './lib/worker-config.ts';
import {openSubscriptionSession,type SubscriptionSession} from './lib/subscription-session.ts';
import {runWorkerLoop} from './lib/worker-loop.ts';
import {createVpsMemoryClient} from './lib/vps-memory.ts';
import {selectSubscriptionModel} from './lib/subscription-catalog.ts';
import {createSubscriptionModel} from '../supabase/functions/_shared/subscription-provider.ts';
import {createInterpretationServices} from '../supabase/functions/_shared/interpretation.ts';
import {executorMode} from '../supabase/functions/_shared/executor.ts';
import {validEmbedding} from '../supabase/functions/_shared/memory.ts';
const model='gpt-5.6-luna' as const;
const stop=new AbortController();let session:SubscriptionSession|undefined;
const shutdown=()=>stop.abort();process.on('SIGTERM',shutdown);process.on('SIGINT',shutdown);
const log=(record:{status:string;eventId?:number})=>console.log(JSON.stringify(record));
try{
 const args=process.argv.slice(2);if(args.length!==2||args[0]!=='--config')throw Error('Invalid options');
 const config=await loadWorkerConfig(args[1]);
 process.env.SUPABASE_URL=config.SUPABASE_URL;process.env.SUPABASE_SERVICE_ROLE_KEY=config.SUPABASE_SERVICE_ROLE_KEY;
 // Config snapshots are initialized only after the explicit private fields are loaded.
 const io=await import('../supabase/functions/_shared/io.ts');
 const {createWorkerEngine}=await import('../supabase/functions/_shared/worker-engine.ts');
 const {getConfig,loadRuntimeConfig}=await import('../supabase/functions/_shared/config.ts');
 session=await openSubscriptionSession({directory:dirname(args[1])});
 const accessToken=session.accessToken;
 const catalog=await fetch('https://api.openai.com/v1/models',{headers:{Authorization:'Bearer '+await accessToken()},signal:AbortSignal.timeout(20000)});
 if(!catalog.ok)throw Error('Catalog unavailable');selectSubscriptionModel(await catalog.json(),model);
 let memory:ReturnType<typeof createVpsMemoryClient>;
 const agentRpc:typeof io.rpc=(op,data={},signal)=>op==='memory:search'?memory.search(data as Record<string,unknown>,signal):io.rpc(op,data,signal);
 const services=createInterpretationServices({model:deadline=>createSubscriptionModel({accessToken,model,deadline}),rpc:agentRpc,today:io.today,telegramFile:io.telegramFile});
 memory=createVpsMemoryClient({rpc:io.rpc,translate:services.translateForEmbedding,embed:async(text,signal)=>{
  const secret=getConfig('WORKER_SECRET');if(!secret)throw Error('Memory configuration unavailable');
  const response=await fetch(config.SUPABASE_URL+'/functions/v1/memory',{method:'POST',headers:{Authorization:'Bearer '+secret,'Content-Type':'application/json'},body:JSON.stringify({action:'embed',text}),signal:signal?AbortSignal.any([signal,AbortSignal.timeout(18000)]):AbortSignal.timeout(18000)});
  if(!response.ok)throw Error('Native memory unavailable');return validEmbedding((await response.json()).embedding);
 }});
 let failed=false,lastDue=-Infinity;
 const engine=createWorkerEngine({...io,...services,getConfig,model,onProviderUnavailable:()=>{failed=true;},canClaim:async()=>{await loadRuntimeConfig();return !failed&&!stop.signal.aborted&&executorMode(getConfig('FINANCE_EXECUTOR'))==='vps_subscription';},log:record=>{if(record.status==='event_failed')failed=true;log(record);}});
 log({status:'worker_ready'});
 await runWorkerLoop({tick:async()=>{
  await loadRuntimeConfig();const mode=executorMode(getConfig('FINANCE_EXECUTOR'));failed=false;
  if(mode==='vps_subscription'&&Date.now()-lastDue>=60000){lastDue=Date.now();await io.rpc('due',{today:io.today()});await io.rpc('routine:due',{today:io.today()});}
  const result=await engine.runBatch();if(failed)throw Error('Event unavailable');return result.processed>0;
 },index:async()=>{await loadRuntimeConfig();if(stop.signal.aborted||executorMode(getConfig('FINANCE_EXECUTOR'))!=='vps_subscription')return false;return memory.indexBatch();},sleep:async(ms,signal)=>{await sleep(ms,undefined,{signal});},log},stop.signal);
 log({status:'worker_stopped'});
}catch{log({status:'worker_start_failed'});process.exitCode=1;}
finally{await session?.close().catch(()=>{log({status:'session_close_failed'});process.exitCode=1;});process.off('SIGTERM',shutdown);process.off('SIGINT',shutdown);}
