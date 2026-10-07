/** Experimental SIWC adapter. Not selected by the deployed worker until live OAuth evaluation passes. */
import {createOpenAI} from '@ai-sdk/openai';
const endpoint='https://api.openai.com/v1/responses';
const omitted=['background','conversation','max_output_tokens','max_tool_calls','metadata','moderation','multi_agent','prompt','prompt_cache_retention','safety_identifier','temperature','top_logprobs','top_p','truncation','user','previous_response_id'];
export class SubscriptionUnavailable extends Error{
 readonly code:string;
 constructor(code:string){super('Suscripción no disponible ('+code+')');this.code=code;}
}
function planRequest(body:any){
 const result={...body,store:false,stream:true};for(const k of omitted)delete result[k];
 result.input=(body.input??[]).map((item:any)=>item.role==='system'?{...item,role:'developer'}:item.type==='function_call'?{...item,namespace:'finance'}:item);
 const functions=(body.tools??[]).filter((t:any)=>t.type==='function');
 if(functions.length!==(body.tools??[]).length)throw new SubscriptionUnavailable('unsupported_tool');
 result.tools=functions.length?[{type:'namespace',name:'finance',description:'Herramientas verificables del asistente financiero.',tools:functions}]:[];
 return result;
}
async function completedResponse(response:Response,signal:AbortSignal){
 if(!response.ok)throw new SubscriptionUnavailable('http_'+response.status);
 const contentType=response.headers.get('content-type');
 // Some transports omit Content-Type; completion is still validated from SSE events below.
 if((contentType&&!contentType.toLowerCase().includes('text/event-stream'))||!response.body)throw new SubscriptionUnavailable('invalid_stream');
 const reader=response.body.getReader(),decoder=new TextDecoder();let pending='',bytes=0,completed:any;
 const finishedItems=new Map<number,any>();
 const parse=(block:string)=>{
  const data=block.split(/\r?\n/).filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trimStart()).join('\n');
  if(!data||data==='[DONE]')return;
  let event:any;try{event=JSON.parse(data);}catch{throw new SubscriptionUnavailable('invalid_event');}
  if(event.type==='response.output_item.done'){
   if(!Number.isInteger(event.output_index)||event.output_index<0||!event.item||typeof event.item!=='object')throw new SubscriptionUnavailable('invalid_event');
   if(finishedItems.has(event.output_index))throw new SubscriptionUnavailable('invalid_event');
   finishedItems.set(event.output_index,event.item);
  }
  if(['response.failed','response.incomplete','error'].includes(event.type)){
   const code=event.response?.error?.code??event.error?.code;
   throw new SubscriptionUnavailable(['subscription_sharing_usage_limit_exceeded','subscription_sharing_usage_unavailable'].includes(code)?code:'failed_response');
  }
  if(event.type==='response.completed'){
   if(event.response?.status!=='completed'||!Array.isArray(event.response.output))throw new SubscriptionUnavailable('invalid_completion');
   completed=event.response;
  }
 };
 const abort=()=>{void reader.cancel().catch(()=>{});};signal.addEventListener('abort',abort,{once:true});
 try{
  while(true){signal.throwIfAborted();const {value,done}=await reader.read();signal.throwIfAborted();if(done)break;
   bytes+=value.byteLength;if(bytes>4*1024*1024)throw new SubscriptionUnavailable('response_too_large');
   pending+=decoder.decode(value,{stream:true});let match:RegExpExecArray|null;
   while((match=/\r?\n\r?\n/.exec(pending))){const block=pending.slice(0,match.index);pending=pending.slice(match.index+match[0].length);parse(block);}
  }
  pending+=decoder.decode();if(pending.trim())parse(pending);
  if(!completed)throw new SubscriptionUnavailable('interrupted_stream');
  if(completed.output.length===0&&finishedItems.size){
   const output=[];
   for(let index=0;index<finishedItems.size;index++){
    if(!finishedItems.has(index))throw new SubscriptionUnavailable('invalid_completion');
    output.push(finishedItems.get(index));
   }
   completed={...completed,output};
  }
  return completed;
 }finally{signal.removeEventListener('abort',abort);await reader.cancel().catch(()=>{});reader.releaseLock();}
}
export function createSubscriptionModel(options:{accessToken:()=>Promise<string>;model:string;deadline:number;fetch?:typeof fetch}){
 const send=options.fetch??fetch;
 return createOpenAI({apiKey:'oauth-managed-by-transport',baseURL:endpoint.slice(0,-'/responses'.length),fetch:async(url,init)=>{
  if(String(url)!==endpoint)throw new SubscriptionUnavailable('invalid_endpoint');
  const remaining=options.deadline-Date.now();if(remaining<1000)throw new SubscriptionUnavailable('deadline');
  const signal=init?.signal?AbortSignal.any([init.signal,AbortSignal.timeout(Math.min(25_000,remaining))]):AbortSignal.timeout(Math.min(25_000,remaining));
  const token=await options.accessToken();signal.throwIfAborted();
  const headers=new Headers(init?.headers);headers.set('Authorization','Bearer '+token);headers.set('Accept','text/event-stream');headers.set('User-Agent','finanzas-familiares/subscription-probe');
  const response=await send(url,{...init,headers,body:JSON.stringify(planRequest(JSON.parse(String(init?.body)))),signal});
  const completed=await completedResponse(response,signal);
  return Response.json(completed);
 }}).responses(options.model);
}
