/** Native Pi transport; session locking and secret persistence remain app-owned. */
import {createProvider} from 'pi-native/models';
import {openaiProvider} from 'pi-native/providers/openai';
import {openAIResponsesApi} from 'pi-native/api/openai-responses.lazy';
import type {AssistantMessage,Model} from 'pi-native';
import type {SubscriptionCredentials} from './subscription-auth.ts';
import type {SubscriptionSession} from './subscription-session.ts';
import {selectSubscriptionModel} from './subscription-catalog.ts';

export const FINANCE_MODEL='gpt-5.6-luna';
export function toPiCredential(c:SubscriptionCredentials){
 return {type:'oauth' as const,access:c.access_token,refresh:c.refresh_token,expires:c.expires_at,clientId:c.client_id,scopes:[...c.scopes]};
}
type NativeRefresh=NonNullable<ReturnType<typeof openaiProvider>['auth']['oauth']>['refresh'];
export function createPiRefresh(refresh:NativeRefresh=openaiProvider().auth.oauth!.refresh){
 return async(c:SubscriptionCredentials):Promise<SubscriptionCredentials>=>{
  try{
   const result=await refresh(toPiCredential(c),AbortSignal.timeout(20_000));
   const scopes=result.scopes;
   if(result.type!=='oauth'||result.clientId!==c.client_id||typeof result.access!=='string'||!result.access.trim()||typeof result.refresh!=='string'||!result.refresh.trim()||!Number.isFinite(result.expires)||result.expires<=Date.now()||!Array.isArray(scopes)||!['resource.invoke','chatgpt.tokens.use.direct'].every(s=>scopes.includes(s)))throw Error();
   return {...c,access_token:result.access,refresh_token:result.refresh,expires_at:result.expires,scopes:result.scopes as string[]};
  }catch{throw Error('No se pudo renovar la autorización de ChatGPT.');}
 };
}
export function createProtectedPiProvider(session:SubscriptionSession,catalog:unknown){
 selectSubscriptionModel(catalog,FINANCE_MODEL);
 // Conservative application budgets, not a claim about the account's full model capacity.
 // Zero rates mean unpriced subscription usage; no monetary estimate is emitted.
 const model:Model<'openai-responses'>={id:FINANCE_MODEL,name:FINANCE_MODEL,provider:'openai',api:'openai-responses',baseUrl:'https://api.openai.com/v1',compat:{supportsStrictMode:true},samplingParams:{parallel_tool_calls:false},reasoning:false,input:['text','image'],contextWindow:32_000,maxTokens:1_800,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}};
 return createProvider({id:'openai',models:[model],baseUrl:model.baseUrl,api:openAIResponsesApi(),auth:{apiKey:{name:'Protected ChatGPT session',resolve:async()=>{
  try{return {auth:{apiKey:await session.accessToken()},source:'Protected OAuth'};}catch{throw Error('Autorización de ChatGPT no disponible.');}
 }}}});
}
/** Only complete model responses may reach financial tool dispatch. */
export function requireCompletePiMessage(value:unknown):AssistantMessage{
 const m=value as AssistantMessage|null;
 if(!m||m.role!=='assistant'||!['stop','toolUse'].includes(m.stopReason)||!Array.isArray(m.content)||m.content.length===0)throw Error('Respuesta del modelo incompleta o inválida.');
 for(const p of m.content){
  if(p.type==='toolCall'&&(!p.id||!p.name||!p.arguments||typeof p.arguments!=='object'||Array.isArray(p.arguments)))throw Error('Llamada del modelo incompleta o inválida.');
  if(p.type==='text'&&typeof p.text!=='string')throw Error('Respuesta del modelo inválida.');
 }
 return m;
}
