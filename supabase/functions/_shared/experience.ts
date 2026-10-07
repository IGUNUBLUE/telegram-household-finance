export function replyRoute(input:{messageId?:number;threadId?:number}):Record<string,unknown>{
 return {...(Number.isSafeInteger(input.messageId)&&input.messageId!>0?{reply_parameters:{message_id:input.messageId,allow_sending_without_reply:true}}:{}),...(Number.isSafeInteger(input.threadId)&&input.threadId!>0?{message_thread_id:input.threadId}:{})};
}
export async function withTyping<T>(signal:()=>Promise<unknown>,work:()=>Promise<T>,intervalMs=4000):Promise<T>{
 let busy=false;
 const pulse=async()=>{if(busy)return;busy=true;try{await signal();}catch{/* Presence must never block ledger work. */}finally{busy=false;}};
 void pulse();
 const timer=setInterval(()=>{void pulse();},intervalMs);
 try{return await work();}finally{clearInterval(timer);}
}

export function typingRoute(input:{threadId?:number;isTopic?:boolean}){return {action:'typing',...(input.isTopic===true&&Number.isSafeInteger(input.threadId)&&input.threadId!>0?{message_thread_id:input.threadId}:{})};}
