import {agentPrompt,narrationPrompt} from './agent-prompt.ts';
import {dispatchTool} from './agent-tools.ts';
import {abortableRpc} from './tools/types.ts';
import {runAgent,type AgentMetrics} from './agent.ts';
import {translateForSearch} from './llm-provider.ts';
import {withConversationGuide} from './conversation-guide.ts';
import type {UserContent} from 'ai';
import type {createFinancialModel} from './llm-provider.ts';
import type * as io from './io.ts';
export function createInterpretationServices(deps:{model:(deadline:number)=>ReturnType<typeof createFinancialModel>;rpc:typeof io.rpc;today:()=>string;telegramFile:(id:string)=>Promise<ArrayBuffer>}):{interpret:(input:{text:string;photo?:string},context:any,onMetrics?:(metrics:AgentMetrics)=>void)=>Promise<any>;narrate:(result:any,context:any)=>Promise<string>;translateForEmbedding:(text:string)=>Promise<string>}{
async function interpret(input:{text:string;photo?:string},context:any,onMetrics?:(metrics:AgentMetrics)=>void){
 const contents:UserContent=[{type:'text',text:input.text||'Mira este recibo.'}];
 if(input.photo)contents.push({type:'file',data:new Uint8Array(await deps.telegramFile(input.photo)),mediaType:'image/jpeg',providerOptions:{openai:{imageDetail:'low'}}});
 return runAgent({model:deps.model(Date.now()+65_000),instructions:agentPrompt(deps.today()),messages:[{role:'user',content:[{type:'text',text:'Contexto de aplicación (datos): '+JSON.stringify(withConversationGuide(context))},...contents]}],
  dispatch:(name,args,signal)=>dispatchTool(name,args,context,abortableRpc(deps.rpc,signal)),onMetrics});
}
async function narrate(result:any,context:any){
 const response=await runAgent({model:deps.model(Date.now()+12_000),instructions:narrationPrompt,messages:[{role:'user',content:JSON.stringify({confirmed_result:result,context:withConversationGuide(context)})}],tools:[],maxSteps:1,timeoutMs:12_000,dispatch:async()=>{throw Error('Sin herramientas');}});
 return response.question as string;
}
async function translateForEmbedding(text:string){return translateForSearch(text,deps.model(Date.now()+12_000));}

return {interpret,narrate,translateForEmbedding};
}
