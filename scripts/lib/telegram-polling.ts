import {Api} from 'grammy/web';
import {readProtectedJson,writeProtectedJson} from './subscription-session.ts';
type Update={update_id:number};
type Dependencies={readCursor:()=>Promise<number>;saveCursor:(offset:number)=>Promise<void>;getUpdates:(offset:number,signal:AbortSignal)=>Promise<Update[]>;admit:(update:any)=>Promise<unknown>;log:(status:string)=>void};
export async function pollTelegramBatch(deps:Dependencies,signal:AbortSignal){
 signal.throwIfAborted();const offset=await deps.readCursor();
 if(!Number.isSafeInteger(offset)||offset<0)throw Error('Invalid Telegram cursor');
 const updates=await deps.getUpdates(offset,signal);let cursor=offset;
 if(!Array.isArray(updates)||updates.some(u=>!Number.isSafeInteger(u?.update_id)||u.update_id<0))throw Error('Invalid Telegram update batch');
 for(const update of [...updates].sort((a,b)=>a.update_id-b.update_id)){
  if(signal.aborted)break;
  if(update.update_id<cursor)continue;
  await deps.admit(update);
  // Once admitted, finish persistence even if shutdown was requested meanwhile.
  cursor=update.update_id+1;await deps.saveCursor(cursor);
 }
 return updates.length;
}
export async function runTelegramPolling(deps:Dependencies&{sleep:(ms:number,signal:AbortSignal)=>Promise<void>},signal:AbortSignal){
 let failures=0;
 while(!signal.aborted){
  try{await pollTelegramBatch(deps,signal);failures=0;}
  catch{if(signal.aborted)break;deps.log('telegram_poll_retry');try{await deps.sleep(Math.min(30000,1000*2**Math.min(failures++,5)),signal);}catch{if(!signal.aborted)throw Error('Polling wait unavailable');}}
 }
}
export function createTelegramPollingSource(token:string,cursorFile:string,send:typeof fetch=fetch,now:()=>number=Date.now){
 const api=new Api(token,{fetch:send as never,timeoutSeconds:35,sensitiveLogs:false,canUseWebhookReply:()=>false});
 return {
  async readCursor(){
   const value=await readProtectedJson<{offset:number;confirmedAt?:number}>(cursorFile);
   if(value&&(!Number.isSafeInteger(value.offset)||value.offset<0))throw Error('Invalid protected Telegram cursor');
   // Telegram retains updates for 24h and may randomize ids after a long idle.
   // Expiring legacy/stale offsets safely replays through SQL idempotent intake.
   const age=now()-(value?.confirmedAt??NaN);
   return Number.isFinite(age)&&age>=0&&age<86400000?value!.offset:0;
  },
  saveCursor:(offset:number)=>writeProtectedJson(cursorFile,{offset,confirmedAt:now()}),
  getUpdates:(offset:number,signal:AbortSignal)=>api.getUpdates({offset,timeout:25,limit:100,allowed_updates:['message','callback_query']},signal as never),
  async verifyNoWebhook(){const info=await api.getWebhookInfo(AbortSignal.timeout(15000) as never);if(info.url)throw Error('Telegram webhook is still active');},
 };
}
