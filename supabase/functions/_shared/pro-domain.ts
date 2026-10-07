import {money,type Context} from './domain.ts';
import {exactSignedCop,checkRows} from './statement.ts';
export type ProAction={type:'pro';command:string;[key:string]:any};
export const pro=(command:string,extra:Record<string,any>={}):ProAction=>({type:'pro',command,...extra});
const stage=(proposal:any)=>pro('stage',{proposal});
const integer=(v:unknown)=>{const s=String(v);if(!/^\d+$/.test(s)||!Number.isSafeInteger(Number(s)))throw Error('ID inválido');return s;};
const bounded=(v:unknown,n=120)=>{if(typeof v!=='string'||!v.trim()||v.length>n)throw Error('Dato faltante');return v.trim();};
const day=(v:unknown)=>{const s=String(v);if(!/^\d{4}-\d{2}-\d{2}$/.test(s)||!Number.isFinite(Date.parse(s))||new Date(s).toISOString().slice(0,10)!==s)throw Error('Fecha inválida');return s;};
export function normalizePro(a:any,context:Context):ProAction|null{
 if(a?.type!=='pro')return null;
 const command=a.command;
 if(command==='pocket'){
  if(!context.accounts.some(ac=>ac.name===a.account&&ac.kind==='asset'&&!ac.parent_account))throw Error('Cuenta principal desconocida');
  return stage({command,account:a.account,name:bounded(a.name,40),amount:money(a.amount_cop),date:day(a.date)});
 }
 if(command==='opening_balance'){
  if(!context.accounts.some(ac=>ac.name===a.account))throw Error('Cuenta desconocida');
  return stage({command,account:a.account,amount:money(a.amount_cop),date:day(a.date)});
 }
 if(command==='setup')return pro('setup');
 if(command==='match')return stage({command,line:integer(a.line),target:integer(a.target)});
 if(command==='planning')return pro(command,{to:day(a.to)});
 if(command==='projects')return pro(command,{from:day(a.from),to:day(a.to)});
 if(['detail','reconcile','reconciliation_export'].includes(command))return pro(command,{target:integer(a.target)});
 if(['preferences','pending','cancel'].includes(command))return pro(command);
 if(command==='preference'){
  if(!context.accounts.some(ac=>ac.name===a.account)||!['family','personal'].includes(a.scope))throw Error('Preferencia incompleta');
  return stage({command,merchant:bounded(a.merchant,80),account:a.account,category:bounded(a.category,80),scope:a.scope});
 }
 if(command==='forget')return stage({command,merchant:bounded(a.merchant,80)});
 if(command==='commitment')return stage({command,label:bounded(a.label),amount:money(a.amount_cop),due:day(a.due),project:bounded(a.project??'hogar',60)});
 if(command==='goal')return stage({command,label:bounded(a.label),amount:money(a.amount_cop),reserved:money(a.reserved_cop??'0'),project:bounded(a.project??'hogar',60)});
 if(command==='reserve')return stage({command,target:integer(a.target),amount:money(a.amount_cop)});
 if(command==='complete_commitment'||command==='undo')return stage({command,target:integer(a.target)});
 if(command==='project')return stage({command,target:integer(a.target),project:bounded(a.project,60)});
 if(command==='summary'){if(typeof a.enabled!=='boolean')throw Error('Elige activar o pausar');return stage({command,enabled:a.enabled});}
 if(command==='correct'){
  const field=a.field;if(!['amount','account','accounts'].includes(field))throw Error('Solo monto o cuentas');
  if(field==='accounts'){
   const account=bounded(a.from_account,64),other=bounded(a.to_account,64);
   if(account===other)throw Error('Origen y destino deben ser diferentes');
   if(![account,other].every(name=>context.accounts.some(ac=>ac.name===name)))throw Error('Cuenta desconocida');
   return stage({command,target:integer(a.target),field,value:{account,other}});
  }
  const value=field==='amount'?money(a.amount_cop):bounded(a.account,64);
  if(field==='account'&&!context.accounts.some(ac=>ac.name===value))throw Error('Cuenta desconocida');
  return stage({command,target:integer(a.target),field,value});
 }
 if(command==='statement'){
  if(!context.accounts.some(ac=>ac.name===a.account))throw Error('Indica la cuenta del extracto');
  return stage({command,account:a.account,rows:checkRows(a.rows.map((r:any)=>({date:r.date,delta:exactSignedCop(String(r.amount_cop)),memo:r.memo})))});
 }
 throw Error('Acción pro no reconocida');
}

