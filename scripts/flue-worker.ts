/** Entire Telegram runtime on the VPS; Supabase remains the ledger authority. */
import {waitForApprovalActivation} from '../supabase/functions/_shared/approval-domain.ts';
import {dirname,join} from 'node:path';
import {mkdir} from 'node:fs/promises';
import {setTimeout as sleep} from 'node:timers/promises';
import {loadWorkerConfig} from './lib/worker-config.ts';
import {openSubscriptionSession,type SubscriptionSession} from './lib/subscription-session.ts';
import {createPiRefresh,createProtectedPiProvider,FINANCE_MODEL} from './lib/pi-provider.ts';
import {createFinancialFlue} from './lib/flue-agent.ts';
import {createFlueInterpretationServices} from './lib/flue-interpretation.ts';
import {createSecureFlueSqlite,flueStatePath} from './lib/flue-sqlite.ts';
import {createLocalEmbedding,LOCAL_EMBEDDING_ID} from './lib/local-embedding.ts';
import {createTelegramPollingSource,runTelegramPolling} from './lib/telegram-polling.ts';
import {createTelegramTokenGuard} from './lib/telegram-token-guard.ts';
import {createVpsMemoryClient} from './lib/vps-memory.ts';
import {runWorkerLoop} from './lib/worker-loop.ts';
import {runWorkerServices} from './lib/flue-lifecycle.ts';
import {financialTools} from '../supabase/functions/_shared/agent-tools.ts';
import {createTelegramIntake} from '../supabase/functions/_shared/telegram-intake.ts';
import {createTelegramClientCache} from '../supabase/functions/_shared/telegram-client.ts';
import {executorMode} from '../supabase/functions/_shared/executor.ts';
const stop=new AbortController();const shutdown=()=>stop.abort();process.on('SIGTERM',shutdown);process.on('SIGINT',shutdown);
const log=(record:{status:string;eventId?:number})=>console.log(JSON.stringify(record));
const background=new Set<Promise<unknown>>();
let session:SubscriptionSession|undefined,runtime:Awaited<ReturnType<typeof createFinancialFlue>>|undefined;
try{
 const args=process.argv.slice(2);if(args.length!==2||args[0]!=='--config')throw Error('Invalid options');
 const config=await loadWorkerConfig(args[1]),directory=dirname(args[1]);
 process.env.SUPABASE_URL=config.SUPABASE_URL;process.env.SUPABASE_SERVICE_ROLE_KEY=config.SUPABASE_SERVICE_ROLE_KEY;
 const io=await import('../supabase/functions/_shared/io.ts');
 const {getConfig,loadRuntimeConfig}=await import('../supabase/functions/_shared/config.ts');await loadRuntimeConfig();
 if(executorMode(getConfig('FINANCE_EXECUTOR'))!=='vps_subscription')throw Error('VPS executor is not selected');
 const token=getConfig('TELEGRAM_BOT_TOKEN');if(!token)throw Error('Runtime configuration unavailable');
 const tokenGuard=createTelegramTokenGuard(token,stop);
 const loadOwnedConfig=async()=>{await loadRuntimeConfig();tokenGuard.assertCurrent(getConfig('TELEGRAM_BOT_TOKEN'));};
 session=await openSubscriptionSession({directory,refresh:createPiRefresh()});
 const response=await fetch('https://api.openai.com/v1/models',{headers:{Authorization:'Bearer '+await session.accessToken()},signal:AbortSignal.timeout(20000)});if(!response.ok)throw Error('Catalog unavailable');
 const provider=createProtectedPiProvider(session,await response.json());
 const cache=join(directory,'model-cache');await mkdir(cache,{recursive:true,mode:0o700});const embed=createLocalEmbedding(cache);
 await embed('Synthetic startup model check.',AbortSignal.timeout(60000));
 runtime=await createFinancialFlue({provider:provider as unknown as Parameters<typeof createFinancialFlue>[0]['provider'],db:await createSecureFlueSqlite(flueStatePath(directory),false),tools:financialTools});
 let memory:ReturnType<typeof createVpsMemoryClient>;
 const rpc:typeof io.rpc=(op,data={},signal)=>op==='memory:search'?memory.search(data as Record<string,unknown>,signal):io.rpc(op,data,signal);
 const services=createFlueInterpretationServices({runtime,rpc,today:io.today,telegramFile:io.telegramFile});
 memory=createVpsMemoryClient({rpc:io.rpc,model:LOCAL_EMBEDDING_ID,embed});
 const client=createTelegramClientCache()(token),bot=await client.botInfo();
 const polling=createTelegramPollingSource(token,join(directory,'telegram-cursor-'+bot.id+'.json'));
 await polling.verifyNoWebhook();
 let wake=new AbortController();
 const waitUntil=(task:Promise<unknown>)=>{const safe=task.catch(()=>{log({status:'telegram_presence_unavailable'});});background.add(safe);void safe.finally(()=>background.delete(safe));};
 const intake=createTelegramIntake({loadConfig:loadOwnedConfig,getConfig,getClient:()=>client,rpc:io.rpc,waitUntil,wakeWorker:async()=>{wake.abort();},log:()=>log({status:'telegram_intake_unavailable'})});
 let failed=false,lastDue=-Infinity;
 const engine=(await import('../supabase/functions/_shared/worker-engine.ts')).createWorkerEngine({...io,...services,getConfig,botUsername:bot.username,model:FINANCE_MODEL,onProviderUnavailable:()=>{failed=true;},canClaim:async()=>!failed&&!stop.signal.aborted&&executorMode(getConfig('FINANCE_EXECUTOR'))==='vps_subscription',log:record=>{if(record.status==='event_failed')failed=true;log(record);}});
 const allowed=()=>!stop.signal.aborted&&executorMode(getConfig('FINANCE_EXECUTOR'))==='vps_subscription';
 console.log(JSON.stringify({status:'flue_worker_ready',model:FINANCE_MODEL,embedding_model:LOCAL_EMBEDDING_ID}));
 await waitForApprovalActivation(io.rpc,()=>sleep(2000,undefined,{signal:stop.signal}),stop.signal);
 await runWorkerServices([
  ()=>runTelegramPolling({...polling,admit:async update=>{await loadOwnedConfig();if(!allowed())throw Error('Intake owner unavailable');return intake(update);},sleep:async(ms,signal)=>{await sleep(ms,undefined,{signal});},log:status=>log({status})},stop.signal),
  ()=>runWorkerLoop({tick:async()=>{
   await loadOwnedConfig();if(!allowed())return false;failed=false;
   if(Date.now()-lastDue>=60000){lastDue=Date.now();await io.rpc('due',{today:io.today()});await io.rpc('routine:due',{today:io.today()});await io.rpc('approval:due');}
   const result=await engine.runBatch();if(failed)throw Error('Event unavailable');return result.processed>0;
  },index:async()=>{if(!allowed())return false;return memory.indexBatch(stop.signal);},sleep:async(ms,signal)=>{
   const interrupted=AbortSignal.any([signal,wake.signal]);try{await sleep(ms,undefined,{signal:interrupted});}catch{signal.throwIfAborted();}finally{wake=new AbortController();}
  },log},stop.signal),
 ],stop);
 tokenGuard.requireHealthy();
 await Promise.allSettled(background);log({status:'flue_worker_stopped'});
}catch{stop.abort();log({status:'flue_worker_start_or_runtime_failed'});process.exitCode=1;}
finally{await Promise.allSettled(background);await runtime?.close().catch(()=>{process.exitCode=1;});await session?.close().catch(()=>{process.exitCode=1;});process.off('SIGTERM',shutdown);process.off('SIGINT',shutdown);}
