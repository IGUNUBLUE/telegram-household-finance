import {embedText,validEmbedding} from './memory.ts';
import type {rpc} from './io.ts';
type Dependencies={rpc:typeof rpc;translate:(text:string)=>Promise<string>;nativeEmbed:(text:string)=>Promise<number[]>;getSecret:()=>string|undefined;getMode:()=> 'edge'|'vps_subscription'};
export function createMemoryHandler(deps:Dependencies){
 const embedding=(text:string)=>embedText(text,deps.translate,deps.nativeEmbed);
 return async(req:Request):Promise<Response>=>{
  try{
   const secret=deps.getSecret();if(!secret||req.headers.get('Authorization')!=='Bearer '+secret)return Response.json({error:'Unauthorized'},{status:401});
   if(req.method!=='POST')return Response.json({error:'Method'},{status:405});
   const raw=await req.text();if(raw.length>4096)return Response.json({error:'Too large'},{status:413});
   const body=JSON.parse(raw),mode=deps.getMode();
   if(body.action==='embed'){
    if(typeof body.text!=='string'||!body.text.trim()||body.text.length>1800)return Response.json({error:'Invalid text'},{status:400});
    return Response.json({embedding:validEmbedding(await deps.nativeEmbed(body.text))});
   }
   if(body.action==='search'){
    if(!Number.isSafeInteger(body.id)||typeof body.query!=='string'||body.query.length<2||body.query.length>300)return Response.json({error:'Invalid search'},{status:400});
    const data={id:body.id,query:body.query,kind:body.kind??'all',from:body.from,to:body.to,account:body.account};
    const fallback=await deps.rpc('memory:search',data);
    if(mode==='vps_subscription')return Response.json(fallback);
    try{return Response.json(await deps.rpc('memory:search',{...data,embedding:await embedding(body.query)}));}catch{return Response.json(fallback);}
   }
   if(body.action==='index'){
    if(mode==='vps_subscription')return Response.json({delegated:true});
    const jobs=await deps.rpc('memory:next');let indexed=0,failed=0;
    for(const job of jobs){try{const result=await deps.rpc('memory:store',{key:job.key,hash:job.hash,lease:job.lease,embedding:await embedding(job.text)});if(result.stored)indexed++;else await deps.rpc('memory:fail',{key:job.key,lease:job.lease});}catch{failed++;await deps.rpc('memory:fail',{key:job.key,lease:job.lease});}}
    return Response.json({processed:indexed,batch_failed:failed,...await deps.rpc('memory:status')});
   }
   return Response.json({error:'Unknown action'},{status:400});
  }catch{return Response.json({error:'Memory unavailable'},{status:503});}
 };
}
