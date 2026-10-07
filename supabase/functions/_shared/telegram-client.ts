import {Api,InputFile,type ApiClientOptions} from 'grammy/web';
import type {UserFromGetMe} from 'grammy/types';
const methods=new Set(['sendMessage','sendChatAction','answerCallbackQuery','editMessageReplyMarkup','editMessageText','getChatMemberCount','getChatMember','getFile','getMe','sendDocument','setMessageReaction']);
const maxBytes=8_000_000;

export function createTelegramClient(token:string,send:typeof fetch=fetch){
 // grammY web uses native fetch; npm declarations also accept the older Node fetch shape.
 const options:ApiClientOptions={fetch:send as unknown as NonNullable<ApiClientOptions['fetch']>,timeoutSeconds:30,sensitiveLogs:false,canUseWebhookReply:()=>false};
 const api=new Api(token,options);
 async function telegram(method:string,body:Record<string,unknown>):Promise<any>{
  if(!methods.has(method))throw Error('Método Telegram no permitido');
  try{
   if(method==='getMe')return await api.getMe(AbortSignal.timeout(20_000) as unknown as Parameters<typeof api.getMe>[0]);
   const invoke=api.raw[method as keyof typeof api.raw] as (body:Record<string,unknown>,signal:AbortSignal)=>Promise<unknown>;
   return await invoke(body,AbortSignal.timeout(method==='setMessageReaction'?2000:method==='sendDocument'?30_000:20_000));
  }catch(error){
   // Classify only known API edit outcomes; never expose remote descriptions.
   const apiError=error as {error_code?:number;description?:string};
   const description=apiError.error_code===400?apiError.description??'':'';
   const editStatus=description.includes('message is not modified')?'unchanged':
    /message to edit not found|message can't be edited|MESSAGE_ID_INVALID/.test(description)?'uneditable':'unavailable';
   throw Object.assign(Error('Servicio Telegram no disponible ('+method+')'),{...(method==='editMessageText'?{editStatus}:{}),deliveryStatus:apiError.error_code===403||apiError.error_code===400&&/chat not found|user is deactivated/.test(apiError.description??'')?'definitely_unavailable':apiError.error_code===429?'retryable_rejected':'uncertain'});
  }
 }
 let me:Promise<UserFromGetMe>|undefined;
 const botInfo=()=>me??=(telegram('getMe',{}).catch(()=>{me=undefined;throw Error('No se pudo inicializar Telegram');}));
 async function telegramDocument(group:string,name:string,contents:string,route:Record<string,unknown>={}){
  return telegram('sendDocument',{chat_id:group,...route,document:new InputFile(new TextEncoder().encode('\uFEFF'+contents),name)});
 }
 async function telegramFile(id:string):Promise<ArrayBuffer>{
  const info=await telegram('getFile',{file_id:id});
  const path=info.file_path;
  if(info.file_size>maxBytes)throw Error('Archivo demasiado grande');
  if(typeof path!=='string'||path.length>512||!/^([A-Za-z0-9_-]+\/)*[A-Za-z0-9_.-]+$/.test(path)||path.split('/').some(p=>p==='..'||p==='.'))throw Error('Archivo Telegram inválido');
  let res:Response;
  try{res=await send('https://api.telegram.org/file/bot'+token+'/'+path,{signal:AbortSignal.timeout(25_000),redirect:'error'});}catch{throw Error('No se pudo leer archivo Telegram');}
  if(!res.ok)throw Error('No se pudo leer archivo Telegram');
  if(Number(res.headers.get('Content-Length'))>maxBytes){await res.body?.cancel();throw Error('Archivo demasiado grande');}
  if(!res.body)throw Error('Archivo Telegram vacío');
  const reader=res.body.getReader();const chunks:Uint8Array[]=[];let size=0;
  try{
   for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>maxBytes){await reader.cancel();throw Error('Archivo demasiado grande');}chunks.push(value);}
  }catch(error){if(error instanceof Error&&error.message==='Archivo demasiado grande')throw error;throw Error('No se pudo leer archivo Telegram');}
  finally{reader.releaseLock();}
  const bytes=new Uint8Array(size);let position=0;for(const chunk of chunks){bytes.set(chunk,position);position+=chunk.byteLength;}
  return bytes.buffer;
 }
 return {token,options,telegram,telegramDocument,telegramFile,botInfo};
}
export type TelegramClient=ReturnType<typeof createTelegramClient>;
export function createTelegramClientCache(send:typeof fetch=fetch){
 let current:{token:string;client:TelegramClient}|undefined;
 return (token:string)=>{if(current?.token!==token)current={token,client:createTelegramClient(token,send)};return current.client;};
}
