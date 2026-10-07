import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {vector} from '@electric-sql/pglite-pgvector';
import {readFileSync,readdirSync} from 'node:fs';
import {dispatchTool} from '../supabase/functions/_shared/agent-tools.ts';
const db=new PGlite({extensions:{vector}});
const rpc=async(fn:string,op:string,data:any)=>(await db.query<{r:any}>('select public.'+fn+'($1,$2::jsonb) r',[op,JSON.stringify(data)])).rows[0].r;
let seq=50000;
async function event(actor='101'){const id=seq++;await rpc('finance_api','ingest',{update_id:id,actor,name:actor,group:'-100123',payload:{}});return id;}
const search=async(data:any={})=>rpc('finance_movement_search','search',{id:await event(),...data});
const statement=async(data:any={})=>rpc('finance_account_statement','statement',{id:await event(),account:'Banco Alfa',as_of:'2026-10-01',...data});
async function transfer(amount:string,account='Banco Beta',other='Banco Alfa',memo='Transferencia propia',date='2026-09-30'){
 return rpc('finance_api','apply',{id:await event('202'),action:{type:'post',kind:'transfer',amount,account,other,payer:'202',date,scope:'personal',memo}});
}
before(async()=>{
 await db.exec('create role anon;create role authenticated;create role service_role bypassrls;create schema vault;create table vault.decrypted_secrets(name text,decrypted_secret text);grant usage on schema vault to service_role;grant select on vault.decrypted_secrets to service_role;');
 for(const f of readdirSync('supabase/migrations').filter(f=>!f.endsWith('_worker_schedule.sql')).sort())await db.exec(readFileSync('supabase/migrations/'+f,'utf8'));
 await rpc('finance_api','init',{group:'-100123'});await event('202');
 for(const a of [{name:'Banco Alfa',kind:'asset',owner:'101'},{name:'Banco Beta',kind:'asset',owner:'202'}])await rpc('finance_api','apply',{id:await event(a.owner),action:{type:'account',date:'2026-09-01',amount:'100000000',...a}});
 await transfer('19000000');await transfer('19000019');await transfer('19000000','Banco Alfa','Banco Beta');
 for(let i=0;i<35;i++)await transfer(String(10000+i), 'Banco Beta','Banco Alfa','Otros movimientos '+i);
});
after(()=>db.close());
test('Account statement includes openings and exact totals independent of its bounded display',async()=>{
 const r=await statement();
 const expected=(await db.query<{balance:string}>("select sum(e.delta)::text balance from private.entries e join private.accounts a on a.id=e.account_id where a.name='Banco Alfa'")).rows[0].balance;
 assert.equal(r.balance_cents,expected);
 assert.equal(BigInt(r.opening_cents)+BigInt(r.credits_cents)-BigInt(r.debits_cents),BigInt(expected));
 assert.equal(r.opening_cents,'100000000');assert.equal(r.complete,false);assert.equal(r.movements.length,30);
 const next=await statement({offset:r.next_offset});assert.equal(next.complete,true);assert.ok(next.movements.some((m:any)=>m.kind==='opening'));
 assert.equal(next.balance_cents,r.balance_cents);
 assert.ok(r.movements.every((m:any)=>typeof m.delta_cop==='string'));
});
test('Account statement reads either owner without changing money and blocks public roles',async()=>{
 const before=(await db.query('select count(*)::int n from private.transactions')).rows;
 const r=await statement({account:'Banco Beta'});assert.equal(r.account,'Banco Beta');assert.equal(r.owner_name,'202');
 assert.deepEqual((await db.query('select count(*)::int n from private.transactions')).rows,before);
 await assert.rejects(statement({account:'Missing'}),/account unavailable/);
 await assert.rejects(rpc('finance_account_statement','statement',{id:999999,account:'Banco Alfa',as_of:'2026-10-01'}),/unknown event/);
 await db.exec('set role anon');try{await assert.rejects(db.query("select public.finance_account_statement('statement','{}')"),/permission denied/);}finally{await db.exec('reset role');}
});
test('Account statement retains reversal lines and balances their exact effect',async()=>{
 const tx=await transfer('30019');const before=await statement();
 await rpc('finance_api','apply',{id:await event('202'),action:{type:'reverse',target:tx.transaction_id,reason:'corrección ficticia'}});
 const after=await statement();assert.equal(BigInt(before.balance_cents)-BigInt(after.balance_cents),30019n);
 const pages=[...after.movements,...(await statement({offset:30})).movements];
 assert.ok(pages.some((m:any)=>m.id===String(tx.transaction_id)&&m.reversed_by));
 assert.ok(pages.some((m:any)=>m.reverses===String(tx.transaction_id)));
});
test('Account tool formats the statement with SQL totals instead of summing its page',async()=>{
 const id=await event();const context={event_id:id,actor:'101',members:[{id:'101',name:'Ana'}],accounts:[{name:'Banco Alfa',kind:'asset',owner:'101'}]};
 const r=await dispatchTool('consultar_cuenta',{account:'Banco Alfa',as_of:'2026-10-01'},context,async(op,data)=>{assert.equal(op,'agent:statement');return rpc('finance_account_statement','statement',data);});
 assert.equal(r.action,undefined);assert.match(r.result.balance_cop,/COP/);assert.equal(r.result.complete,false);
 assert.ok(r.result.movements.some((m:any)=>m.delta_cop.startsWith('-')));
 await assert.rejects(dispatchTool('consultar_cuenta',{account:'Banco Alfa',as_of:'2026-10-01',actor:'202'},context,async()=>null));
});
test('Failed requests do not accuse a read-only question of invalid financial data',async()=>{
 const id=await event();await db.query("update private.events set state='working',attempts=3 where id=$1",[id]);
 await rpc('finance_api','fail',{id});
 const r=(await db.query<{message:string}>('select message from private.outbox where event_id=$1',[id])).rows[0];
 assert.match(r.message,/solicitud/);assert.doesNotMatch(r.message,/registrar|revisar el dato|#[0-9]/);
});
test('A historical date before opening cannot claim a verified zero balance',async()=>{
 const r=await statement({as_of:'2026-08-31'});assert.equal(r.balance_known,false);assert.equal(r.balance_cents,'0');
});
test('Card statements show positive debt while retaining signed ledger entries for audit',async()=>{
 await rpc('finance_api','apply',{id:await event(),action:{type:'account',name:'Tarjeta Alfa',kind:'liability',owner:'101',date:'2026-09-01',amount:'100019'}});
 await rpc('finance_api','apply',{id:await event(),action:{type:'post',kind:'expense',account:'Tarjeta Alfa',amount:'20003',payer:'101',date:'2026-09-30',category:'Compra',memo:'Compra ficticia',scope:'personal'}});
 await rpc('finance_api','apply',{id:await event(),action:{type:'post',kind:'transfer',account:'Banco Alfa',other:'Tarjeta Alfa',amount:'30004',payer:'101',date:'2026-09-30',memo:'Pago ficticio',scope:'personal'}});
 const r=await statement({account:'Tarjeta Alfa'});
 assert.equal(r.balance_cents,'90018');assert.equal(r.ledger_balance_cents,'-90018');
 assert.equal(r.opening_cents,'100019');assert.equal(r.credits_cents,'20003');assert.equal(r.debits_cents,'30004');
 assert.ok(r.movements.some((m:any)=>m.kind==='expense'&&m.delta_cents==='-20003'&&m.effect_cents==='20003'));
});
test('Pocket balances stay separate and verification respects their opening date',async()=>{
 const p=await rpc('finance_pro','act',{id:await event(),action:{command:'stage',proposal:{command:'pocket',account:'Banco Alfa',name:'Reserva',amount:'140034',date:'2026-09-28'}}});
 await rpc('finance_pro','act',{id:await event(),action:{command:'confirm',target:p.proposal_id}});
 const r=await statement();assert.equal(r.pockets_total_cents,'140034');assert.equal(r.pockets_complete,true);
 assert.equal(BigInt(r.total_with_pockets_cents),BigInt(r.balance_cents)+140034n);
 assert.equal(r.pockets[0].balance_known,true);
 const earlier=await statement({as_of:'2026-09-27'});assert.equal(earlier.pockets_total_cents,'0');assert.equal(earlier.pockets_complete,false);assert.equal(earlier.pockets[0].balance_known,false);
});
test('Exact existence search finds an older transfer across owners without a date',async()=>{
 const r=await search({kind:'transfer',amount_cop:'190000',from_account:'Banco Beta',to_account:'Banco Alfa'});
 assert.equal(r.total_matches,1);assert.equal(r.exists,true);assert.equal(r.complete,true);
 assert.equal(r.movements[0].amount_cop,'190000.00');assert.equal(r.movements[0].from_account,'Banco Beta');assert.equal(r.movements[0].to_account,'Banco Alfa');
 const cents=await search({kind:'transfer',amount_cop:'190000.19',from_account:'Banco Beta',to_account:'Banco Alfa'});assert.equal(cents.total_matches,1);
});
test('Absence is exhaustive and unrelated or reversed transfers cannot match',async()=>{
 const r=await search({kind:'transfer',amount_cop:'190001',from_account:'Banco Beta',to_account:'Banco Alfa'});
 assert.equal(r.exists,false);assert.equal(r.total_matches,0);assert.equal(r.complete,true);assert.deepEqual(r.movements,[]);
 const known=await search({amount_cop:'190000',from_account:'Banco Beta',to_account:'Banco Alfa'});
 await rpc('finance_api','apply',{id:await event('202'),action:{type:'reverse',target:known.movements[0].id,reason:'prueba'}});
 assert.equal((await search({amount_cop:'190000',from_account:'Banco Beta',to_account:'Banco Alfa'})).exists,false);
});
test('Search reports its full count when displayed results are limited',async()=>{
 const r=await search({query:'Otros movimientos',account:'Banco Beta'});assert.equal(r.total_matches,35);assert.equal(r.movements.length,30);assert.equal(r.complete,false);assert.equal(r.exists,true);
});
test('Unknown accounts and invalid intervals are errors rather than false absence',async()=>{
 await assert.rejects(search({from_account:'BVA'}),/account unavailable/);
 await assert.rejects(search({from:'2026-10-01',to:'2026-09-01'}),/date interval/);
 await assert.rejects(rpc('finance_movement_search','search',{id:999999}),/unknown event/);
 await db.exec('set role anon');try{await assert.rejects(db.query("select public.finance_movement_search('search','{}')"),/permission denied/);}finally{await db.exec('reset role');}
});
test('Natural existence tool passes exact filters and leaves money untouched',async()=>{
 const snapshot=async()=>(await db.query('select transaction_id,account_id,delta::text from private.entries order by transaction_id,account_id')).rows;
 const before=await snapshot();const context={event_id:await event(),actor:'101',members:[{id:'101',name:'Alex'},{id:'202',name:'Sam'}],accounts:[{name:'Banco Beta',kind:'asset',owner:'202'},{name:'Banco Alfa',kind:'asset',owner:'101'}]};
 const out=await dispatchTool('buscar_movimientos',{kind:'transfer',amount_cop:'190000.19',from_account:'Banco Beta',to_account:'Banco Alfa'},context,async(op,data)=>{assert.equal(op,'agent:search');return rpc('finance_movement_search','search',data);});
 assert.equal(out.result.total_matches,1);assert.equal(out.action,undefined);assert.deepEqual(await snapshot(),before);
});
