import {createHash,randomUUID} from 'node:crypto';
import {agentPrompt,narrationPrompt} from '../../supabase/functions/_shared/agent-prompt.ts';
import {dispatchTool} from '../../supabase/functions/_shared/agent-tools.ts';
import {abortableRpc,type Rpc} from '../../supabase/functions/_shared/tools/types.ts';
import {withConversationGuide} from '../../supabase/functions/_shared/conversation-guide.ts';
import type {AgentMetrics} from '../../supabase/functions/_shared/agent.ts';
import type {createFinancialFlue} from './flue-agent.ts';

function modelContext(context:any){const {event_attempt_token,...safe}=context;return withConversationGuide(safe);}
export function createFlueInterpretationServices(deps:{runtime:Pick<Awaited<ReturnType<typeof createFinancialFlue>>,'run'>;rpc:Rpc;today:()=>string;telegramFile:(id:string)=>Promise<ArrayBuffer>}){
 async function interpret(input:{text:string;photo?:string},context:any,onMetrics?:(metrics:AgentMetrics)=>void){
  if(!Number.isSafeInteger(context.event_id)||context.event_id<=0||typeof context.actor!=='string'||!context.actor||typeof context.event_attempt_token!=='string'||!context.event_attempt_token)throw Error('Falta identidad del evento autorizado.');
  const key='event-'+createHash('sha256').update(JSON.stringify([context.actor,context.event_id,context.event_attempt_token])).digest('hex');
  const ownedRpc:Rpc=(op,data={},signal)=>deps.rpc(op,['agent:draft_save','agent:drafts_save','agent:draft_cancel','agent:draft_distinct_income'].includes(op)?{...data,_attempt_token:context.event_attempt_token}:data,signal);
  return deps.runtime.run({key,instructions:agentPrompt(deps.today()),text:'Contexto de aplicación (datos): '+JSON.stringify(modelContext(context))+'\nMensaje actual: '+(input.text||'Mira este recibo.'),image:input.photo?new Uint8Array(await deps.telegramFile(input.photo)):undefined,dispatch:(name,args,signal)=>dispatchTool(name,args,context,abortableRpc(ownedRpc,signal)),onMetrics});
 }
 const noTools=async()=>{throw Error('Sin herramientas en esta operación');};
 async function narrate(result:any,context:any){
  const response=await deps.runtime.run({key:'narration-'+randomUUID(),instructions:narrationPrompt,text:JSON.stringify({confirmed_result:result,context:modelContext(context)}),tools:false,maxSteps:1,timeoutMs:12000,dispatch:noTools});
  return response.question as string;
 }
 return {interpret,narrate};
}
