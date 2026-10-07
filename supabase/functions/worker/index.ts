import {executorMode} from '../_shared/executor.ts';
import * as io from '../_shared/io.ts';
import {createWorkerEngine} from '../_shared/worker-engine.ts';
import {loadRuntimeConfig,getConfig} from '../_shared/config.ts';
const engine=createWorkerEngine({...io,getConfig,canClaim:async()=>{await loadRuntimeConfig();return executorMode(getConfig('FINANCE_EXECUTOR'))==='edge';},log:record=>console.error(JSON.stringify(record))});
Deno.serve(async req=>{
 if(!req.headers.get('Authorization'))return new Response('unauthorized',{status:401});
 try{await loadRuntimeConfig();}catch{return new Response('configuration unavailable',{status:503});}
 const key=getConfig('WORKER_SECRET');if(!key||req.headers.get('Authorization')!=='Bearer '+key)return new Response('unauthorized',{status:401});
 try{await io.rpc('due',{today:io.today()});await io.rpc('routine:due',{today:io.today()});const drained=await engine.runBatch();
  if(drained.handoff)EdgeRuntime.waitUntil(fetch(getConfig('SUPABASE_URL')+'/functions/v1/worker',{method:'POST',headers:{Authorization:'Bearer '+key},signal:AbortSignal.timeout(110_000)}).catch(()=>{console.error('Worker handoff unavailable; cron will retry');}));
  return Response.json({ok:true});}
 catch(e){console.error('worker_failed');return new Response('temporary failure',{status:503});}
});
