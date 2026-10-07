import {embedText,validEmbedding} from '../../supabase/functions/_shared/memory.ts';
import type {rpc} from '../../supabase/functions/_shared/io.ts';
export function createVpsMemoryClient(deps:{rpc:typeof rpc;model?:'multilingual-e5-small-es-q8-v1';translate?:(text:string)=>Promise<string>;embed:(text:string,signal?:AbortSignal,kind?:'query'|'passage')=>Promise<number[]>}){
 const tag=deps.model?{model:deps.model}:{};
 const embeddingFor=async(text:string,kind:'query'|'passage',signal?:AbortSignal)=>{
  if(deps.model){if(!text.trim()||text.length>1000)throw Error('Texto fuera de límites');return validEmbedding(await deps.embed(text,signal,kind));}
  if(!deps.translate)throw Error('Traducción no disponible');return embedText(text,deps.translate,t=>deps.embed(t,signal));
 };
 async function search(data:Record<string,unknown>,signal?:AbortSignal){
  signal?.throwIfAborted();
  // SQL checks event membership and authorizes all filters before inference.
  const fallback=await deps.rpc('memory:search',{...data,...tag},signal);
  try{
   signal?.throwIfAborted();const text=String(data.query??'');
   const embedding=await embeddingFor(text,'query',signal);signal?.throwIfAborted();
   return await deps.rpc('memory:search',{...data,...tag,embedding:validEmbedding(embedding)},signal);
  }catch{signal?.throwIfAborted();return fallback;}
 }
 async function indexBatch(signal?:AbortSignal){
  signal?.throwIfAborted();const jobs=await deps.rpc('memory:next',tag,signal);let failed=false;
  for(const job of jobs){
   try{signal?.throwIfAborted();const embedding=await embeddingFor(job.text,'passage',signal);signal?.throwIfAborted();const result=await deps.rpc('memory:store',{key:job.key,hash:job.hash,lease:job.lease,...tag,embedding},signal);if(!result.stored)await deps.rpc('memory:fail',{key:job.key,lease:job.lease,...tag});}
   catch{failed=true;try{await deps.rpc('memory:fail',{key:job.key,lease:job.lease,...tag});}catch{/* Existing lease expiration recovers a failed backend call. */}}
  }
  signal?.throwIfAborted();if(failed)throw Error('Memory indexing unavailable');return jobs.length>0;
 }
 return {search,indexBatch};
}
