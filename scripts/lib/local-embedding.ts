import {validEmbedding} from '../../supabase/functions/_shared/memory.ts';
export const LOCAL_EMBEDDING_REVISION='761b726dd34fb83930e26aab4e9ac3899aa1fa78';
export const LOCAL_EMBEDDING_MODEL='Xenova/multilingual-e5-small';
export const LOCAL_EMBEDDING_ID='multilingual-e5-small-es-q8-v1';
type Extractor=(text:string,args:{pooling:'mean';normalize:true;truncation:true;max_length:512})=>Promise<{tolist:()=>number[][]}>;
type Options={revision:string;dtype:'q8';cache_dir:string;device:'cpu';session_options:{intraOpNumThreads:1;interOpNumThreads:1;executionMode:'sequential'}};
async function load(options:Options):Promise<Extractor>{
 const {pipeline}=await import('@huggingface/transformers');
 return await pipeline('feature-extraction',LOCAL_EMBEDDING_MODEL,options) as unknown as Extractor;
}
/** CPU inference stays on the VPS; only public model files are downloaded. */
export function createLocalEmbedding(cacheDirectory:string,loader:(options:Options)=>Promise<Extractor>=load){
 let initialized:Promise<Extractor>|undefined,tail=Promise.resolve();
 return async(text:string,signal?:AbortSignal,kind:'query'|'passage'='query'):Promise<number[]>=>{
  signal?.throwIfAborted();if(!text.trim()||text.length>1800)throw Error('Texto fuera de límites');
  if(!initialized)initialized=loader({revision:LOCAL_EMBEDDING_REVISION,dtype:'q8',cache_dir:cacheDirectory,device:'cpu',session_options:{intraOpNumThreads:1,interOpNumThreads:1,executionMode:'sequential'}}).catch(()=>{initialized=undefined;throw Error('Modelo local no disponible');});
  const extractor=await initialized;signal?.throwIfAborted();
  // Keep CPU load bounded even when indexing and a foreground search overlap.
  const work=tail.then(async()=>{signal?.throwIfAborted();const result=await extractor((kind==='query'?'query: ':'passage: ')+text,{pooling:'mean',normalize:true,truncation:true,max_length:512});signal?.throwIfAborted();return validEmbedding(result.tolist()[0]);});
  tail=work.then(()=>{},()=>{});return work;
 };
}
