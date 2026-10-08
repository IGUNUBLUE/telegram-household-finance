import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {approvalDatabase} from './fixtures/approval-database.ts';
import {dispatchTool} from '../supabase/functions/_shared/agent-tools.ts';

let f:Awaited<ReturnType<typeof approvalDatabase>>;
const ids:Record<string,string>={};
const amounts:Record<string,string>={};let nextAmount=11327;
async function post(label:string,actor:string,payer:string,account:string,kind='income',date='2026-10-06',scope='family'){
 const amount=String(nextAmount++);amounts[label]=(Number(amount)/100).toFixed(2);
 const e=await f.event(actor);const r=await f.rpc('agent:apply',{id:e.id,action:{type:'post',kind,account,amount,payer,date,scope,category:'Prueba',memo:label,...scope==='personal'?{beneficiary:payer}:{}}});
 assert.ok(r.transaction_id,JSON.stringify(r));
 ids[label]=String(r.transaction_id);return ids[label];
}
async function search(actor:string,args:any={}){return f.rpc('agent:search',{id:(await f.event(actor)).id,...args});}
const listIds=(r:any)=>r.movements.map((m:any)=>m.id);
before(async()=>{
 f=await approvalDatabase();
 await post('Ingreso Sam','202','202','Cuenta Dos');
 for(let i=0;i<34;i++)await post('Ingreso Alex '+i,'101','101','Cuenta Uno','income','2026-10-07');
 await post('Recibido por Sam y registrado por Alex','101','202','Cuenta Uno');
 await post('Gasto de Sam registrado por Alex','101','202','Cuenta Dos','expense');
 await post('Gasto personal de Alex','101','101','Cuenta Uno','expense','2026-10-06','personal');
 await post('Registrado al final con fecha anterior','101','101','Cuenta Uno','income','2026-10-05');
 await f.enable();
});
after(async()=>{await f?.db.close();});

test('Own latest income filters its author before the global display limit, including family entries',async()=>{
 const r=await search('202',{kind:'income',person_scope:'mine',person_role:'author',limit:1});
 assert.deepEqual(listIds(r),[ids['Ingreso Sam']]);assert.equal(r.total_matches,1);assert.equal(r.complete,true);
 assert.equal(r.movements[0].actor,'202');assert.equal(r.movements[0].scope,'family');
 assert.equal(r.person_filter.member_id,'202');assert.equal(r.person_filter.role,'author');
});
test('My identity comes from the stored event and cannot be changed by actor/owner/payer arguments',async()=>{
 const r=await search('202',{kind:'income',person_scope:'mine',person_role:'author',actor:'101',owner:'101',payer:'101'});
 assert.deepEqual(listIds(r),[ids['Ingreso Sam']]);
 await assert.rejects(search('202',{person_scope:'mine',member_id:'101'}),/member/);
});
test('Author, internal payer/recipient and account manager are separate searchable roles',async()=>{
 const received=await search('202',{kind:'income',person_scope:'mine',person_role:'payer'});
 assert.deepEqual(new Set(listIds(received)),new Set([ids['Ingreso Sam'],ids['Recibido por Sam y registrado por Alex']]));
 const registered=await search('202',{kind:'expense',person_scope:'mine',person_role:'author'});
 assert.equal(registered.exists,false);assert.equal(registered.total_matches,0);assert.deepEqual(registered.movements,[]);
 const paid=await search('202',{kind:'expense',person_scope:'mine',person_role:'payer'});
 const managed=await search('202',{kind:'expense',person_scope:'mine',person_role:'account_owner'});
 assert.deepEqual(listIds(paid),[ids['Gasto de Sam registrado por Alex']]);assert.deepEqual(listIds(managed),listIds(paid));
 assert.equal(received.movements.find((m:any)=>m.id===ids['Recibido por Sam y registrado por Alex']).accounts[0].owner,'101');
});
test('An explicitly named member replaces prior scope and shared ledger reads remain available',async()=>{
 const other=await search('101',{kind:'income',person_scope:'member',member_id:'202',person_role:'author'});
 assert.deepEqual(listIds(other),[ids['Ingreso Sam']]);
 const global=await search('101',{kind:'income',person_scope:'all',limit:1});
 assert.deepEqual(listIds(global),[ids['Ingreso Alex 33']]);assert.ok(global.total_matches>30);assert.equal(global.complete,false);
 const own=await search('202',{kind:'income',person_scope:'mine',person_role:'author',limit:1});
 assert.deepEqual(listIds(own),[ids['Ingreso Sam']]);
});
test('Latest financial date and latest registration have explicit stable ordering after filtering',async()=>{
 const byDate=await search('101',{kind:'income',person_scope:'mine',person_role:'author',limit:1,sort_by:'date'});
 const byRegistration=await search('101',{kind:'income',person_scope:'mine',person_role:'author',limit:1,sort_by:'registered'});
 assert.deepEqual(listIds(byDate),[ids['Ingreso Alex 33']]);
 assert.deepEqual(listIds(byRegistration),[ids['Registrado al final con fecha anterior']]);
 assert.equal(byRegistration.sort_by,'registered');assert.equal(byDate.sort_by,'date');
 assert.equal(byRegistration.total_matches,byDate.total_matches);
});
test('Person filters intersect dates, amount, kind and account instead of broadening a request',async()=>{
 const amount_cop=amounts['Recibido por Sam y registrado por Alex'];
 const r=await search('202',{person_scope:'mine',person_role:'payer',kind:'income',account:'Cuenta Uno',amount_cop,from:'2026-10-06',to:'2026-10-06'});
 assert.deepEqual(listIds(r),[ids['Recibido por Sam y registrado por Alex']]);assert.equal(r.movements[0].amount_cop,amount_cop);
 const none=await search('202',{person_scope:'mine',person_role:'author',kind:'income',account:'Cuenta Uno'});
 assert.equal(none.exists,false);assert.deepEqual(none.movements,[]);
});
test('Unsupported person filters, unknown members, inconsistent combinations and limits are errors',async()=>{
 for(const args of [{person_scope:'bogus'},{person_scope:null},{person_role:'beneficiary'},{person_role:null},{person_scope:'member'},{person_scope:'member',member_id:'999'},{person_scope:'all',member_id:'202'},{member_id:'202'},{person_role:'payer'},{sort_by:'oldest'},{sort_by:null},{limit:0},{limit:31},{limit:1.5},{limit:null}]){
  await assert.rejects(search('101',args));
 }
 await assert.rejects(f.rpc('agent:search',{id:999999999,person_scope:'mine'}),/unknown event/);
});
test('Person-aware queries are read-only and reversed records stay excluded',async()=>{
 const before=await f.snapshotLedger();await search('202',{person_scope:'mine',person_role:'payer'});
 assert.deepEqual(await f.snapshotLedger(),before);
 const temporary=await post('Ingreso temporal para reversar','202','202','Cuenta Dos');
 await f.rpc('agent:apply',{id:(await f.event('202')).id,action:{type:'reverse',target:temporary,reason:'Prueba ficticia'}});
 assert.ok(!(await search('202',{person_scope:'mine',person_role:'author'})).movements.some((m:any)=>m.id===temporary));
});
test('The search tool exposes structured person filters, rejects injected identities and does not write money',async()=>{
 const e=await f.event('202');const context={actor:'202',event_id:e.id,members:[{id:'101',name:'Alex'},{id:'202',name:'Sam'}],accounts:[]};
 const before=await f.snapshotLedger();
 const r=await dispatchTool('buscar_movimientos',{kind:'income',person_scope:'mine',person_role:'author',sort_by:'registered',limit:1},context,f.rpc);
 assert.deepEqual(listIds(r.result),[ids['Ingreso Sam']]);assert.equal(r.action,undefined);assert.deepEqual(await f.snapshotLedger(),before);
 await assert.rejects(dispatchTool('buscar_movimientos',{person_scope:'mine',actor:'101'},context,f.rpc));
});
test('Filtered period totals cover all matching movements, including rows beyond the display limit',async()=>{
 const r=await search('101',{person_scope:'mine',person_role:'payer',kind:'income',from:'2026-10-07',to:'2026-10-07',limit:1});
 const cents=Array.from({length:34},(_,i)=>11328+i).reduce((sum,n)=>sum+n,0);
 assert.equal(r.total_matches,34);assert.equal(r.complete,false);assert.equal(r.totals_cop.income,(cents/100).toFixed(2));
 const noExpenses=await search('202',{person_scope:'mine',person_role:'author',kind:'expense'});
 assert.equal(noExpenses.totals_cop.expense,'0.00');
});
test('Family/personal classification filters independently of the requested person and role',async()=>{
 const family=await search('101',{kind:'expense',person_scope:'mine',person_role:'author',movement_scope:'family'});
 const personal=await search('101',{kind:'expense',person_scope:'mine',person_role:'author',movement_scope:'personal'});
 assert.deepEqual(listIds(family),[ids['Gasto de Sam registrado por Alex']]);
 assert.deepEqual(listIds(personal),[ids['Gasto personal de Alex']]);
 await assert.rejects(search('101',{movement_scope:'mine'}));await assert.rejects(search('101',{movement_scope:null}));
});
