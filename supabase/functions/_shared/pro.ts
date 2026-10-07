import {unknownBalance,hasAmountEvidence} from './flow.ts';
import {socialIntent,resolveConfirmation} from './natural.ts';
import {cop,money,formatResult,type Incoming,type Context} from './domain.ts';
import {exactSignedCop,checkRows,parseStatementCsv} from './statement.ts';
import {rpc,telegramFile,today} from './io.ts';
import {pro} from './pro-domain.ts';
export {pro,normalizePro} from './pro-domain.ts';
const stage=(proposal:any)=>pro('stage',{proposal});
export async function handlePro(input:Incoming,text:string,context:Context,conversation:any,agentic=false):Promise<any|null>{
 if(agentic&&!input.callback&&!input.document)return null;
 const cb=input.callback??'';const m=text.trim().toLowerCase();
 const intent=socialIntent(text);
 const natural=context as any;
 const confirmation=!cb?resolveConfirmation(text,(natural.reply_result??natural.latest_result)?.proposal_id?(natural.pending_proposals??[]):[],(natural.reply_result??natural.latest_result)?.proposal_id):null;
 if(confirmation?.command==='confirm')return pro('confirm',{target:confirmation.target});
 if(confirmation?.command==='ambiguous')return {type:'clarify',question:'Hay varias propuestas por confirmar. Responde al mensaje de la que quieres aceptar o toca su botón.'};
 if(confirmation?.command==='missing')return {type:'clarify',question:'No encuentro una propuesta pendiente para confirmar. ¿Qué quieres que hagamos?'};
 if(intent==='cancel')return pro('cancel');
 if(/^pconfirm:\d+$/.test(cb))return pro('confirm',{target:cb.split(':')[1]});
 if(/^pcancel:\d+$/.test(cb))return pro('cancel_proposal',{target:cb.split(':')[1]});
 if(/^detail:\d+$/.test(cb))return pro('detail',{target:cb.split(':')[1]});
 if(/^undo:\d+$/.test(cb))return stage({command:'undo',target:cb.split(':')[1]});
 if(/^reconcile:\d+$/.test(cb))return pro('reconcile',{target:cb.split(':')[1]});
 if(/^match:\d+:\d+$/.test(cb)){const [,line,target]=cb.split(':');return stage({command:'match',line,target});}
 if(/^edit:\d+:(amount|account)$/.test(cb)){
  const [,target,field]=cb.split(':');const permission=await rpc('pro:mode',{id:input.id,mode:{kind:'edit',target,field}});
  if(permission.status==='clarify')return {type:'clarify',question:permission.message};
  return {type:'clarify',question:field==='amount'?'¿Cuál es el monto correcto en pesos?':'¿Desde qué cuenta se pagó realmente?'};
 }
 if(['cancelar','nuevo'].includes(m))return pro('cancel');
 if(m==='pendientes')return pro('pending');
 if(m==='preferencias')return pro('preferences');
 if(m==='plan'||m==='planificacion')return pro('planning',{to:today().slice(0,7)+'-'+new Date(Number(today().slice(0,4)),Number(today().slice(5,7)),0).getDate()});
 if(m==='proyectos')return pro('projects',{from:today().slice(0,7)+'-01',to:today()});
 if(m==='resumen semanal')return stage({command:'summary',enabled:true});
 if(m==='pausar resumen')return stage({command:'summary',enabled:false});
 if(/^cerrar compromiso \d+$/.test(m))return stage({command:'complete_commitment',target:m.split(' ').at(-1)});
 if(/^conciliar linea \d+ con movimiento \d+$/.test(m)){const ids=m.match(/\d+/g)!;return stage({command:'match',line:ids[0],target:ids[1]});}
 if(/^diferencias \d+$/.test(m))return pro('reconciliation_export',{target:m.split(' ')[1]});
 if(/^conciliar \d+$/.test(m))return pro('reconcile',{target:m.split(' ')[1]});
 if(intent==='setup'){
  await rpc('pro:mode',{id:input.id,mode:{kind:'setup'}});return {type:'clarify',question:'Empecemos con una cuenta. ¿Qué nombre le ponemos? Por ejemplo: Tarjeta Alfa Alex o Efectivo.'};
 }
 const mode=conversation?.mode??{};
 if(mode.kind==='account_balance'&&!cb){
  if(unknownBalance(text))return stage({...mode.draft,amount:'0',balance_known:false,command:'account'});
  if(!hasAmountEvidence(text))return {type:'clarify',question:'Necesito el saldo antes del movimiento. Si no lo sabes, dime «no sé» y lo dejaré pendiente, sin suponer cero.'};
  try{const amount=exactSignedCop(text);if(BigInt(amount)<0n)throw Error();return stage({...mode.draft,amount,balance_known:true,command:'account'});}catch{/* Amount in words continues through the LLM with this draft. */}
 }

 if(mode.kind==='edit'&&!cb&&!input.photo&&!input.document){
  if(mode.field==='amount'){try{const value=exactSignedCop(text);if(BigInt(value)<=0n)throw Error();return stage({command:'correct',target:mode.target,field:'amount',value});}catch{return null;}}
  const account=context.accounts.find(ac=>ac.name.toLowerCase()===m);
  return account?stage({command:'correct',target:mode.target,field:'account',value:account.name}):null;
 }
 if(input.document){
  if(!/\.csv$/i.test(input.documentName??''))return {type:'clarify',question:'Para conciliar envíame un CSV o una foto del extracto. Aún no leo extractos PDF directamente.'};
  const account=context.accounts.find(ac=>m.includes(ac.name.toLowerCase()));
  if(!account)return {type:'clarify',question:'Reenvía el CSV con el nombre exacto de la cuenta en el comentario.'};
  try{return stage({command:'statement',account:account.name,rows:parseStatementCsv(new TextDecoder().decode(await telegramFile(input.document)))});}catch(e){return {type:'clarify',question:(e instanceof Error?e.message:'No pude leer el CSV').slice(0,200)};}
 }
 return null;
}
export function proMarkup(r:any){
 if(r.proposal_id)return {inline_keyboard:[[{text:'Confirmar',callback_data:'pconfirm:'+r.proposal_id},{text:'Cancelar',callback_data:'pcancel:'+r.proposal_id}]]};
 if(r.batch_id)return {inline_keyboard:[[{text:'Ver diferencias',callback_data:'reconcile:'+r.batch_id}],...(r.rows??[]).filter((x:any)=>!x.matched).slice(0,8).flatMap((x:any)=>(x.candidates??[]).slice(0,3).map((c:any)=>[{text:`Línea ${x.id} ↔ #${c.id}`,callback_data:`match:${x.id}:${c.id}`}]))]};
 if(r.transaction_id&&r.editable===false)return {inline_keyboard:[[{text:'Detalle',callback_data:'detail:'+r.transaction_id},{text:'Deshacer',callback_data:'undo:'+r.transaction_id}]]};
 if(r.transaction_id)return {inline_keyboard:[[{text:'Detalle',callback_data:'detail:'+r.transaction_id},{text:'Cambiar monto',callback_data:`edit:${r.transaction_id}:amount`}],[{text:'Cambiar cuenta',callback_data:`edit:${r.transaction_id}:account`},{text:'Deshacer',callback_data:'undo:'+r.transaction_id}]]};
 return undefined;
}
export function formatPro(r:any,context?:Context):string|null{
 if(r.account_created&&r.receipts)return `✅ Cuenta ${r.account_name} creada.\n`+r.receipts.map(formatResult).join('\n');
 if(r.pocket_created)return `✅ Guardé el bolsillo ${r.pocket} de ${r.account} con ${cop(r.opening_amount)} de saldo inicial. No cuenta como ingreso ni gasto.`;
 if(r.opening_completed)return `✅ Guardé ${cop(r.opening_amount)} como saldo inicial de ${r.account} al ${r.date}. No cuenta como ingreso ni gasto.`;
 if(r.status==='preview'){
  const a=r.proposal;
  if(a.command==='pocket')return `Registraré el bolsillo ${a.name} dentro de ${a.account}, con ${cop(a.amount)} que ya tenías allí al ${a.date}. Es adicional al disponible de la cuenta. ¿Lo confirmas?`;
  if(a.command==='opening_balance')return `Guardaré ${cop(a.amount)} como saldo inicial de ${a.account} al ${a.date}, antes de sus movimientos de ese día. No cuenta como ingreso ni gasto. ¿Lo confirmas?`;
  if(a.command==='account'){
   const kind=a.kind==='liability'?'cuenta de deuda':a.kind==='receivable'?'cuenta por cobrar':'cuenta';
   const balance=a.balance_known===false?'Dejaremos '+(a.kind==='liability'?'la deuda actual':'el saldo inicial')+' sin verificar hasta que lo consultes.':(a.kind==='liability'?'Deuda actual: ':'Saldo inicial: ')+cop(a.amount)+'.';
   const linked=(a.linked_drafts??[]).map((d:any)=>{const f=d.fields;return '• '+(f.memo||'Movimiento')+(f.amount_cop?' · '+cop(money(f.amount_cop)):'')+' · '+(f.account??'cuenta pendiente')+(f.other?' → '+f.other:'')+(f.scope?' · '+(f.scope==='personal'?'personal':'familiar'):' · alcance pendiente');}).join('\n');
   return 'Agregaré '+a.name+' como '+kind+(a.ownerName?' a nombre de '+a.ownerName:'')+'. '+balance+(linked?'\nMovimientos solicitados vinculados:\n'+linked+'\nAl confirmar registraré los movimientos si todos están completos; si falta algo, crearé solo la cuenta y conservaré esos datos pendientes. ¿Confirmas?':' ¿La guardo?');
  }
  const lines=['🔎 Antes de confirmar:'];
  if(a.command==='statement')lines.push(`Extracto de ${a.account} · ${a.rows.length} líneas`,...a.rows.map((x:any)=>`${x.date} · ${cop(x.delta)} · ${x.memo}`),'Negativo: salida o compra de tarjeta. Positivo: entrada o abono. Esto NO registra movimientos.');
  else{
   const names:any={preference:'Guardar preferencia',forget:'Olvidar preferencia',correct:'Corregir movimiento',undo:'Deshacer movimiento',account:'Crear cuenta',commitment:'Reservar compromiso',goal:'Crear meta',reserve:'Cambiar reserva',project:'Asignar proyecto',summary:'Resumen semanal',complete_commitment:'Cerrar compromiso',match:'Conciliar línea'};
   lines.push(names[a.command]??a.command);
   for(const key of ['target','line','merchant','name','label','account','category','scope','project','due','date','kind','ownerName','owner'])if(a[key]!==undefined)lines.push(`${({target:'Referencia',line:'Línea',merchant:'Comercio',name:'Nombre',label:'Concepto',account:'Cuenta',category:'Categoría',scope:'Alcance',project:'Proyecto',due:'Vence',date:'Fecha',kind:'Tipo',ownerName:'Titular',owner:'ID titular'} as any)[key]}: ${a[key]}`);
   if(a.command==='account'&&a.balance_known===false)lines.push('Saldo inicial: pendiente de verificar (no es cero).');else if(a.amount!==undefined)lines.push('Monto: '+cop(a.amount));if(a.reserved!==undefined)lines.push('Reserva: '+cop(a.reserved));
   if(a.command==='correct'){
    if(a.field==='accounts')lines.push('Origen: '+a.value.account,'Destino: '+a.value.other);
    else lines.push(a.field==='amount'?'Monto nuevo: '+cop(a.value):'Cuenta nueva: '+a.value);
   }
   if(a.command==='summary')lines.push(a.enabled?'Activar los lunes, 8:00 a. m. Colombia':'Pausar');
   if(a.command==='complete_commitment')lines.push('No registra el pago; solo libera la reserva.');
  }return lines.join('\n');
 }
 if(r.planning){const p=r.planning;return `📊 Plan hasta ${p.to}\nDinero registrado: ${cop(p.cash)}\nReservado para metas: ${cop(p.reserved)}\nCompromisos hasta esa fecha: ${cop(p.committed)}\nDisponible estimado: ${p.unknown_accounts?.length?'pendiente de conocer saldos iniciales':cop(p.available)}\nDeudas registradas: ${cop(p.debt)} (no se restan de nuevo; reserva sus cuotas como compromisos)\n\nCompromisos:\n${p.commitments.map((x:any)=>`#${x.id} ${x.label} · ${cop(x.amount)} · ${x.due} · ${x.project}`).join('\n')||'Ninguno'}\nMetas:\n${p.goals.map((x:any)=>`#${x.id} ${x.label} · ${cop(x.reserved)} de ${cop(x.target)} · ${x.project}`).join('\n')||'Ninguna'}\n${p.unknown_accounts?.length?'Saldos iniciales pendientes: '+p.unknown_accounts.join(', ')+'. ':''}Se basa en lo registrado; no verifica el banco.`;}
 if(r.status==='detail'){
  const t=r.transaction;
  const kinds:Record<string,string>={opening:'Saldo inicial',income:'Ingreso',expense:'Gasto',refund:'Devolución',transfer:'Transferencia',borrow:'Préstamo recibido',lend:'Préstamo otorgado',repayment:'Pago de deuda',collection:'Cobro',reverse:'Reversión'};
  const entries=(r.entries??[]).filter((e:any)=>t.kind!=='opening'||e.account!=='equity:opening').map((e:any)=>{
   const ac=context?.accounts.find(a=>a.name===e.account);
   if(t.kind==='opening'&&ac?.kind==='liability')return `Deuda inicial en ${e.account}: ${cop((-BigInt(e.delta)).toString())}`;
   const label=e.account==='equity:opening'?'Contrapartida del saldo inicial':e.account;
   return `${label}: ${cop(e.delta)}`;
  });
  const author=context?.members.find(m=>m.id===String(t.actor))?.name??'Nombre no disponible';
  return [`📋 Movimiento #${t.id}`,`${t.date} · ${kinds[t.kind]??'Movimiento'}`,t.memo,...entries,...(t.kind==='opening'?['No cuenta como ingreso ni gasto.']:[]),`Autor: ${author}`,`Reversiones: ${(r.corrections??[]).map((c:any)=>`#${c.id} ${c.reason}`).join('; ')||'ninguna'}`].filter(Boolean).join('\n');
 }
 if(r.status==='preferences')return '📌 Tus preferencias:\n'+(r.data.preferences.map((p:any)=>`${p.merchant}: ${p.account}, ${p.category}, ${p.scope}`).join('\n')||'Aún no hay. Dime, por ejemplo: recuerda que Netflix sale de Tarjeta Alfa y es familiar.')+'\n\nPatrones para revisar:\n'+(r.data.suggestions.map((p:any)=>`${p.merchant}: ${p.account}, ${p.category} (${p.occurrences} veces)`).join('\n')||'Sin sugerencias todavía.');
 if(r.status==='pending_list')return '💬 Tus pendientes:\n'+(r.items.map((x:any)=>`#${x.id}: ${x.text}`).join('\n')||'Ninguno.')+'\nResponde al mensaje de ese asunto para continuarlo. Si prefieres dejarlo, dime «dejemos eso».';
 if(r.status==='projects')return '📊 Por proyecto:\n'+(r.items.map((x:any)=>`${x.project}: ingresos ${cop(x.income)} · gastos ${cop(x.expense)}`).join('\n')||'Sin movimientos.');
 if(r.status==='reconcile')return `🔎 Extracto #${r.batch_id}\n`+r.rows.map((x:any)=>`Línea ${x.id}: ${x.date} · ${cop(x.delta)} · ${x.memo}\n${x.matched?'Conciliada con #'+x.matched:x.candidates.length?'Candidatos: '+x.candidates.map((c:any)=>'#'+c.id).join(', '):'Sin coincidencia: revisar, no se creó gasto.'}`).join('\n')+'\n\nEn el libro sin conciliar en ese período:\n'+(r.ledger_unmatched??[]).map((x:any)=>`#${x.id} ${x.date} · ${cop(x.delta)} · ${x.memo}`).join('\n')+`\nSi quieres, dime «envíame las diferencias en un archivo». También puedes indicarme qué línea corresponde a qué movimiento.`;
 return null;
}
