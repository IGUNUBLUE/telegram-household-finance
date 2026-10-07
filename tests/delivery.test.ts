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
const queue=async(op:string,data:any={})=>(await db.query<{r:any}>('select public.finance_queue($1,$2::jsonb) r',[op,JSON.stringify(data)])).rows[0].r;
test('Delivery failure releases only its lease, next item remains immediately available',async()=>{
 await db.exec("update private.outbox set sent_at=now();update private.events set state='done'");
 await core('apply',{id:await event(),action:{type:'clarify',question:'Uno'}});await core('apply',{id:await event(),action:{type:'clarify',question:'Dos'}});
 const first=await queue('outbox');assert.ok(first.id);
 await queue('failed',{id:first.id,token:first.token});
 const next=await queue('outbox');assert.ok(next.id);assert.notEqual(next.id,first.id);
 assert.equal((await queue('sent',{id:next.id,token:'wrong',telegram_message_id:99})).ok,false);
 assert.equal((await queue('sent',{id:next.id,token:next.token,telegram_message_id:99})).ok,true);
 assert.equal((await queue('outbox')).id,undefined);
});
test('Actor remains serialized after ledger commit until conversation finishes',async()=>{
 await db.exec("update private.events set state='done'");const a=await event();const b=await event();
 const claimed=await queue('claim');assert.equal(claimed.id,a);
 await core('apply',{id:a,action:{type:'clarify',question:'Primero'}});
 assert.equal((await queue('claim')).id,undefined);
 await queue('finish',{id:a,token:claimed.turn_token});assert.equal((await queue('claim')).id,b);
});
test('Checkpointed message parts survive retries and stale workers cannot mark sent',async()=>{
 await db.exec("update private.outbox set sent_at=now();update private.events set turn_until=null");
 await core('apply',{id:await event(),action:{type:'clarify',question:'Partes'}});
 const a=await queue('outbox');await queue('progress',{id:a.id,token:a.token,part:1,telegram_message_id:15});
 await queue('failed',{id:a.id,token:a.token});await db.exec("update private.outbox set retry_at=now()");const b=await queue('outbox');
 assert.equal(b.part,1);assert.notEqual(b.token,a.token);assert.equal((await queue('sent',{id:a.id,token:a.token})).ok,false);
});
