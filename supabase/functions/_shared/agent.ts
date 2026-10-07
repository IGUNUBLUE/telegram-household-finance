import {ToolLoopAgent,tool,isStepCount,wrapLanguageModel,type LanguageModel,type ModelMessage,type ToolSet} from 'ai';
import {financialTools} from './agent-tools.ts';
import type {ToolOutcome} from './tools/types.ts';
import {privateProviderOptions} from './llm-provider.ts';
export {AGENT_MODEL,AGENT_ENDPOINT} from './llm-provider.ts';
export type AgentMetrics={rounds:number;elapsed_ms:number;input_tokens:number;output_tokens:number;tools:{name:string;status:string}[]};
class AgentProtocolError extends Error{}
const continuation='Lo que alcanzamos a guardar quedó conservado. No he confirmado un registro nuevo en este turno. Podemos continuar desde ahí.';

export async function runAgent(options:{model:Exclude<LanguageModel,string>;instructions:string;messages:ModelMessage[];dispatch:(name:string,args:any,signal:AbortSignal)=>Promise<ToolOutcome>;tools?:typeof financialTools;maxSteps?:number;timeoutMs?:number;onMetrics?:(metrics:AgentMetrics)=>void}){
 const started=Date.now();
 const deadline=AbortSignal.timeout(options.timeoutMs??65_000);
 const metrics:AgentMetrics={rounds:0,elapsed_ms:0,input_tokens:0,output_tokens:0,tools:[]};
 let terminal:any;
 // Preserve four tool rounds, with one final answer-only round if needed.
 const maxSteps=options.maxSteps??5;
 const definitions=options.tools??financialTools;
 const model=wrapLanguageModel({model:options.model,middleware:{
  wrapGenerate:async({doGenerate})=>{
   const result=await doGenerate();
   const calls=result.content.filter(part=>part.type==='tool-call');
   if(calls.length>1&&(calls.length>4||calls.some(call=>!definitions.find(d=>d.name===call.toolName)?.readOnly)))throw new AgentProtocolError('Servicio de IA solicitó operaciones simultáneas');
   if(['length','error'].includes(result.finishReason.unified))throw new AgentProtocolError('Servicio de IA devolvió una respuesta incompleta');
   return result;
  },
 }});
 const tools:ToolSet=Object.fromEntries(definitions.map(definition=>[definition.name,tool({
  description:definition.description,inputSchema:definition.inputSchema,
  execute:async(args,{abortSignal})=>{
   const signal=abortSignal?AbortSignal.any([deadline,abortSignal]):deadline;
   signal.throwIfAborted();
   if(terminal)throw new AgentProtocolError('Operación del turno ya preparada');
   try{
    const outcome=await options.dispatch(definition.name,args,signal);signal.throwIfAborted();metrics.tools.push({name:definition.name,status:'ok'});
    if(outcome.action){terminal=outcome.action;return {status:'prepared_for_server'};}
    return outcome.result??null;
   }catch(e){
    signal.throwIfAborted();
    metrics.tools.push({name:definition.name,status:'error'});
    return {status:'needs_clarification',error:e instanceof Error?e.message:'Pregunta el dato faltante.'};
   }
  },
 })]));
 try{
  const agent=new ToolLoopAgent({model,instructions:options.instructions,tools,providerOptions:privateProviderOptions,
   maxOutputTokens:1800,maxRetries:0,timeout:{totalMs:options.timeoutMs??65_000,stepMs:25_000},
   stopWhen:[isStepCount(maxSteps),()=>Boolean(terminal)],
   prepareStep:({stepNumber})=>definitions.length&&stepNumber===maxSteps-1?{activeTools:[],toolChoice:'none',instructions:options.instructions+'\nResponde ahora a la pregunta usando solo los resultados obtenidos. Si faltó comprobar algo, dilo sin inventar cifras ni afirmar que guardaste datos.'}:undefined,
   onStepFinish:step=>{
    metrics.rounds++;metrics.input_tokens+=step.usage.inputTokens??0;metrics.output_tokens+=step.usage.outputTokens??0;
    for(const call of step.toolCalls)if(call.invalid)metrics.tools.push({name:definitions.some(t=>t.name===call.toolName)?call.toolName:'unknown',status:'error'});
   },
  });
  const result=await agent.generate({messages:options.messages,abortSignal:deadline});
  deadline.throwIfAborted();
  if(terminal)return terminal;
  if(result.finalStep.toolCalls.length)return {type:'clarify',question:metrics.tools.some(t=>t.status==='ok'&&['actualizar_borrador','actualizar_asuntos','descartar_borrador','distinguir_ingreso_adicional'].includes(t.name))?continuation:'No pude terminar de responder tu consulta. Inténtalo de nuevo; no confirmé ningún movimiento en este turno.'};
  const answer=result.text.trim();if(!answer||answer.length>2000)throw new AgentProtocolError('Servicio de IA devolvió una respuesta inválida');
  return {type:'clarify',question:answer};
 }catch(e){
  if(e instanceof AgentProtocolError)throw e;
  // SDK errors may include request bodies and URLs. Never pass them to logging.
  throw Error('Servicio de IA no disponible');
 }finally{metrics.elapsed_ms=Date.now()-started;options.onMetrics?.(metrics);}
}
