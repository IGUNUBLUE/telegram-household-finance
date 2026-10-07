import {Bot,BotError} from 'grammy/web';
import {extractUpdate,intendedChat} from './domain.ts';
import {typingRoute} from './experience.ts';
import type {TelegramClient} from './telegram-client.ts';

class IntakeRejection extends Error{readonly status:number;constructor(status:number,message:string){super(message);this.status=status;}}
type Dependencies={loadConfig:()=>Promise<void>;getConfig:(name:string)=>string|undefined;getClient:(token:string)=>TelegramClient;rpc:(op:string,data:any)=>Promise<any>;waitUntil:(task:Promise<unknown>)=>void;wakeWorker:()=>Promise<void>;log?:(message:string)=>void};
async function ingestUpdate(deps:Dependencies,update:any){
 let incoming;
 try{incoming=extractUpdate(update);}catch{throw new IntakeRejection(403,'unauthorized update');}
 const group=deps.getConfig('TELEGRAM_GROUP_ID')??'';
 if(incoming.chatType!=='private'&&!intendedChat(incoming.group,group))throw new IntakeRejection(403,'forbidden');
 const token=deps.getConfig('TELEGRAM_BOT_TOKEN');if(!token)throw Error('Configuration missing');
 const client=deps.getClient(token);
 // First acknowledge the button, before identity, database or worker latency.
 if(incoming.callbackId)deps.waitUntil(client.telegram('answerCallbackQuery',{callback_query_id:incoming.callbackId,text:'Recibido',cache_time:0}).catch(()=>{}));
 const bot=new Bot(token,{client:client.options,botInfo:await client.botInfo()});
 bot.use(async ctx=>{
  const input=extractUpdate(ctx.update);
  if(await client.telegram('getChatMemberCount',{chat_id:group})!==3)throw new IntakeRejection(403,'unexpected group membership');
  const chat=input.chatId??group;
  if(input.chatType==='private'){
   const eligibility=await deps.rpc('approval:private_member',{actor:input.actor,chat_id:chat,group});
   if(!eligibility.allowed)throw new IntakeRejection(403,'unknown private member');
   const member=await client.telegram('getChatMember',{chat_id:group,user_id:Number(input.actor)});
   if(!['creator','administrator','member'].includes(member.status)&&!(member.status==='restricted'&&member.is_member===true))throw new IntakeRejection(403,'not a current member');
  }
  const event=await deps.rpc(input.chatType==='private'?'approval:ingest':'ui:ingest',{update_id:input.id,actor:input.actor,name:input.name,group,payload:input});
  if(event.remove_buttons&&input.messageId)deps.waitUntil(client.telegram('editMessageReplyMarkup',{chat_id:chat,message_id:input.messageId,reply_markup:{inline_keyboard:[]}}).catch(()=>{}));
  if(event.state==='new')deps.waitUntil((async()=>{
   await client.telegram('sendChatAction',{chat_id:chat,...typingRoute(input)}).catch(()=>{});
   try{await deps.wakeWorker();}catch{deps.log?.('Immediate worker unavailable; durable queue will retry');}
  })());
 });
 try{await bot.handleUpdate(update);}catch(error){throw error instanceof BotError?error.error:error;}
}
/** Shared trusted intake for the VPS; permanent rejections may advance polling. */
export function createTelegramIntake(deps:Dependencies){
 return async(update:any):Promise<'admitted'|'discarded'>=>{
  try{await deps.loadConfig();await ingestUpdate(deps,update);return 'admitted';}
  catch(error){if(error instanceof IntakeRejection)return 'discarded';deps.log?.('Telegram intake failed');throw Error('Telegram temporary failure');}
 };
}
export function createTelegramHandler(deps:Dependencies){
 return async(req:Request):Promise<Response>=>{
  if(req.method!=='POST')return new Response('method not allowed',{status:405});
  const header=req.headers.get('X-Telegram-Bot-Api-Secret-Token');if(!header)return new Response('unauthorized',{status:401});
  try{await deps.loadConfig();}catch{return new Response('configuration unavailable',{status:503});}
  const secret=deps.getConfig('TELEGRAM_WEBHOOK_SECRET');
  if(!secret||header!==secret)return new Response('unauthorized',{status:401});
  try{await ingestUpdate(deps,await req.json());return Response.json({ok:true});}
  catch(error){
   if(error instanceof IntakeRejection)return new Response(error.message,{status:error.status});
   deps.log?.('Telegram intake failed');return new Response('temporary failure',{status:503});
  }
 };
}
