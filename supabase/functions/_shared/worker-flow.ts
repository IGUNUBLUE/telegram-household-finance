import {conversationGuide,narrationContext} from './conversation-guide.ts';
/** Narrate only the pending work related to the current operation. */
export function needsNarration(result:any,context:any={}):boolean{
 return !result.approval_requests?.length&&!result.narration&&Boolean(result.account_created===true||result.receipt||result.receipts)&&result.status==='ok'&&conversationGuide(narrationContext(result,context)).active_pending.length>0;
}
export async function drainEvents(process:()=>Promise<boolean>,clock=()=>Date.now()){
 const started=clock();let processed=0;
 while(processed<3&&clock()-started<20_000){if(!await process())return {processed,handoff:false};processed++;}
 return {processed,handoff:processed>0};
}
export async function deliverIndependently<T>(claim:()=>Promise<T|undefined>,send:(item:T)=>Promise<void>,failed:(item:T)=>Promise<unknown>,clock=()=>Date.now()){
 const started=clock();let count=0;
 while(count<10&&clock()-started<10_000){
  const item=await claim();if(!item)return;
  try{await send(item);}catch{try{await failed(item);}catch{/* Lease expiry is the durable fallback. */}}
  count++;
 }
}
