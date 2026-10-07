import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {vector} from '@electric-sql/pglite-pgvector';
import {readFileSync,readdirSync} from 'node:fs';
const db=new PGlite({extensions:{vector}});
const core=async(op:string,data:any={})=>(await db.query<{r:any}>('select public.finance_api($1,$2::jsonb) r',[op,JSON.stringify(data)])).rows[0].r;
const pro=async(op:string,data:any={})=>(await db.query<{r:any}>('select public.finance_pro($1,$2::jsonb) r',[op,JSON.stringify(data)])).rows[0].r;
let seq=10000;
async function event(actor='101',payload:any={}){const id=seq++;await core('ingest',{update_id:id,actor,name:actor,group:'-100123',payload});return id;}
before(async()=>{await db.exec('create role anon; create role authenticated; create role service_role bypassrls; create schema vault; create table vault.decrypted_secrets(name text, decrypted_secret text); grant usage on schema vault to service_role; grant select on vault.decrypted_secrets to service_role;');for(const f of readdirSync('supabase/migrations').filter(f=>!f.endsWith('_worker_schedule.sql')).sort())await db.exec(readFileSync('supabase/migrations/'+f,'utf8'));await core('init',{group:'-100123'});await event('202');const id=await event();await core('apply',{id,action:{type:'account',name:'Banco',kind:'asset',owner:'101',amount:'10000000',date:'2026-09-27'}});});
after(()=>db.close());

const snapshot=async()=> (await db.query<{r:any}>("select jsonb_build_object('transactions',(select count(*) from private.transactions),'entries',(select count(*) from private.entries),'proposals',(select count(*) from private.proposals),'balances',(select jsonb_agg(x order by x.account_id) from (select account_id,sum(delta)::text amount from private.entries group by account_id) x)) r")).rows[0].r;
async function expense(actor='101',payer='202'){
 return core('apply',{id:await event(actor),action:{type:'post',kind:'expense',account:'Banco',amount:String(10000+seq),date:'2026-09-28',category:'Servicios',scope:'family',payer,memo:'Author permission '+seq}});
}
test('Other member cannot stage or directly apply corrections or undo, even when payer',async()=>{
 const tx=await expense();const before=await snapshot();
 for(const action of [{command:'correct',target:tx.transaction_id,field:'amount',value:'99999'},{command:'correct',target:tx.transaction_id,field:'account',value:'Banco'},{command:'undo',target:tx.transaction_id}]){
  const staged=await pro('act',{id:await event('202'),action:{command:'stage',proposal:action}});assert.equal(staged.status,'clarify');assert.equal(staged.proposal_id,undefined);
  assert.equal((await pro('act',{id:await event('202'),action})).status,'clarify');
 }
 assert.deepEqual(await snapshot(),before);
 const detail=await pro('act',{id:await event('202'),action:{command:'detail',target:tx.transaction_id}});assert.equal(detail.transaction.id,tx.transaction_id);
});
test('Old pending proposal is rechecked when another member confirms it',async()=>{
 const tx=await expense();
 const p=(await db.query<{id:number}>("insert into private.proposals(actor,action) values('202',$1::jsonb) returning id",[JSON.stringify({command:'correct',target:tx.transaction_id,field:'amount',value:'1'})])).rows[0];
 const before=await snapshot();const id=await event('202');
 assert.equal((await pro('act',{id,action:{command:'confirm',target:p.id}})).status,'clarify');
 assert.deepEqual(await snapshot(),before);
});
test('Edit button mode and raw reversal cannot bypass the author permission',async()=>{
 const tx=await expense();const id=await event('202');await pro('conversation',{id,text:'Cambiar monto'});
 const denied=await pro('mode',{id,mode:{kind:'edit',target:String(tx.transaction_id),field:'amount'}});assert.equal(denied.status,'clarify');
 assert.deepEqual((await pro('conversation',{id,text:'Cambiar monto'})).mode,{});
 const before=await snapshot();await assert.rejects(core('apply',{id:await event('202'),action:{type:'reverse',target:String(tx.transaction_id),reason:'Bypass attempt'}}));assert.deepEqual(await snapshot(),before);
});
test('Author can correct amount then account and undo the replacement with audit history',async()=>{
 await core('apply',{id:await event('202'),action:{type:'account',name:'Otra',kind:'asset',owner:'202',amount:'0',date:'2026-09-27'}});
 const tx=await expense();
 async function confirm(action:any){const p=await pro('act',{id:await event(),action:{command:'stage',proposal:action}});assert.equal(p.status,'preview');const id=await event();const r=await pro('act',{id,action:{command:'confirm',target:p.proposal_id}});assert.equal(r.status,'ok');assert.deepEqual(await pro('act',{id,action:{command:'confirm',target:p.proposal_id}}),r);return r;}
 const amount=await confirm({command:'correct',target:tx.transaction_id,field:'amount',value:'25013'});
 const account=await confirm({command:'correct',target:amount.transaction_id,field:'account',value:'Otra'});
 assert.equal((await pro('act',{id:await event('202'),action:{command:'undo',target:account.transaction_id}})).status,'clarify');
 await confirm({command:'undo',target:account.transaction_id});
 const history=(await db.query<{actor:string}>("select actor from private.transactions where id=$1 or reverses=$1",[tx.transaction_id])).rows;assert.ok(history.every(t=>t.actor==='101'));
 assert.equal((await db.query<{n:number}>("select count(*)::int n from private.pro_audit where operation in ('correct','undo')")).rows[0].n,3);
});
