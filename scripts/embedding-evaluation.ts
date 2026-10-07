/** Synthetic local E5 check. No Edge, LLM, ledger or Telegram request. */
import {dirname,join} from 'node:path';
import {loadWorkerConfig} from './lib/worker-config.ts';
import {createLocalEmbedding,LOCAL_EMBEDDING_ID,LOCAL_EMBEDDING_REVISION} from './lib/local-embedding.ts';
let stage='config';
try{
 const args=process.argv.slice(2);if(args.length!==2||args[0]!=='--config')throw Error('options');
 await loadWorkerConfig(args[1]);
 const embed=createLocalEmbedding(join(dirname(args[1]),'model-cache'));
 const samples=['Pago del arriendo de octubre','Traslado desde Reserva hacia Principal','Saldo inicial de una tarjeta con centavos','Comida para el gato'];
 const elapsed:number[]=[];const cosine:number[]=[];
 stage='local_model';
 for(const text of samples){
  const start=Date.now();const first=await embed(text,undefined,'query');elapsed.push(Date.now()-start);
  const repeated=await embed(text,undefined,'query');cosine.push(first.reduce((sum,n,i)=>sum+n*repeated[i],0)/(Math.hypot(...first)*Math.hypot(...repeated)));
 }
 const passed=cosine.every(n=>n>=0.9999);
 console.log(JSON.stringify({status:'embedding_evaluation_complete',model:LOCAL_EMBEDDING_ID,revision:LOCAL_EMBEDDING_REVISION,passed,cosine,elapsed_ms:elapsed,rss_bytes:process.memoryUsage().rss,financial_writes:0,telegram_sends:0,llm_calls:0}));if(!passed)process.exitCode=1;
}catch{console.log(JSON.stringify({status:'embedding_evaluation_unavailable',stage}));process.exitCode=1;}
