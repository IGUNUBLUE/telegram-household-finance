import {test} from 'node:test';import assert from 'node:assert/strict';
import {createVpsMemoryClient} from '../scripts/lib/vps-memory.ts';
import {workerDatabase} from './fixtures/worker-database.ts';
const vector=[1,...Array(383).fill(0)];
test('VPS memory authorizes first, preserves filters and falls back for malformed vectors',async()=>{
 const calls:any[]=[];let translations=0;
 const client=createVpsMemoryClient({rpc:async(op,data:any)=>{calls.push({op,data});if(data?.id===999)throw Error('Unauthorized');return {lexical:!data?.embedding};},translate:async t=>{translations++;return t;},embed:async()=>vector});
 await assert.rejects(client.search({id:999,query:'ficticio'}));assert.equal(translations,0);
 const data={id:1,query:'ficticio',account:'Cuenta ficticia',kind:'transaction',from:'2026-10-01',to:'2026-10-02'};
 assert.deepEqual(await client.search(data),{lexical:false});assert.deepEqual(calls.at(-1).data,{...data,embedding:vector});
 const bad=createVpsMemoryClient({rpc:async()=>({lexical:true}),translate:async t=>t,embed:async()=>[1]});assert.deepEqual(await bad.search(data),{lexical:true});
 const abort=new AbortController();abort.abort();await assert.rejects(client.search(data,abort.signal));
});
test('background inference failures finish all leases and trigger safe worker backoff',async()=>{
 const finished:string[]=[];
 const client=createVpsMemoryClient({rpc:async(op,data:any)=>{if(op==='memory:next')return [{key:'one',text:'fictional',hash:'h1',lease:'l1'},{key:'two',text:'fictional',hash:'h2',lease:'l2'}];if(op==='memory:fail')finished.push(data.key);return {};},translate:async()=>{throw Error('fictional-private-token');},embed:async()=>vector});
 await assert.rejects(client.indexBatch(),/Memory indexing unavailable/);assert.deepEqual(finished,['one','two']);
});
test('VPS indexing cannot store a stale source hash and finishes every claimed lease',async()=>{
 const f=await workerDatabase();try{
  const ev=await f.ingest({text:'Texto ficticio para memoria'});await f.rpc('queue:claim');await f.rpc('pro:conversation',{id:ev.id,text:'Texto ficticio para memoria'});const action={type:'clarify',question:'Listo'};await f.rpc('proposal',{id:ev.id,action});await f.rpc('agent:apply',{id:ev.id,action});
  const client=createVpsMemoryClient({rpc:f.rpc,translate:async text=>{await f.db.query('update private.conversation_turns set text=$1 where event_id=$2',['Fuente ficticia cambió',ev.id]);return text;},embed:async()=>vector});
  assert.equal(await client.indexBatch(),true);
  assert.equal((await f.db.query<any>('select count(*)::int n from private.memory_embeddings where embedding is not null')).rows[0].n,0);
  assert.equal((await f.db.query<any>('select count(*)::int n from private.memory_embeddings where lease is not null')).rows[0].n,0);
 }finally{await f.db.close();}
});
