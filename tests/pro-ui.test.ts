import test from 'node:test';import assert from 'node:assert/strict';
(globalThis as any).Deno={env:{get:()=>undefined}};
const {normalizePro,formatPro,proMarkup}=await import('../supabase/functions/_shared/pro.ts');
const context={members:[{id:'101',name:'Test'}],accounts:[{name:'Banco',kind:'asset',owner:'101'}]};
test('Model cannot confirm its own proposal or bypass user confirmation',()=>{
 assert.throws(()=>normalizePro({type:'pro',command:'confirm',target:'1'},context));
 const a=normalizePro({type:'pro',command:'commitment',label:'Arriendo',amount_cop:'200000',due:'2026-10-01'},context);
 assert.equal(a?.command,'stage');assert.equal(a?.proposal.amount,'20000000');
});
test('Statement preview exposes every line and never invents a posting',()=>{
 const a=normalizePro({type:'pro',command:'statement',account:'Banco',rows:[{date:'2026-09-27',amount_cop:'-15000',memo:'Compra'},{date:'2026-09-27',amount_cop:'15000',memo:'Abono'}]},context)!;
 assert.equal(a.proposal.rows[0].delta,'-1500000');assert.equal(a.command,'stage');
 const preview=formatPro({status:'preview',proposal:a.proposal});assert.match(preview!,/Compra/);assert.match(preview!,/Abono/);assert.match(preview!,/NO registra/);
});
test('Read-only planning displays computed balance and separate debt warning',()=>{
 const text=formatPro({planning:{to:'2026-10-01',cash:'10000000',reserved:'1000000',committed:'2000000',available:'7000000',debt:'5000000',goals:[],commitments:[]}});
 assert.match(text!,/70\.000/);assert.match(text!,/no se restan de nuevo/);
});
test('Opening account responses do not offer unsupported correction fields',()=>{
 const buttons=JSON.stringify(proMarkup({transaction_id:1,editable:false}));assert.ok(!buttons.includes('edit:'));assert.ok(buttons.includes('detail:1'));
});
test('Opening detail shows money, a person name and a plain explanation',()=>{
 const detail={status:'detail',transaction:{id:3,date:'2026-09-28',kind:'opening',memo:'Saldo inicial completado por el titular',actor:'101'},entries:[{account:'Banco',delta:'25013'},{account:'equity:opening',delta:'-25013'}],corrections:[]};
 const text=formatPro(detail,context)!;
 assert.match(text,/Saldo inicial/);assert.match(text,/Banco: \$250,13/);assert.match(text,/Autor: Test/);assert.doesNotMatch(text,/equity:opening|· opening|Autor: 101/);
 assert.match(text,/No cuenta como ingreso ni gasto/);
 const debt=formatPro({...detail,entries:[{account:'Tarjeta Alfa',delta:'-123456789'},{account:'equity:opening',delta:'123456789'}]}, {...context,accounts:[{name:'Tarjeta Alfa',kind:'liability',owner:'101'}]})!;
 assert.match(debt,/Deuda inicial en Tarjeta Alfa: \$1\.234\.567,89/);assert.doesNotMatch(debt,/-\$/);
});

test('Transfer correction preview names both endpoints without leaking object notation',()=>{
 const text=formatPro({status:'preview',proposal:{command:'correct',target:'30',field:'accounts',value:{account:'Banco Beta',other:'Banco Alfa'}}})!;
 assert.match(text,/Origen: Banco Beta/);assert.match(text,/Destino: Banco Alfa/);assert.doesNotMatch(text,/object Object/);
});
