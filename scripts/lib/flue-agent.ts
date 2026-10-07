import {AsyncLocalStorage} from 'node:async_hooks';
import {init,instrument,useModel,useTool,useInitialData,useAgentStart,useDataWriter,type ToolInputSchema} from '@flue/runtime';
import {start,type sqlite} from '@flue/runtime/node';
import {createAssistantMessageEventStream} from 'pi-native/utils/event-stream';
import type {Provider} from '@earendil-works/pi-ai';
import {normalizeContext,getDeclaredTools} from '@earendil-works/pi-ai/utils/transcript';
import * as v from 'valibot';
import {z} from 'zod';
import type {AgentMetrics} from '../../supabase/functions/_shared/agent.ts';
import type {FinancialTool,ToolOutcome} from '../../supabase/functions/_shared/tools/types.ts';
import {requireCompletePiMessage} from './pi-provider.ts';

/** Preserve the existing Zod contract; Flue explicitly requires Valibot objects. */
export function flueToolInput(input:z.ZodType):ToolInputSchema{
 const schema=z.toJSONSchema(input,{target:'draft-7',io:'input'});
 function convert(s:any):v.GenericSchema{
  let result:v.GenericSchema;
  if(s.enum)result=v.picklist(s.enum);
  else if(s.type==='object'){
   const fields:Record<string,v.GenericSchema>={};
   for(const [key,value] of Object.entries(s.properties??{}))fields[key]=(s.required??[]).includes(key)?convert(value):v.optional(convert(value));
   result=v.strictObject(fields);
  }else if(s.type==='array')result=v.array(convert(s.items));
  else if(s.type==='integer')result=v.pipe(v.number(),v.integer());
  else if(s.type==='boolean')result=v.boolean();
  else if(s.type==='string')result=v.string();
  else throw Error('Unsupported financial schema');
  const checks:any[]=[];
  if(s.minLength!==undefined)checks.push(v.minLength(s.minLength));
  if(s.maxLength!==undefined)checks.push(v.maxLength(s.maxLength));
  if(s.minItems!==undefined)checks.push(v.minLength(s.minItems));
  if(s.maxItems!==undefined)checks.push(v.maxLength(s.maxItems));
  if(s.minimum!==undefined)checks.push(v.minValue(s.minimum));
  if(s.maximum!==undefined)checks.push(v.maxValue(s.maximum));
  if(s.pattern)checks.push(v.regex(new RegExp(s.pattern)));
  if(s.description)checks.push(v.description(s.description));
  return checks.length?v.pipe(result,...checks):result;
 }
 if(schema.type!=='object')throw Error('Financial tool input must be an object');
 return convert(schema) as ToolInputSchema;
}
type Run={key:string;instructions:string;text:string;image?:Uint8Array;dispatch:(name:string,args:unknown,signal:AbortSignal)=>Promise<ToolOutcome>;tools?:boolean;maxSteps?:number;timeoutMs?:number;onMetrics?:(metrics:AgentMetrics)=>void};
type Turn=Run&{signal:AbortSignal;rounds:number;inputTokens:number;outputTokens:number;toolMetrics:AgentMetrics['tools'];controller:AbortController;failure?:Error};
type Options={provider:Provider;model?:string;db?:ReturnType<typeof sqlite>;tools:Pick<FinancialTool,'name'|'description'|'inputSchema'|'readOnly'>[]};

/** One runtime per process, execution identity per verified event attempt. */
export async function createFinancialFlue(options:Options){
 const active=new Map<string,Turn>(),scope=new AsyncLocalStorage<Turn>();
 const registry=new Map(options.tools.map(t=>[t.name,t]));
 const native=options.provider;
 const provider:Provider={...native,streamSimple(model,context,request){
  const turn=scope.getStore();
  if(!turn||turn.signal.aborted)throw Error('No active financial attempt');
  if(++turn.rounds>(turn.maxSteps??5))throw Error('Financial round budget exhausted');
  const final=turn.rounds===(turn.maxSteps??5);
  const tools=turn.tools===false||final?[]:getDeclaredTools(context.messages).filter(t=>registry.has(t.name));
  let firstSystem=true;
  const messages=context.messages.map(m=>{
   if(m.role!=='system')return m;
   // Flue appends its server clock and task roster; the verified application
   // instructions own the local financial date and the available operations.
   const content=firstSystem?turn.instructions:m.content;firstSystem=false;
   return {...m,content,toolsAdded:m.toolsAdded?.filter(t=>tools.some(allowed=>allowed.name===t.name)),toolsRemoved:m.toolsRemoved?.filter(t=>registry.has(t.name))};
  });
  const transcript=normalizeContext({messages,...final?{systemPrompt:'Responde ahora con los datos comprobados; no uses más herramientas.'}:{}});
  const source=native.streamSimple(model,transcript,{...request,maxTokens:1800,signal:AbortSignal.any([turn.signal,request?.signal??turn.signal])});
  const output=createAssistantMessageEventStream();
  void (async()=>{
   let partial:any;
   try{
    for await(const event of source){
     turn.signal.throwIfAborted();
     if(event.type==='done'){
      const message=requireCompletePiMessage(event.message);
      const calls=message.content.filter(p=>p.type==='toolCall');
      if(calls.some(c=>!tools?.some(t=>t.name===c.name))||calls.length>4||calls.length>1&&calls.some(c=>!registry.get(c.name)?.readOnly))throw Error('Operaciones simultáneas o no permitidas.');
      turn.inputTokens+=message.usage?.input??0;turn.outputTokens+=message.usage?.output??0;
     }
     if(event.type==='error')throw Error('Modelo no disponible.');
     if('partial' in event)partial=event.partial;
     output.push(event as Parameters<typeof output.push>[0]);
    }
    output.end();
   }catch{
    turn.failure=Error('Respuesta del modelo incompleta, vencida o no permitida.');
    const error={...partial,role:'assistant' as const,content:[],api:model.api,provider:model.provider,model:model.id,timestamp:Date.now(),usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:'error' as const,errorMessage:'Modelo no disponible.'};
    output.push({type:'error',reason:'error',error});output.end(error);
   }
  })();
  return output as unknown as ReturnType<Provider['streamSimple']>;
 }};
 function FinanceAgent(){
  const {key}=useInitialData<{key:string}>();
  useModel(options.model??'openai/gpt-5.6-luna',{compaction:false});
  const writeAction=useDataWriter('financial_action');
  useAgentStart(()=>{if(!active.has(key))throw Error('Financial attempt requires a fresh queue claim');});
  for(const tool of options.tools)useTool({name:tool.name,description:tool.description,input:flueToolInput(tool.inputSchema),timeoutMs:25000,annotations:{readOnlyHint:!!tool.readOnly},async run({data,signal}){
   const turn=active.get(key);if(!turn)throw Error('Financial attempt no longer active');
   const combined=AbortSignal.any([turn.signal,signal??turn.signal]);combined.throwIfAborted();
   const record={name:tool.name,status:'ok'};turn.toolMetrics.push(record);
   try{
    const parsed=tool.inputSchema.parse(data);
    const outcome=await turn.dispatch(tool.name,parsed,combined);combined.throwIfAborted();
    if(outcome.action){writeAction(outcome.action);return {output:{status:'prepared_for_server'},terminate:true};}
    return {output:outcome.result??{status:'ok'}};
   }catch{record.status='error';combined.throwIfAborted();return {output:{status:'needs_clarification',message:'No se pudo completar la herramienta; revisa los datos.'}};}
  }});
  return active.get(key)?.instructions??'No ejecutas operaciones sin un evento autorizado activo.';
 }
 FinanceAgent.agentName='finance-event-v1';
 FinanceAgent.initialData=v.object({key:v.string()});
 FinanceAgent.durability={maxAttempts:1,timeoutMs:65000};
 const dispose=instrument({observe:()=>{},dispose:()=>{},interceptor:async(operation,ctx,next)=>{
  if(operation.type!=='model')return next();
  const turn=ctx.instanceId?active.get(ctx.instanceId):undefined;
  if(!turn)throw Error('No active verified financial event');
  return scope.run(turn,next);
 }});
 let runtime:Awaited<ReturnType<typeof start>>;
 try{runtime=await start({agents:[FinanceAgent],providers:[provider],db:options.db,env:{}});}catch(e){await dispose();throw e;}
 return {
  async run(request:Run):Promise<any>{
   if(!request.key||active.has(request.key))throw Error('Financial attempt is already active');
   const started=Date.now(),controller=new AbortController();
   const signal=AbortSignal.any([controller.signal,AbortSignal.timeout(request.timeoutMs??65000)]);
   const turn:Turn={...request,signal,controller,rounds:0,inputTokens:0,outputTokens:0,toolMetrics:[]};active.set(request.key,turn);
   const handle=init(FinanceAgent,{id:request.key});
   try{
    const receipt=await handle.dispatch({initialData:{key:request.key},idempotencyKey:'financial-turn',message:{kind:'user',body:request.text,...request.image?{attachments:[{type:'image' as const,data:Buffer.from(request.image).toString('base64'),mimeType:'image/jpeg'}]}:{}}});
    const reply=await handle.read(receipt,{signal});signal.throwIfAborted();
    if(turn.failure)throw turn.failure;
    const actions=reply.data.financial_action??[];
    if(actions.length>1)throw Error('Multiple terminal actions');
    if(actions.length===1)return actions[0];
    if(!reply.text.trim()||reply.text.length>2000)throw Error('Empty or incomplete financial reply');
    return {type:'clarify',question:reply.text.trim()};
   }catch{await handle.abort().catch(()=>{});throw Error('Interpretación financiera no disponible.');}
   finally{
    controller.abort();active.delete(request.key);
    request.onMetrics?.({rounds:turn.rounds,elapsed_ms:Date.now()-started,input_tokens:turn.inputTokens,output_tokens:turn.outputTokens,tools:turn.toolMetrics});
   }
  },
  async close(){for(const turn of active.values())turn.controller.abort();await runtime.stop();await dispose();}
 };
}
