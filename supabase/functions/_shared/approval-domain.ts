export type ApprovalRequest={id:string;revision:number;state:'pending'|'posted'|'rejected'|'cancelled'|'superseded'|'expired';reporter:string;reporter_name?:string;required_members:string[];accepted_members:string[];action:Record<string,unknown>;effective_action?:Record<string,unknown>;created_at:string;expires_at:string;result?:Record<string,unknown>};
export type TelegramRoute={chat_id:string;thread_id?:number;message_id?:number};
import {cop} from './domain.ts';
export function approvalCard(request:ApprovalRequest,memberId:string,memberName:string,botUsername:string){
 const a=request.effective_action??request.action;
 const movement=(v:any)=>{const kinds:Record<string,string>={income:'Ingreso',expense:'Gasto',transfer:'Transferencia',refund:'Devolución',borrow:'Préstamo recibido',lend:'Préstamo otorgado',repayment:'Pago de deuda',collection:'Cobro'};return `${kinds[v.kind]??'Movimiento'} · ${cop(String(v.amount))} · ${String(v.account)}${v.other?' → '+String(v.other):''} · ${String(v.date)} · ${v.scope==='family'?'familiar':'personal'}${v.memo?' · '+String(v.memo).slice(0,60):''}`;};
 const account=(v:any)=>`Cuenta ${String(v.name)} · saldo inicial ${cop(String(v.amount))} · ${String(v.date)} · personal`;
 const items=Array.isArray(a.approval_items)?a.approval_items as any[]:[];
 let details:string;
 if(a.command==='correct')details=`Corrección de #${a.target}\nAntes: ${movement(a.original_movement)}\nDespués: ${movement(items.find(v=>v.type==='post'))}`;
 else if(a.command==='undo'||a.type==='reverse')details=`Revertir #${a.target}: ${(a.original_movement as any)?.type==='account'?account(a.original_movement):movement(a.original_movement)}`;
 else if(a.command==='account'||a.type==='account')details=[account(a),...items.filter(v=>v.type==='post').map(v=>movement(v))].join('\n');
 else if(a.type==='batch_post')details=(a.items as any[]).map(movement).join('\n');
 else details=movement(a);
 const name=memberName||'Responsable';
 const text=`${name}, confirma la solicitud #${request.id}\n${details}\nInformada por ${request.reporter_name??request.reporter}. Aún no está registrada. Vence en 48 horas desde su creación.`;
 const keyboard:any[][]=[[{text:'Confirmar',callback_data:`aconfirm:${request.id}:${request.revision}`},{text:'Rechazar',callback_data:`areject:${request.id}:${request.revision}`}]];
 if(/^[A-Za-z0-9_]{5,32}$/.test(botUsername))keyboard.push([{text:'Habilitar avisos privados',url:`https://t.me/${botUsername}?start=confirmaciones`}]);
 return {text,entities:[{type:'text_mention',offset:0,length:name.length,user:{id:Number(memberId),is_bot:false,first_name:name}}],reply_markup:{inline_keyboard:keyboard},disable_web_page_preview:true};
}
import type {Incoming} from './domain.ts';
export function parseApprovalIntent(input:Incoming):{kind:'start'|'list'}|{kind:'decision';request_id?:string;revision?:number;decision:'confirm'|'reject'}|undefined{
 const match=input.callback?.match(/^(aconfirm|areject):(\d+):(\d+)$/);
 if(match)return {kind:'decision',request_id:match[2],revision:Number(match[3]),decision:match[1]==='aconfirm'?'confirm':'reject'};
 const text=input.text.trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/^\//,'');
 if(input.chatType==='private'&&/^start(?:[ @].*)?$/.test(text))return {kind:'start'};
 if(/^(?:pendientes|confirmaciones)$/.test(text))return {kind:'list'};
 const reference=text.match(/^(confirmar|confirmo|aceptar|acepto|rechazar|rechazo|cancelar)( la)? solicitud (\d+)[.!]*$/);
 if(reference)return {kind:'decision',request_id:reference[3],decision:['rechazar','rechazo','cancelar'].includes(reference[1])?'reject':'confirm'};
 if(/^(si|correcto|confirmo|confirmar|acepto)[.!]*$/.test(text))return {kind:'decision',decision:'confirm'};
 if(/^(no|rechazo|rechazar|cancelar)[.!]*$/.test(text))return {kind:'decision',decision:'reject'};
}
export async function waitForApprovalActivation(rpc:(op:string)=>Promise<any>,pause:()=>Promise<unknown>,signal:AbortSignal){
 while(!signal.aborted&&!(await rpc('approval:enabled')).enabled)await pause();signal.throwIfAborted();
}
