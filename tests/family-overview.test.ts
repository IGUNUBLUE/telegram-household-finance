import {test,before,after} from 'node:test';import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';import {vector} from '@electric-sql/pglite-pgvector';
import {readFileSync,readdirSync} from 'node:fs';
import {dispatchTool} from '../supabase/functions/_shared/agent-tools.ts';
const db=new PGlite({extensions:{vector}});
const rpc=async(fn:string,op:string,data:any={})=>(await db.query<{r:any}>('select public.'+fn+'($1,$2::jsonb) r',[op,JSON.stringify(data)])).rows[0].r;
const core=(op:string,data:any={})=>rpc('finance_api',op,data);
const family=(op:string,data:any={})=>rpc('finance_family',op,data);
const routine=(op:string,data:any={})=>rpc('finance_routines',op,data);
let seq=30000;
async function event(actor='101'){const id=seq++;await core('ingest',{update_id:id,actor,name:actor,group:'-100123',payload:{}});return id;}
const state=async()=> (await db.query<any>("select jsonb_build_object('reviews',(select coalesce(jsonb_agg(to_jsonb(r) order by actor,month),'[]') from private.monthly_reviews r),'transactions',(select count(*) from private.transactions),'entries',(select count(*) from private.entries)) r")).rows[0].r;
before(async()=>{await db.exec('create role anon;create role authenticated;create role service_role bypassrls;create schema vault;create table vault.decrypted_secrets(name text,decrypted_secret text);grant usage on schema vault to service_role;grant select on vault.decrypted_secrets to service_role;');for(const f of readdirSync('supabase/migrations').filter(f=>!f.endsWith('_worker_schedule.sql')).sort())await db.exec(readFileSync('supabase/migrations/'+f,'utf8'));await core('init',{group:'-100123'});await event('202');
 for(const a of [{name:'Banco Alfa',kind:'asset',owner:'101',amount:'10000013'},{name:'Tarjeta Alfa',kind:'liability',owner:'101',amount:'3000019'},{name:'Banco Beta',kind:'asset',owner:'202',amount:'20000025'}])await core('apply',{id:await event(a.owner),action:{type:'account',date:'2026-09-01',...a}});
 const preview=await rpc('finance_pro','act',{id:await event(),action:{command:'stage',proposal:{command:'pocket',account:'Banco Alfa',name:'Regalos',amount:'4001',date:'2026-09-01'}}});await rpc('finance_pro','act',{id:await event(),action:{command:'confirm',target:preview.proposal_id}});
});after(()=>db.close());

test('Global balance is exact, counts pockets once and does not start a monthly review',async()=>{
 const before=await state();const r=await family('overview',{id:await event(),as_of:'2026-09-30'});
 assert.equal(r.cash_cents,'30004039');assert.equal(r.debt_cents,'3000019');assert.equal(r.net_cash_cents,'27004020');assert.equal(r.balances_complete,true);
 const group=r.pocket_groups.find((g:any)=>g.account==='Banco Alfa');assert.equal(group.total,'10004014');assert.equal(group.available,'10000013');
 assert.deepEqual(await state(),before);
 await core('apply',{id:await event(),action:{type:'post',kind:'transfer',account:'Banco Alfa',other:'Banco Alfa · Regalos',amount:'2012',payer:'101',scope:'personal',date:'2026-09-30',memo:'Bolsillo'}});
 assert.equal((await family('overview',{id:await event(),as_of:'2026-09-30'})).cash_cents,'30004039');
});

test('Family status is a read-only view of optional individual reviews',async()=>{
 const before=await state();const r=await family('review_status',{id:await event(),month:'2026-09-01'});
 assert.equal(r.state,'not_started');assert.ok(r.members.every((m:any)=>m.state==='not_started'));
 assert.deepEqual(await state(),before);
 const mine=await routine('review',{id:await event(),month:'2026-09-01'});assert.equal(mine.accounts.length,3);
 const started=await family('review_status',{id:await event('202'),month:'2026-09-01'});assert.equal(started.state,'in_progress');
 assert.equal(started.members.find((m:any)=>m.actor==='202').state,'not_started');
});
async function finish(actor:string,accept_pending=false){const month='2026-09-01';const r=await routine('review',{id:await event(actor),month});for(const a of r.accounts){const n=BigInt(a.balance),abs=n<0n?-n:n;const balance_cop=(n<0n?'-':'')+(abs/100n)+'.'+(abs%100n).toString().padStart(2,'0');await routine('check',{id:await event(actor),month,account:a.name,balance_cop});}return rpc('finance_agent','apply',{id:await event(actor),action:{type:'routine',command:'close_finish',month,accept_pending}});}
test('Family status combines completion without saving the other persons review',async()=>{
 await finish('101');let r=await family('review_status',{id:await event(),month:'2026-09-01'});assert.equal(r.state,'partial');
 assert.equal(r.members.find((m:any)=>m.actor==='202').state,'not_started');
 await finish('202');r=await family('review_status',{id:await event(),month:'2026-09-01'});assert.equal(r.state,'reviewed');
 const before=await state();assert.equal((await family('review_status',{id:await event('202'),month:'2026-09-01'})).state,'reviewed');assert.deepEqual(await state(),before);
});
test('Accepted pending work stays visible and later changes invalidate the saved family state',async()=>{
 await rpc('finance_agent','draft_save',{id:await event('202'),fields:{kind:'expense',date:'2026-09-30',memo:'Private unresolved detail'}});
 assert.equal((await family('review_status',{id:await event(),month:'2026-09-01'})).state,'needs_update');
 await finish('202',true);const pending=await family('review_status',{id:await event(),month:'2026-09-01'});assert.equal(pending.state,'reviewed_with_pending');
 assert.ok(!JSON.stringify(pending).includes('Private unresolved detail'));
 await core('apply',{id:await event('202'),action:{type:'post',kind:'expense',account:'Banco Beta',amount:'101',payer:'202',scope:'family',date:'2026-09-30',category:'Servicios',memo:'Late entry'}});
 assert.equal((await family('review_status',{id:await event(),month:'2026-09-01'})).state,'needs_update');
});
test('Unknown initial balances and historical cutoffs remain explicit',async()=>{
 const p=await rpc('finance_pro','act',{id:await event(),action:{command:'stage',proposal:{command:'account',name:'Unknown',kind:'asset',owner:'101',amount:'0',balance_known:false,date:'2026-10-01'}}});await rpc('finance_pro','act',{id:await event(),action:{command:'confirm',target:p.proposal_id}});
 assert.equal((await family('overview',{id:await event(),as_of:'2026-09-30'})).balances_complete,true);
 const current=await family('overview',{id:await event(),as_of:'2026-10-01'});assert.equal(current.balances_complete,false);assert.ok(current.unverified_accounts.includes('Unknown'));
 assert.equal((await family('overview',{id:await event(),as_of:'2026-09-01'})).cash_cents,'30004039');
});
test('Out-of-period pocket activity does not invalidate saved month-end reviews',async()=>{
 await finish('101',true);await finish('202',true);
 const id=await event();const before=await family('review_status',{id,month:'2026-09-01'});
 assert.ok(['reviewed','reviewed_with_pending'].includes(before.state));
 // Old saved reviews included current pocket groups. Keep their original
 // snapshots intact while comparing only the month-end accounting fields.
 await db.exec("update private.monthly_reviews set snapshot=jsonb_set(snapshot,'{report,pocket_groups}',public.finance_api('report','{\"from\":\"2026-09-01\",\"to\":\"2026-09-30\",\"scope\":\"all\"}') -> 'pocket_groups') where month='2026-09-01'; update private.monthly_reviews set snapshot=jsonb_set(snapshot,'{fingerprint}',to_jsonb(md5(jsonb_build_object('report',snapshot->'report','accounts',snapshot->'accounts','budgets',snapshot->'budgets','pending',snapshot->'pending')::text))) where month='2026-09-01';");
 assert.deepEqual(await family('review_status',{id,month:'2026-09-01'}),before);
 const balanceBefore=await family('overview',{id,as_of:'2026-09-30'});
 await core('apply',{id:await event(),action:{type:'post',kind:'expense',account:'Banco Alfa',amount:'123',payer:'101',scope:'personal',beneficiary:'101',date:'2026-10-01',category:'Comida',memo:'October only'}});
 assert.deepEqual(await family('review_status',{id:await event(),month:'2026-09-01'}),before);
 assert.equal((await family('overview',{id:await event(),as_of:'2026-09-30'})).cash_cents,balanceBefore.cash_cents);
});
test('Natural query tools bind the trusted actor and reject any write operation',async()=>{
 const context={...(await core('context')),actor:'101',event_id:await event()};
 const result=await dispatchTool('consultar_panorama_familiar',{as_of:'2026-10-01'},context,async(op,data)=>family(op.split(':')[1],data));assert.equal(result.action,undefined);assert.equal(result.result.source,'ledger');
 await assert.rejects(dispatchTool('consultar_panorama_familiar',{as_of:'2026-10-01',actor:'202'},context,async()=>null));
 await assert.rejects(family('finish',{id:context.event_id,month:'2026-09-01'}));
 await assert.rejects(family('review_status',{id:context.event_id,month:'2099-01-01'}));
 await db.exec('set role service_role');try{assert.equal((await family('overview',{id:context.event_id,as_of:'2026-10-01'})).source,'ledger');}finally{await db.exec('reset role');}
 for(const role of ['anon','authenticated'])assert.equal((await db.query<any>("select has_function_privilege($1,'public.finance_family(text,jsonb)','execute') p",[role])).rows[0].p,false);
});
test('The model receives exact displayed pesos, never raw overview cents to convert',async()=>{
 const result=await dispatchTool('consultar_panorama_familiar',{as_of:'2026-10-01'},{actor:'101',event_id:1,members:[],accounts:[]},async()=>({source:'ledger',as_of:'2026-10-01',cash_cents:'30004039',debt_cents:'3000019',receivable_cents:'0',net_cash_cents:'27004020',net_position_cents:'27004020',balances_complete:true,unverified_accounts:[],accounts:[{name:'Banco Alfa',balance:'-19'}],pocket_groups:[{account:'Banco Alfa',available:'10000013',pockets_total:'4001',total:'10004014',pockets:[{name:'Regalos',balance:'4001'}]}]}));
 assert.equal(result.result.totals_cop.cash,'$300.040,39 COP');assert.equal(result.result.totals_cop.debt,'$30.000,19 COP');
 assert.equal(result.result.accounts[0].balance_cop,'-$0,19 COP');assert.equal(result.result.pocket_groups[0].total_cop,'$100.040,14 COP');
 assert.equal(result.result.pocket_groups[0].pockets[0].balance_cop,'$40,01 COP');assert.equal(result.result.cash_cents,undefined);
});
