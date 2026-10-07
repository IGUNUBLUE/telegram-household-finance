/** Authenticated test endpoint: fixed fictional fixtures and simulated tools only. */
import {loadRuntimeConfig,getConfig} from '../_shared/config.ts';
import {evaluateFramework,frameworkEvaluationCases} from '../_shared/framework-evaluation.ts';
import {createFreeProbeModel,freeProbeModels} from '../_shared/free-provider-probe.ts';
import {createFinancialModel,FREE_AGENT_MODEL} from '../_shared/llm-provider.ts';
import {generateText} from 'ai';
import {syntheticReceipt} from './synthetic-receipt.ts';

async function matches(value:string,expected:string){
 const digest=async(text:string)=>new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text)));
 const [a,b]=await Promise.all([digest(value),digest(expected)]);let different=0;
 for(let i=0;i<a.length;i++)different|=a[i]^b[i];return different===0;
}
Deno.serve(async(request:Request)=>{
 if(request.method!=='POST')return new Response('Method not allowed',{status:405});
 const authorization=request.headers.get('Authorization')??'';
 if(!authorization.startsWith('Bearer '))return new Response('Unauthorized',{status:401});
 let httpStatus:number|undefined;
 try{
  await loadRuntimeConfig();const secret=getConfig('WORKER_SECRET');
  if(!secret||!await matches(authorization.slice(7),secret))return new Response('Unauthorized',{status:401});
  const data=await request.json();const provider=data.provider??'opencode-zen';
  if(!Object.hasOwn(freeProbeModels,provider)||!freeProbeModels[provider as keyof typeof freeProbeModels].includes(data.model as never)||!(frameworkEvaluationCases.includes(data.fixture)||data.fixture==='vision'))return new Response('Invalid fixed fixture or free model',{status:400});
  const key=provider==='opencode-zen'?getConfig('OPENCODE_GO_API_KEY'):Deno.env.get('AI_GATEWAY_API_KEY');
  if(!key)return Response.json({ok:false,code:'missing_provider_key',provider},{status:503});
  const options={apiKey:key,deadline:Date.now()+65_000,fetch:async(url:RequestInfo|URL,init?:RequestInit)=>{const response=await fetch(url,init);httpStatus=response.status;return response;}};
  const model=provider==='opencode-zen'&&data.model===FREE_AGENT_MODEL
   ?createFinancialModel({...options,mode:'free',session:'synthetic-provider-evaluation'})
   :createFreeProbeModel({...options,provider,model:data.model});
  if(data.fixture==='vision'){
   const started=Date.now();const result=await generateText({model,maxRetries:0,maxOutputTokens:250,timeout:25_000,messages:[{role:'user',content:[{type:'text',text:'Lee el total COP en este recibo ficticio y responde solo con el número decimal, con punto para separar centavos y sin separadores de miles.'},{type:'image',image:syntheticReceipt,mediaType:'image/png'}]}]});
   return Response.json({ok:true,provider,model:data.model,synthetic_only:true,production_activated:false,http_status:httpStatus,fixture:'vision',passed:result.text.trim()==='12345.67',answer:result.text.slice(0,300),elapsed_ms:Date.now()-started});
  }
  const result=await evaluateFramework(data.fixture,model);
  return Response.json({ok:true,provider,model:data.model,synthetic_only:true,production_activated:false,http_status:httpStatus,...result});
 }catch{return Response.json({ok:false,code:'evaluation_unavailable',http_status:httpStatus},{status:503});}
});
