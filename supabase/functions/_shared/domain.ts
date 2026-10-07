export type Context={members:{id:string;name:string}[];accounts:{name:string;kind:string;owner:string|null;parent_account?:string|null;pocket_name?:string|null}[];recent?:unknown[]};
export type Action=Record<string,string|boolean|undefined> & {type:string};
const maxCop=1_000_000_000_000n;
export function money(value:unknown):string{
 if(typeof value!=='string'||!(/^(0|[1-9]\d{0,12})(?:[.,]\d{1,2})?$/).test(value))throw Error('Monto COP sin separadores de miles y con máximo dos decimales');
 const [whole,fraction='']=value.replace(',','.').split('.');const cents=BigInt(whole)*100n+BigInt(fraction.padEnd(2,'0'));if(cents>maxCop*100n)throw Error('Monto fuera de rango');return cents.toString();
}
export function intendedChat(actual:string,configured:string){
 if(!(/^-[0-9]+$/).test(configured))throw Error('ID del grupo debe ser negativo y verificarse con Telegram');
 return actual===configured;
}
export function messageText(raw:string){return raw.trim().replace(/^\//,'').replace(/^@\w+\s*/,'').slice(0,4000);}
function date(raw:unknown,month=false){if(typeof raw!=='string'||!(/^\d{4}-\d{2}-\d{2}$/).test(raw)||!Number.isFinite(Date.parse(raw+'T00:00:00Z'))||new Date(raw+'T00:00:00Z').toISOString().slice(0,10)!==raw)throw Error('Fecha inválida');if(month&&!raw.endsWith('-01'))throw Error('Mes inválido');return raw;}
function required(s:unknown,max=120){if(typeof s!=='string'||!s.trim()||s.length>max)throw Error('Dato faltante o extenso');return s.trim();}
export function normalizeAction(raw:unknown,context:Context):Action{
 if(typeof raw!=='object'||raw===null||Array.isArray(raw))throw Error('Formato inválido');
 const a=raw as Record<string,unknown>;const type=required(a.type,20);
 if(type==='clarify')return {type,question:required(a.question,2000)};
 if(type==='report')return {type,from:date(a.from),to:date(a.to),scope:a.scope==='personal'?'personal':a.scope==='family'?'family':'all'};
 if(type==='export')return {type};
 if(type==='history')return {type};
 if(type==='reverse'){if(!Number.isSafeInteger(Number(a.target))||Number(a.target)<1)throw Error('Movimiento inválido');return {type,target:String(a.target),reason:required(a.reason,240)};}
 if(type==='reminder')return {type,label:required(a.label),date:date(a.date)};
 if(type==='budget'){
  const scope=a.scope==='personal'?'personal':'family';const beneficiary=scope==='personal'&&typeof a.beneficiary==='string'?a.beneficiary:undefined;
  if(beneficiary&&!context.members.some(m=>m.id===beneficiary))throw Error('Beneficiario desconocido');
  return {type,scope,beneficiary,category:required(a.category,80),month:date(a.month,true),amount:money(a.amount_cop)};
 }
 if(type==='account'){
  const kind=required(a.kind,20);if(!['asset','liability','receivable'].includes(kind))throw Error('Tipo de cuenta inválido');
  const owner=required(a.owner,30);if(!context.members.some(m=>m.id===owner))throw Error('Titular desconocido');
  const name=required(a.name,64);if(context.accounts.some(ac=>ac.name.toLowerCase()===name.toLowerCase()))throw Error('Cuenta repetida');
  return {type,kind,name,owner,date:date(a.date),amount:money(a.amount_cop)};
 }
 if(type==='post'){
  const kind=required(a.kind,20);if(!['income','expense','refund','transfer','borrow','lend','repayment','collection'].includes(kind))throw Error('Operación desconocida');
  const payer=required(a.payer,30);if(!context.members.some(m=>m.id===payer))throw Error('Pagador desconocido');
  const account=required(a.account,64);if(!context.accounts.some(ac=>ac.name===account))throw Error('Cuenta desconocida');
  const other=typeof a.other==='string'?a.other:undefined;
  if(['transfer','borrow','lend','repayment','collection'].includes(kind)&&(!other||other===account||!context.accounts.some(ac=>ac.name===other)))throw Error('Cuenta destino desconocida');
  const category=['income','expense','refund'].includes(kind)?required(a.category,80):undefined;
  const scope=a.scope==='personal'?'personal':a.scope==='family'?'family':null;if(!scope)throw Error('Alcance inválido');
  const beneficiary=scope==='personal'&&typeof a.beneficiary==='string'?a.beneficiary:undefined;
  if(beneficiary&&!context.members.some(m=>m.id===beneficiary))throw Error('Beneficiario desconocido');
  const counterparty=a.counterparty===undefined?undefined:required(a.counterparty,120);
  return {type,kind,payer,beneficiary,account,other,category,scope,date:date(a.date),amount:money(a.amount_cop),memo:typeof a.memo==='string'?a.memo.slice(0,240):'',...counterparty?{counterparty}:{}};
 }
 throw Error('Tipo de acción desconocido');
}
export type Incoming={chatId?:string;chatType?:'group'|'supergroup'|'private';id:number;actor:string;name:string;group:string;text:string;voice?:string;photo?:string;callback?:string;reply?:string;messageId?:number;threadId?:number;isTopic?:boolean;callbackId?:string;replyTo?:number;document?:string;documentName?:string};
export function extractUpdate(u:any):Incoming{
 const m=u?.message??u?.callback_query?.message;
 const from=u?.callback_query?.from??m?.from;
 if(!Number.isSafeInteger(u?.update_id)||!Number.isSafeInteger(from?.id)||from?.is_bot||!Number.isSafeInteger(m?.chat?.id)||!['group','supergroup','private'].includes(m.chat.type)||(m.chat.type==='private'&&m.chat.id!==from.id)||m.sender_chat)throw Error('Telegram update no autorizado');
 const photos=m.photo as {file_id:string}[]|undefined;
 return {chatId:String(m.chat.id),chatType:m.chat.type,replyTo:u?.callback_query?m.message_id:m.reply_to_message?.message_id,document:m.document?.file_id,documentName:m.document?.file_name,messageId:m.message_id,threadId:m.message_thread_id,isTopic:m.is_topic_message===true,callbackId:u?.callback_query?.id,id:u.update_id,actor:String(from.id),name:String(from.first_name??'Miembro').slice(0,80),group:String(m.chat.id),text:messageText(m.text??m.caption??''),voice:m.voice?.file_id,photo:photos?.at(-1)?.file_id,callback:u?.callback_query?.data,reply:m.reply_to_message?.text};
}
export function cop(cents:string){const n=BigInt(cents);const sign=n<0n?'-':'';const absolute=n<0n?-n:n;const whole=absolute/100n;const rest=absolute%100n;return sign+'$'+new Intl.NumberFormat('es-CO').format(whole)+(rest?','+rest.toString().padStart(2,'0'):'')+' COP';}
export function formatResult(r:any):string{
 const approvals=Array.isArray(r?.approval_requests)?r.approval_requests.map((q:any)=>`⏳ Solicitud #${q.id}: pendiente de confirmación del responsable; todavía no registrada.`).join('\n'):'';
 if(r?.receipts)return [...r.receipts.map((item:any)=>formatResult(item)),approvals].filter(Boolean).join('\n');
 if(r?.status==='approval_pending'&&approvals)return approvals;
 if(r?.received)return r.received.length?r.received.map((q:any)=>`⏳ Solicitud #${q.id}: pendiente. Usa los botones o escribe «confirmar solicitud ${q.id}» o «rechazar solicitud ${q.id}».`).join('\n'):'No tienes solicitudes de confirmación pendientes.';
 if(r?.receipt){const a=r.receipt;const names:Record<string,string>={expense:'Gasto registrado',income:'Ingreso registrado',transfer:'Transferencia registrada',refund:'Devolución registrada',borrow:'Préstamo recibido',lend:'Préstamo otorgado',repayment:'Pago de deuda registrado',collection:'Cobro registrado'};return `✅ ${names[a.kind]??'Movimiento registrado'} #${r.transaction_id}: ${cop(a.amount)} · ${a.memo||a.account}${a.counterparty?' · Contraparte: '+a.counterparty:''} · ${a.account}${a.other?' → '+a.other:''} · ${a.scope==='family'?'familiar':'personal'}`;}

 if(r?.report){const p=r.report;const grouped=new Set((p.pocket_groups??[]).flatMap((g:any)=>[g.account,...g.pockets.map((x:any)=>x.account)]));const groups=(p.pocket_groups??[]).map((g:any)=>`• ${g.account} — disponible: ${cop(g.available)}\n${g.pockets.map((x:any)=>`  ◦ ${x.name}: ${x.balance_known===false?'saldo inicial pendiente; variación ':''}${cop(x.balance)}`).join('\n')}\n  Total ${g.account}: ${g.balance_known===false?'pendiente de completar saldos':cop(g.total)}`).join('\n');const balances=[groups,(p.balances??[]).filter((a:any)=>!grouped.has(a.name)).map((a:any)=>`• ${a.name}: ${a.balance_known===false?'saldo inicial pendiente; variación registrada '+cop(a.balance):cop(a.balance)}${a.kind==='liability'?' de deuda':''}`).join('\n')].filter(Boolean).join('\n');
 const categories=(p.categories??[]).map((c:any)=>`${c.category}: ${cop(c.amount)}`).join(' · ');
 const budgets=(p.budgets??[]).map((b:any)=>`${b.category}: límite ${cop(b.limit)} (${b.scope})`).join('\n');
 return `📊 Ingresos: ${cop(p.income)}\nGastos: ${cop(p.expense)}\n${categories?categories+'\n':''}${balances}${budgets?'\nPresupuestos:\n'+budgets:''}\nSaldos registrados; verifica con tus cuentas bancarias.`;}
 if(r?.history)return '📋 '+((r.history as any[]).map(t=>`#${t.id} · ${t.date} · ${t.kind} · ${cop(t.amount??'0')} · ${t.memo??''}${t.reverses?' (reversa de #'+t.reverses+')':''}`).join('\n')||'Aún no hay movimientos.');
 const icon=r?.status==='clarify'?'💬':r?.status==='duplicate'||r?.status==='failed'?'⚠️':r?.status==='reminder'?'🔔':r?.status==='alert'?'📌':'✅';
 return `${icon} ${r?.message??'No se pudo responder'}${r?.transaction_id?' #'+r.transaction_id:''}`;
}
export function ledgerCsv(rows:Record<string,unknown>[]):string{
 const columns=['transaction_id','date','kind','category','scope','payer','beneficiary','account','delta','memo','reverses'];
 const safe=(v:unknown)=>'"'+String(v??'').replaceAll('"','""')+'"';
 return [columns.join(','),...rows.map(row=>columns.map(c=>safe(row[c])).join(','))].join('\r\n')+'\r\n';
}
