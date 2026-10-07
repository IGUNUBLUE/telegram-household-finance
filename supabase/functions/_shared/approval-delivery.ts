import {approvalCard} from './approval-domain.ts';
import type {WorkerIO} from './worker-engine.ts';
type IO=Pick<WorkerIO,'rpc'|'telegram'>&{botUsername:string};
/** Consume before transport. An ambiguous delivery is never retried or redirected. */
export async function deliverApprovalNotice(item:any,io:IO){
 const lease={outbox_id:item.id,token:item.token};
 const finish=async()=>{const r=await io.rpc('queue:sent',{id:item.id,token:item.token});if(!r.ok)throw Error('Notice lease changed');};
 const context=await io.rpc('approval:notice_context',lease);
 if(context.send){
  const count=await io.telegram('getChatMemberCount',{chat_id:context.group_id});
  if(count!==3)throw Error('Group membership unavailable');
  const member=await io.telegram('getChatMember',{chat_id:context.group_id,user_id:Number(context.member_id)});
  if(!['member','administrator','creator'].includes(member.status)&&!(member.status==='restricted'&&member.is_member===true)){
   await io.rpc('approval:notice_unavailable',lease);await finish();return;
  }
 }
 let notice=await io.rpc('approval:begin_notice',lease);
 if(!notice.send){await finish();return;}
 const send=async()=>io.telegram('sendMessage',{chat_id:notice.route.chat_id,...notice.route.thread_id?{message_thread_id:notice.route.thread_id}:{},...approvalCard(notice.request,notice.member_id,notice.member_name,io.botUsername)});
 let outcome='uncertain',messageId:number|undefined;
 try{messageId=(await send()).message_id;outcome='sent';}
 catch(error){
  if((error as {deliveryStatus?:string}).deliveryStatus==='definitely_unavailable'){
   if(notice.route.chat_id===context.member_id){
    notice=await io.rpc('approval:notice_fallback',{notice_id:notice.notice_id,token:item.token});
    if(notice.send){try{messageId=(await send()).message_id;outcome='sent';}catch(fallbackError){outcome=(fallbackError as {deliveryStatus?:string}).deliveryStatus==='definitely_unavailable'?'undeliverable':'uncertain';}}
    else outcome='undeliverable';
   }else outcome='undeliverable';
  }
 }
 await io.rpc('approval:notice_result',{notice_id:notice.notice_id??item.approvalNoticeId,token:item.token,outcome,telegram_message_id:messageId});
 await finish();
}
