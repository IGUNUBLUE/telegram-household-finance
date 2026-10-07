import {rpc} from '../_shared/io.ts';
import {loadRuntimeConfig,getConfig} from '../_shared/config.ts';
import {createTelegramClientCache} from '../_shared/telegram-client.ts';
import {createTelegramHandler} from '../_shared/telegram-intake.ts';
Deno.serve(createTelegramHandler({
 loadConfig:loadRuntimeConfig,getConfig,getClient:createTelegramClientCache(),rpc,
 waitUntil:task=>EdgeRuntime.waitUntil(task),log:message=>console.error(message),
 wakeWorker:async()=>{
  const response=await fetch(getConfig('SUPABASE_URL')+'/functions/v1/worker',{method:'POST',headers:{Authorization:'Bearer '+getConfig('WORKER_SECRET')},signal:AbortSignal.timeout(110_000)});
  if(!response.ok)throw Error('Worker unavailable');
 },
}));
