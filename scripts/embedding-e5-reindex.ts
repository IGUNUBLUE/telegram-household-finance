/** Rebuild only E5 memory vectors; never calls an LLM, Telegram or ledger mutations. */
import {dirname,join} from 'node:path';
import {createLocalEmbedding,LOCAL_EMBEDDING_ID} from './lib/local-embedding.ts';
import {createVpsMemoryClient} from './lib/vps-memory.ts';
import {loadWorkerConfig} from './lib/worker-config.ts';
let stage='config';
try{
 const args=process.argv.slice(2);if(args.length!==2||args[0]!=='--config')throw Error('options');
 const config=await loadWorkerConfig(args[1]);
 process.env.SUPABASE_URL=config.SUPABASE_URL;process.env.SUPABASE_SERVICE_ROLE_KEY=config.SUPABASE_SERVICE_ROLE_KEY;
 const {rpc}=await import('../supabase/functions/_shared/io.ts');
 const embed=createLocalEmbedding(join(dirname(args[1]),'model-cache'));
 stage='model';await embed('Prueba sintética de memoria',AbortSignal.timeout(60000));
 const memory=createVpsMemoryClient({rpc,embed,model:LOCAL_EMBEDDING_ID});
 stage='index';let batches=0;while(await memory.indexBatch(AbortSignal.timeout(60000))){if(++batches>500)throw Error('Index did not settle');if(batches%10===0)console.log(JSON.stringify({status:'e5_index_progress',batches}));}
 const status=await rpc('memory:status',{model:LOCAL_EMBEDDING_ID});
 if(status.indexed!==status.sources||status.failed!==0)throw Error('Index incomplete');
 console.log(JSON.stringify({status:'e5_index_complete',model:LOCAL_EMBEDDING_ID,batches,...status,financial_writes:0,telegram_sends:0,rss_bytes:process.memoryUsage().rss}));
}catch{console.log(JSON.stringify({status:'e5_index_failed',stage}));process.exitCode=1;}
