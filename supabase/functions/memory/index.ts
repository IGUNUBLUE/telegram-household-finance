import {loadRuntimeConfig,getConfig} from '../_shared/config.ts';
import {rpc,translateForEmbedding} from '../_shared/io.ts';
import {executorMode} from '../_shared/executor.ts';
import {createMemoryHandler} from '../_shared/memory-handler.ts';
const handler=createMemoryHandler({rpc,translate:translateForEmbedding,nativeEmbed:async text=>{const session=new (globalThis as any).Supabase.ai.Session('gte-small');return session.run(text,{mean_pool:true,normalize:true});},getSecret:()=>getConfig('WORKER_SECRET'),getMode:()=>executorMode(getConfig('FINANCE_EXECUTOR'))});
Deno.serve(async req=>{try{await loadRuntimeConfig();return await handler(req);}catch{return Response.json({error:'Memory unavailable'},{status:503});}});
