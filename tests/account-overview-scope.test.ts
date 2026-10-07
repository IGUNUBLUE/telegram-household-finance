import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {approvalDatabase} from './fixtures/approval-database.ts';
import {workerDatabase} from './fixtures/worker-database.ts';
import {dispatchTool} from '../supabase/functions/_shared/agent-tools.ts';
let f:Awaited<ReturnType<typeof approvalDatabase>>;
const day='2026-10-05';
async function account(actor:string,name:string,kind:string,amount:string,known=true,date='2026-09-01'){
 const e=await f.event(actor);return f.rpc('agent:apply',{id:e.id,action:{type:'account',name,kind,owner:actor,amount,balance_known:known,date}});
}
async function overview(actor:string,scope='mine',as_of=day,extra:any={}){return f.rpc('family:overview',{id:(await f.event(actor)).id,as_of,account_scope:scope,...extra});}
before(async()=>{
 f=await approvalDatabase();
 await account('101','Ahorro Uno','asset','1000013');
 await account('101','Deuda Uno','liability','200019');
 await account('101','Cobro Uno','receivable','40023');
 await account('202','Ahorro Dos','asset','7000037');
 await account('202','Deuda Dos','liability','300041');
 await account('202','Sin verificar Dos','asset','0',false);
 const e=await f.event('101'),p=await f.rpc('pro:act',{id:e.id,action:{command:'stage',proposal:{command:'pocket',account:'Ahorro Uno',name:'Reserva',amount:'50027',date:'2026-09-01'}}});
 await f.rpc('pro:act',{id:(await f.event('101')).id,action:{command:'confirm',target:p.proposal_id}});
 // Familiar expenditure is still counted in its owner's account, regardless of payer.
 await f.rpc('agent:apply',{id:(await f.event('101')).id,action:{type:'post',kind:'expense',account:'Ahorro Uno',amount:'103',payer:'202',scope:'family',date:day,category:'Compras',memo:'Compra familiar'}});
 await f.enable();
});after(async()=>{await f?.db.close();});

test('Mine limits accounts, pocket groups and exact totals by trusted event owner',async()=>{
 const r=await overview('101');
 assert.ok(r.accounts.every((a:any)=>a.owner==='101'));
 assert.equal(r.cash_cents,'1049937');assert.equal(r.debt_cents,'200019');assert.equal(r.receivable_cents,'40023');
 assert.equal(r.net_cash_cents,'849918');assert.equal(r.net_position_cents,'889941');
 assert.equal(r.pocket_groups[0].total,'1049937');assert.equal(r.pocket_groups[0].pockets[0].balance,'50027');
 assert.deepEqual(r.unverified_accounts,[]);assert.equal(r.balances_complete,true);
});
test('The other member gets only their own balances and unverified accounts',async()=>{
 const r=await overview('202');assert.ok(r.accounts.every((a:any)=>a.owner==='202'));
 assert.equal(r.cash_cents,'7000037');assert.equal(r.debt_cents,'300041');assert.equal(r.net_cash_cents,'6699996');
 assert.deepEqual(r.pocket_groups,[]);assert.deepEqual(r.unverified_accounts,['Sin verificar Dos']);assert.equal(r.balances_complete,false);
});
test('Explicit global and legacy overview still include both owners without double counting pockets',async()=>{
 const r=await overview('101','all');assert.equal(r.cash_cents,'8049974');assert.equal(r.debt_cents,'500060');assert.equal(r.net_cash_cents,'7549914');
 assert.deepEqual([...new Set(r.accounts.map((a:any)=>a.owner))].sort(),['101','202']);
 const legacy=await f.rpc('family:overview',{id:(await f.event('101')).id,as_of:day});assert.equal(legacy.cash_cents,r.cash_cents);
});
test('Owner filter applies before historical sums and changing it never saves a review or writes money',async()=>{
 const before=await f.snapshotLedger(),reviews=await f.db.query('select * from private.monthly_reviews');
 const r=await overview('101','mine','2026-09-30');assert.equal(r.cash_cents,'1050040');
 await overview('101','all');const mine=await overview('101');assert.ok(mine.accounts.every((a:any)=>a.owner==='101'));
 assert.deepEqual(await f.snapshotLedger(),before);assert.deepEqual(await f.db.query('select * from private.monthly_reviews'),reviews);
});
test('Mine rejects unsupported scopes and ignores an injected actor when deriving ownership',async()=>{
 await assert.rejects(overview('101','bogus'));
 const r=await overview('101','mine',day,{actor:'202',owner:'202'});assert.ok(r.accounts.every((a:any)=>a.owner==='101'));
 await assert.rejects(f.rpc('family:overview',{id:99999999,as_of:day,account_scope:'mine'}));
});
test('Own-account tool returns formatted SQL totals and cannot accept another owner',async()=>{
 const e=await f.event('101'),context={actor:'101',event_id:e.id,members:[],accounts:[]};
 const r=await dispatchTool('consultar_mis_cuentas',{as_of:day},context,f.rpc);
 assert.equal(r.result.totals_cop.cash,'$10.499,37 COP');assert.equal(r.result.totals_cop.net_cash,'$8.499,18 COP');assert.ok(r.result.accounts.every((a:any)=>a.owner==='101'));assert.equal(r.result.cash_cents,undefined);
 await assert.rejects(dispatchTool('consultar_mis_cuentas',{as_of:day,owner:'202'},context,f.rpc));
});
test('An owner without accounts receives an empty overview instead of falling back to the household',async()=>{
 const empty=await workerDatabase();try{const e=await empty.ingest({});const r=await empty.rpc('family:overview',{id:e.id,as_of:day,account_scope:'mine'});assert.deepEqual(r.accounts,[]);assert.deepEqual(r.pocket_groups,[]);assert.deepEqual(r.unverified_accounts,[]);
 assert.equal(r.cash_cents,'0');assert.equal(r.debt_cents,'0');assert.equal(r.net_cash_cents,'0');assert.equal(r.balances_complete,true);
 }finally{await empty.db.close();}
});
test('An account without an exclusive owner appears globally but is not silently assigned to the reporter',async()=>{
 await f.enable(false);await account('101','Compartida prueba','asset','799');
 await f.db.exec("update private.accounts set owner=null,management_mode='shared' where name='Compartida prueba'");await f.enable();
 assert.ok(!(await overview('101')).accounts.some((a:any)=>a.name==='Compartida prueba'));
 assert.ok((await overview('101','all')).accounts.some((a:any)=>a.name==='Compartida prueba'));
});
test('A specifically named account keeps the existing shared statement read without a household overview',async()=>{
 const e=await f.event('101');const r=await dispatchTool('consultar_cuenta',{account:'Ahorro Dos',as_of:day},{actor:'101',event_id:e.id,members:[],accounts:[]},f.rpc);
 assert.equal(r.result.account,'Ahorro Dos');assert.equal(r.result.balance_cop,'$70.000,37 COP');assert.equal(r.action,undefined);
});
