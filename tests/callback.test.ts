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
const ui=async(data:any)=>(await db.query<{r:any}>('select public.finance_ui($1,$2::jsonb) r',['ingest',JSON.stringify(data)])).rows[0].r;
test('Burst of confirmations enqueues once and confirm/cancel share a lock',async()=>{
 const proposal=await pro('act',{id:await event(),action:{command:'stage',proposal:{command:'summary',enabled:true}}});
 const input=(id:number,callback:string)=>({update_id:id,actor:'101',name:'101',group:'-100123',payload:{callback,callbackId:String(id),messageId:99}});
 const results=await Promise.all(Array.from({length:8},(_,i)=>ui(input(20000+i,'pconfirm:'+proposal.proposal_id))));
 assert.equal(results.filter(x=>x.accepted).length,1);
 assert.equal((await db.query<any>('select count(*)::int n from private.events where id between 20000 and 20007')).rows[0].n,1);
 assert.equal((await ui(input(20008,'pcancel:'+proposal.proposal_id))).accepted,false);
 await pro('act',{id:20000,action:{command:'confirm',target:String(proposal.proposal_id)}});
 const late=await ui(input(20009,'pconfirm:'+proposal.proposal_id));assert.equal(late.accepted,false);assert.equal(late.state,'resolved');
});
test('Another person cannot reserve or remove the owner confirmation',async()=>{
 const proposal=await pro('act',{id:await event(),action:{command:'stage',proposal:{command:'summary',enabled:false}}});
 const denied=await ui({update_id:20100,actor:'202',name:'202',group:'-100123',payload:{callback:'pconfirm:'+proposal.proposal_id}});
 assert.equal(denied.accepted,false);assert.equal(denied.remove_buttons,false);
 const allowed=await ui({update_id:20101,actor:'101',name:'101',group:'-100123',payload:{callback:'pconfirm:'+proposal.proposal_id}});assert.equal(allowed.accepted,true);
});
test('Failed event permits explicit retry while ordinary webhook duplicates stay suppressed',async()=>{
 const proposal=await pro('act',{id:await event(),action:{command:'stage',proposal:{command:'summary',enabled:false}}});
 const data={update_id:20200,actor:'101',name:'101',group:'-100123',payload:{callback:'pconfirm:'+proposal.proposal_id}};
 assert.equal((await ui(data)).accepted,true);assert.equal((await ui(data)).accepted,false);
 await db.exec("update private.events set state='failed' where id=20200");
 assert.equal((await ui({...data,update_id:20201})).accepted,true);
});
test('Duplicate-expense confirmation is also coalesced before enqueueing',async()=>{
 const a={type:'post',kind:'expense',amount:'12300',account:'Banco',payer:'101',scope:'family',date:'2026-09-28',category:'Comida',memo:'duplicado controlado'};
 await core('apply',{id:await event(),action:a});const target=await event();assert.equal((await core('apply',{id:target,action:a})).status,'duplicate');
 const data={update_id:20300,actor:'101',name:'101',group:'-100123',payload:{callback:'confirm:'+target}};
 assert.equal((await ui(data)).accepted,true);assert.equal((await ui({...data,update_id:20301})).accepted,false);
 await core('apply',{id:20300,action:{...a,confirm_duplicate:true,pending_event_id:String(target)}});
 assert.equal((await ui({...data,update_id:20302})).state,'resolved');
});
for(const [i,callback] of ['detail:1','undo:1','edit:1:amount','edit:1:account','reconcile:1','match:1:2'].entries()){
 test('All button actions coalesce while running: '+callback,async()=>{
  const data={update_id:20500+i*10,actor:'101',name:'101',group:'-100123',payload:{callback,messageId:300+i}};
  assert.equal((await ui(data)).accepted,true);
  assert.equal((await ui({...data,update_id:data.update_id+1})).accepted,false);
  assert.equal((await ui({...data,update_id:data.update_id+2})).remove_buttons,false);
 });
}
test('Read buttons become reusable after delivery and brief cooldown, not before',async()=>{
 const data={update_id:20700,actor:'101',name:'101',group:'-100123',payload:{callback:'detail:10',messageId:500}};
 await ui(data);await core('apply',{id:20700,action:{type:'clarify',question:'Detalle de prueba'}});
 assert.equal((await ui({...data,update_id:20701})).accepted,false);
 await db.exec("update private.outbox set sent_at=now()-interval '4 seconds' where event_id=20700");
 assert.equal((await ui({...data,update_id:20702})).accepted,true);
});
test('An undo button cannot generate more proposals while its previous one awaits confirmation',async()=>{
 const data={update_id:20800,actor:'101',name:'101',group:'-100123',payload:{callback:'undo:1',messageId:501}};
 await ui(data);const p=await pro('act',{id:20800,action:{command:'stage',proposal:{command:'undo',target:'1'}}});
 await core('apply',{id:20800,action:{type:'pro',command:'stage',proposal:{command:'undo',target:'1'}}});
 await db.exec("update private.outbox set sent_at=now()-interval '4 seconds' where event_id=20800");
 assert.equal((await ui({...data,update_id:20801})).accepted,false);
});
