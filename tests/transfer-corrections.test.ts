import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {vector} from '@electric-sql/pglite-pgvector';
import {readFileSync,readdirSync} from 'node:fs';
import {dispatchTool} from '../supabase/functions/_shared/agent-tools.ts';
const db=new PGlite({extensions:{vector}});
const rpc=async(fn:string,op:string,data:any)=>(await db.query<{r:any}>('select public.'+fn+'($1,$2::jsonb) r',[op,JSON.stringify(data)])).rows[0].r;
let seq=70000;
async function event(actor='101'){const id=seq++;await rpc('finance_api','ingest',{update_id:id,actor,name:actor,group:'-100123',payload:{}});return id;}
const stage=async(proposal:any,actor='101')=>rpc('finance_pro','act',{id:await event(actor),action:{command:'stage',proposal}});
const confirm=async(target:any,actor='101',id?:number)=>rpc('finance_pro','act',{id:id??await event(actor),action:{command:'confirm',target}});
let transferAmount=190000;
async function wrongTransfer(){
 const id=await event();const {draft}=await rpc('finance_agent','draft_save',{id,fields:{kind:'transfer',amount_cop:String(transferAmount++)+'.19',account:'Banco Alfa',other:'Banco Beta',payer:'202',date:'2026-10-01',scope:'family',memo:'Transferencia ficticia '+id}});
 const ctx={event_id:id,actor:'101',members:[{id:'101',name:'Ana'},{id:'202',name:'Luis'}],accounts:[{name:'Banco Alfa',kind:'asset',owner:'101'},{name:'Banco Beta',kind:'asset',owner:'202'}]};
 const {action}=await dispatchTool('registrar_movimiento',{draft_id:draft.id,revision:draft.revision},ctx,async(op,data)=>rpc('finance_agent',op.split(':')[1],data));
 const result=await rpc('finance_agent','apply',{id,action});assert.equal(result.status,'ok');return result;
}
const counts=async()=>(await db.query<{n:number}>('select count(*)::int n from private.transactions')).rows[0].n;
before(async()=>{
 await db.exec('create role anon;create role authenticated;create role service_role bypassrls;create schema vault;create table vault.decrypted_secrets(name text,decrypted_secret text);grant usage on schema vault to service_role;grant select on vault.decrypted_secrets to service_role;');
 for(const f of readdirSync('supabase/migrations').filter(f=>!f.endsWith('_worker_schedule.sql')).sort())await db.exec(readFileSync('supabase/migrations/'+f,'utf8'));
 await rpc('finance_api','init',{group:'-100123'});await event('202');
 for(const a of [{name:'Banco Alfa',kind:'asset',owner:'101'},{name:'Banco Beta',kind:'asset',owner:'202'}])await rpc('finance_api','apply',{id:await event(a.owner),action:{type:'account',date:'2026-09-01',amount:'100000000',...a}});
});
after(()=>db.close());
test('A confirmed legacy origin correction reverses both endpoints atomically',async()=>{
 const old=await wrongTransfer();const p=await stage({command:'correct',target:String(old.transaction_id),field:'account',value:'Banco Beta'});
 assert.deepEqual(p.proposal.value,{account:'Banco Beta',other:'Banco Alfa'});
 // Simulate a pending proposal produced by the previous deployment.
 await db.query('update private.proposals set action=$1::jsonb where id=$2',[JSON.stringify({command:'correct',target:String(old.transaction_id),field:'account',value:'Banco Beta'}),p.proposal_id]);
 const id=await event();await db.query("update private.events set state='failed',attempts=3,action=$1::jsonb where id=$2",[JSON.stringify({type:'pro',command:'confirm',target:String(p.proposal_id)}),id]);
 await db.query("insert into private.outbox(event_id,message,result,sent_at) values($1,'Error previo','{\"status\":\"failed\"}'::jsonb,now())",[id]);
 const before=await counts();const r=await confirm(p.proposal_id,'101',id);
 await db.query("update private.events set state='done',result=$1::jsonb where id=$2",[JSON.stringify(r),id]);
 assert.equal((await db.query<{result:any}>('select result from private.outbox where event_id=$1',[id])).rows[0].result.status,'failed');
 assert.equal(r.status,'ok');assert.equal(await counts(),before+2);
 const row=(await db.query<{action:any}>('select e.action from private.transactions t join private.events e on e.id=t.event_id where t.id=$1',[r.transaction_id])).rows[0].action;
 assert.equal(row.account,'Banco Beta');assert.equal(row.other,'Banco Alfa');assert.equal(row.amount,'19000019');assert.equal(row.payer,'202');assert.equal(row.date,'2026-10-01');
 assert.equal(row._draft_id,undefined);assert.equal(row._draft_revision,undefined);
 const entries=(await db.query<{name:string;delta:string}>('select a.name,e.delta::text from private.entries e join private.accounts a on a.id=e.account_id where e.transaction_id=$1 order by a.name',[r.transaction_id])).rows;
 assert.deepEqual(entries,[{name:'Banco Alfa',delta:'19000019'},{name:'Banco Beta',delta:'-19000019'}]);
 assert.equal((await confirm(p.proposal_id,'101',id)).transaction_id,r.transaction_id);assert.equal(await counts(),before+2);
});
test('Explicit endpoint corrections require confirmation and preserve author ownership',async()=>{
 const old=await wrongTransfer();const before=await counts();
 const p=await stage({command:'correct',target:String(old.transaction_id),field:'accounts',value:{account:'Banco Beta',other:'Banco Alfa'}});
 assert.equal(await counts(),before);
 const unauthorized=await stage({command:'correct',target:String(old.transaction_id),field:'accounts',value:{account:'Banco Beta',other:'Banco Alfa'}},'202');assert.equal(unauthorized.status,'clarify');
 const denied=await confirm(p.proposal_id,'202');assert.equal(denied.status,'clarify');assert.equal(await counts(),before);
 const result=await confirm(p.proposal_id);assert.equal(result.status,'ok');assert.equal(await counts(),before+2);
});
test('Invalid endpoint corrections leave the original and proposal unconsumed',async()=>{
 const old=await wrongTransfer();const before=await counts();
 const p=await stage({command:'correct',target:String(old.transaction_id),field:'accounts',value:{account:'Banco Alfa',other:'Banco Alfa'}});
 assert.equal(p.status,'clarify');assert.equal(await counts(),before);
 const unknown=await stage({command:'correct',target:String(old.transaction_id),field:'accounts',value:{account:'Banco Beta',other:'Missing'}});assert.equal(unknown.status,'clarify');assert.equal(await counts(),before);
 const valid=await stage({command:'correct',target:String(old.transaction_id),field:'accounts',value:{account:'Banco Beta',other:'Banco Alfa',amount:'1',payer:'202'}});assert.deepEqual(valid.proposal.value,{account:'Banco Beta',other:'Banco Alfa'});
 await db.query("update private.proposals set action=jsonb_set(action,'{value,other}',$1::jsonb) where id=$2",[JSON.stringify('Missing'),valid.proposal_id]);
 const declined=await confirm(valid.proposal_id);assert.equal(declined.status,'clarify');assert.equal(await counts(),before);
 assert.equal((await db.query<{state:string}>('select state from private.proposals where id=$1',[valid.proposal_id])).rows[0].state,'pending');
});
