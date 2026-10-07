import {parseApprovalIntent} from './approval-domain.ts';
import {deliverApprovalNotice} from './approval-delivery.ts';
import {FREE_AGENT_MODEL} from './llm-provider.ts';
import {telegramMarkdown,telegramParts} from './telegram-format.ts';
import {needsNarration,drainEvents,deliverIndependently} from './worker-flow.ts';
import type {AgentMetrics} from './agent.ts';
import {handlePro,proMarkup,formatPro} from './pro.ts';
import {withTyping,replyRoute,typingRoute} from './experience.ts';
import {formatResult,ledgerCsv,type Incoming} from './domain.ts';
import {narrationContext,recoverTurnFocus} from './conversation-guide.ts';
export type WorkerIO=Pick<typeof import('./io.ts'),'rpc'|'telegram'|'telegramDocument'|'transcribe'|'interpret'|'narrate'|'today'>&{getConfig:typeof import('./config.ts').getConfig;botUsername?:string;model?:'gpt-5.6-luna'|'space-bunny-free';onProviderUnavailable?:()=>void;canClaim:()=>Promise<boolean>;log:(record:{eventId?:number;status:string})=>void};
export function createWorkerEngine(io:WorkerIO){
const {rpc,telegram,telegramDocument,transcribe,interpret,narrate,today,getConfig}=io;
async function react(messageId:unknown,emoji?:'🤔'|'👌',chatId=getConfig('TELEGRAM_GROUP_ID')){
 if(!Number.isSafeInteger(messageId)||Number(messageId)<=0)return;
 try{await telegram('setMessageReaction',{chat_id:chatId,message_id:messageId,reaction:emoji?[{type:'emoji',emoji}]:[],is_big:false});}catch{/* Optional presence never fails ledger work or delivery. */}
}
function recorded(result:any):boolean{
 return result?.status==='ok'&&(Number.isSafeInteger(Number(result.transaction_id))&&Number(result.transaction_id)>0||(Array.isArray(result.receipts)&&result.receipts.some(recorded)));
}
async function makeAction(input:Incoming,context:any,conversation:any,onMetrics:(m:AgentMetrics)=>void){
 const callback=input.callback??'';
 const match=callback.match(/^confirm:(\d+)$/);
 if(match){const pending=await rpc('pending',{id:match[1]});if(pending?.status!=='pending'||pending.actor!==input.actor||pending.action?.type!=='post')return {type:'clarify',question:'No encontré ese duplicado pendiente.'};return {...pending.action,confirm_duplicate:true,pending_event_id:match[1]};}
 const interaction=await handlePro(input,input.text,context,conversation,true);if(interaction)return interaction;
 if(!input.text&&!input.photo)return {type:'clarify',question:'Envíame texto, audio o un recibo.'};
 context.conversation=conversation;
 return interpret({text:input.text,photo:input.photo},context,onMetrics);
}

async function processOne(){
 if(!await io.canClaim())return false;
 const ev=await rpc('queue:claim');if(!ev.id)return false;
 const chat=ev.payload?.chatId??getConfig('TELEGRAM_GROUP_ID');
 const reactionMessageId=ev.payload?.callback?undefined:ev.payload?.messageId;
 try{
  const input={...ev.payload} as Incoming;
  // Await the bounded reaction attempt before work: a delayed thinking request
  // must not arrive after the terminal reaction. No webhook reaction race.
  await react(reactionMessageId,'🤔',chat);
  await withTyping(()=>telegram('sendChatAction',{chat_id:chat,...typingRoute(input)}),async()=>{
  if(input.voice){input.text=(input.text+' '+await transcribe(input.voice)).trim();input.voice=undefined;await rpc('approval:transcription',{id:ev.id,token:ev.turn_token,text:input.text});}
  const intent=parseApprovalIntent(input);
  if(intent||input.chatType==='private'){
   if(intent?.kind==='start'){await rpc('approval:private_start',{id:ev.id});return;}
   if(intent?.kind==='list'){await rpc('approval:list',{id:ev.id});return;}
   if(intent?.kind==='decision'){
    const target=await rpc(intent.request_id?'approval:target':'approval:reply_target',{id:ev.id,request_id:intent.request_id});
    if(target?.id){await rpc('approval:resolve',{id:ev.id,request_id:target.id,revision:intent.revision??target.revision,decision:intent.decision});return;}
    if(intent.request_id||input.chatType==='private'){await rpc('approval:help',{id:ev.id});return;}
   }
   if(input.chatType==='private'){await rpc('approval:help',{id:ev.id});return;}
  }
  const context={...await rpc('worker:context',{id:ev.id,phase:'initial'}),actor:input.actor,event_id:ev.id,event_attempt_token:ev.turn_token,turn_focus:{draft_ids:[] as string[]}};
  context.turn_focus.draft_ids=recoverTurnFocus(context,ev.id);
  const conversation=await rpc('pro:conversation',{id:ev.id,text:input.callback?'Botón: '+input.callback:input.text||'Imagen adjunta'});
  let metrics:AgentMetrics|undefined;
  const action=ev.action??(conversation?.ambiguous?{type:'clarify',question:'Tienes más de un asunto pendiente. Responde al mensaje del que quieres continuar. También puedes preguntarme qué quedó pendiente.'}:await makeAction(input,context,conversation,m=>{metrics=m;}));
  // Keep authorized tool focus with the cached action, including read-only
  // registration attempts. SQL validates and commits it with the response.
  if(!ev.action)action._response_draft_ids=[...context.turn_focus.draft_ids];
  else context.turn_focus.draft_ids=[...new Set([...context.turn_focus.draft_ids,...action._response_draft_ids??[]])];
  if(!ev.action)await rpc('proposal',{id:ev.id,action});
  let result=await rpc(action.type==='approval_decision'?'approval:resolve':'agent:apply',action.type==='approval_decision'?{id:ev.id,...action}:{id:ev.id,action});
  context.turn_focus=narrationContext(result,context).turn_focus;
  if(needsNarration(result,context)){
   try{
    const fresh=narrationContext(result,{...context,...await rpc('worker:context',{id:ev.id,phase:'refresh'}),conversation});
    if(needsNarration(result,fresh)){
     const text=await narrate(result,fresh);
     if(text&&text.length<=1200)result=await rpc('agent:narrate',{id:ev.id,text});
    }
   }catch{io.onProviderUnavailable?.();io.log({eventId:ev.id,status:'narration_unavailable'});/* Keep the committed receipt and finish delivery before backoff. */}
  }
  if(metrics){try{await rpc('agent:trace',{id:ev.id,...metrics,model:io.model??FREE_AGENT_MODEL});}catch{/* Telemetry must not prevent delivery. */}}

  if(conversation&&!conversation.ambiguous)await rpc('pro:finish_conversation',{id:ev.id,answer:JSON.stringify(result).slice(0,2000),close:false,active_draft_ids:context.turn_focus.draft_ids.length?context.turn_focus.draft_ids:result.status==='clarify'?conversation.previous_draft_ids??[]:[]});
  });
 }catch(e){await react(reactionMessageId,undefined,chat);io.log({eventId:ev.id,status:'event_failed'});await rpc('fail',{id:ev.id});}
 finally{await rpc('queue:finish',{id:ev.id,token:ev.turn_token});}
 return true;
}
async function deliver(){
 await deliverIndependently(async()=>{const item=await rpc('queue:outbox');return item.id?item:undefined;},deliverOne,async item=>{await react(item.reactionMessageId);return rpc('queue:failed',{id:item.id,token:item.token});});
}
async function deliverOne(item:any){
  if(!(await rpc('queue:delivery_check',{id:item.id,token:item.token})).deliver)return;
  const mark=async(messageId?:number)=>{const r=await rpc('queue:sent',{id:item.id,token:item.token,telegram_message_id:messageId});if(!r.ok)throw Error('Delivery lease changed');await react(item.reactionMessageId,recorded(item.result)?'👌':undefined);for(const id of item.supersededReactionIds??[])await react(id);};
  const result=item.result??{};
  const chat=item.chatId??getConfig('TELEGRAM_GROUP_ID');
  if(item.purpose==='approval_notice'){await deliverApprovalNotice(item,{rpc,telegram,botUsername:io.botUsername??(await telegram('getMe',{})).username});return;}
  if(item.purpose==='approval_card_update'){
   try{await telegram('editMessageText',{chat_id:chat,message_id:item.messageId,text:`Solicitud #${result.request_id}: ${({posted:'registrada',rejected:'rechazada',expired:'vencida',cancelled:'cancelada',superseded:'reemplazada por cambios'} as Record<string,string>)[result.state]??'finalizada'}.`,reply_markup:{inline_keyboard:[]}});}catch{/* Editing a request card cannot prevent its financial receipt. */}
   await mark();return;
  }
  if(result.status==='reconciliation_export'){
   const quote=(v:unknown)=>'"'+String(v??'').replaceAll('"','""')+'"';
   const rows=[['origen','id','fecha','centavos','descripcion','conciliado'],...result.rows.map((x:any)=>['extracto',x.id,x.date,x.delta,x.memo,x.matched??'']),...(result.ledger_unmatched??[]).map((x:any)=>['libro',x.id,x.date,x.delta,x.memo,''])];
   const sent=await telegramDocument('diferencias-'+result.batch_id+'.csv',rows.map(row=>row.map(quote).join(',')).join('\r\n'),replyRoute(item));await mark(sent.message_id);return;
  }
  if(result.status==='export'){
   const sent=await telegramDocument('libro-contable.csv',ledgerCsv(await rpc('export')),replyRoute(item));
   await mark(sent.message_id);return;
  }
  const markup=proMarkup(result)??(result.status==='duplicate'&&item.event_id?{inline_keyboard:[[{text:'Confirmar movimiento',callback_data:'confirm:'+item.event_id}]]}:undefined);
  const detailContext=result.status==='detail'?await rpc('context'):undefined;
  const receipt=formatPro(result,detailContext)??(result.status==='weekly'?'📅 Semana anterior\n':'')+formatResult(result)+(result.status==='weekly'?'\nPendientes: '+result.pending+'\nCompromisos próximos: '+(result.commitments??[]).map((x:any)=>x.label+' · '+x.due).join(', '):'');
  const text=result.narration?result.narration+'\n\n'+receipt:receipt;
  const parts=telegramParts(text);
  let messageId=item.telegram_message_id;
  if(item.editTarget&&!item.editDone&&item.part===0&&(item.editMode==='resolve'||parts.length===1)){
   let edited=true;
   try{await telegram('editMessageText',{chat_id:chat,message_id:item.editTarget,text:telegramMarkdown(item.editMode==='replace'?parts[0]:'✅ Este pendiente quedó resuelto. Consulta la confirmación del registro.'),parse_mode:'MarkdownV2',reply_markup:{inline_keyboard:[]},disable_web_page_preview:true});}
   catch(error){const status=(error as {editStatus?:string}).editStatus;if(status==='uneditable')edited=false;else if(status!=='unchanged')throw error;}
   if(item.editMode==='replace'&&edited){
    const progress=await rpc('queue:progress',{id:item.id,token:item.token,part:1,telegram_message_id:item.editTarget});if(!progress.ok)throw Error('Delivery lease changed');await mark(item.editTarget);return;
   }
   const saved=await rpc('queue:edit_done',{id:item.id,token:item.token});if(!saved.ok)throw Error('Delivery lease changed');
  }
  const started=Date.now();
  for(let part=item.part??0;part<parts.length;part++){
   if(Date.now()-started>15_000)throw Error('Continue delivery in next attempt');
   const sent=await telegram('sendMessage',{chat_id:chat,...replyRoute(item),text:telegramMarkdown(parts[part]),parse_mode:'MarkdownV2',reply_markup:part===parts.length-1?markup:undefined,disable_web_page_preview:true});
   messageId=sent.message_id;
   const saved=await rpc('queue:progress',{id:item.id,token:item.token,part:part+1,telegram_message_id:messageId});
   if(!saved.ok)throw Error('Delivery lease changed');
  }
  await mark(messageId);
}

async function runBatch(){return drainEvents(async()=>{const processed=await processOne();await deliver();return processed;});}
return {processOne,deliver,runBatch};
}
