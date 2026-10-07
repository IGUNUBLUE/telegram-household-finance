import {test} from 'node:test';import assert from 'node:assert/strict';
import {createVpsMemoryClient} from '../scripts/lib/vps-memory.ts';
import {workerDatabase} from './fixtures/worker-database.ts';
const model='multilingual-e5-small-es-q8-v1',vector=[1,...Array(383).fill(0)];
test('E5 search authorizes before inference, uses Spanish query prefix mode and never translates',async()=>{
 const calls:any[]=[];let inferred=0;
 const client=createVpsMemoryClient({model,rpc:async(op,data:any)=>{calls.push({op,data});if(data?.id===999)throw Error('Unauthorized');return {lexical:!data?.embedding};},translate:async()=>{throw Error('Translation must not run');},embed:async(text,signal,kind)=>{inferred++;assert.equal(text,'comida para el gato');assert.equal(kind,'query');return vector;}});
 await assert.rejects(client.search({id:999,query:'comida para el gato'}));assert.equal(inferred,0);
 assert.deepEqual(await client.search({id:1,query:'comida para el gato',account:'Principal',model:'gte-small-en-v1'}),{lexical:false});
 assert.equal(calls.at(-1).data.model,model);
});
test('E5 indexing stores passages tagged with their model without translating',async()=>{
 const writes:any[]=[];let claimed=false;
 const client=createVpsMemoryClient({model,rpc:async(op,data:any)=>{if(op==='memory:next'){assert.equal(data.model,model);if(claimed)return [];claimed=true;return [{key:'one',hash:'h',lease:'l',text:'Pagué el arriendo'}];}if(op==='memory:store'){writes.push(data);return {stored:true};}return {};},translate:async()=>{throw Error('Translation must not run');},embed:async(text,signal,kind)=>{assert.equal(text,'Pagué el arriendo');assert.equal(kind,'passage');return vector;}});
 assert.equal(await client.indexBatch(),true);assert.equal(writes[0].model,model);assert.equal(await client.indexBatch(),false);
});
test('SQL model isolation rejects cross-model leases and never compares equal-size vectors across models',async()=>{
 const f=await workerDatabase();try{
  const ev=await f.ingest({text:'Texto ficticio para memoria'});await f.rpc('queue:claim');await f.rpc('pro:conversation',{id:ev.id,text:'Texto ficticio para memoria'});const action={type:'clarify',question:'Listo'};await f.rpc('proposal',{id:ev.id,action});await f.rpc('agent:apply',{id:ev.id,action});
  const old=(await f.rpc('memory:next'))[0];assert.ok(old);
  const fresh=(await f.rpc('memory:next',{model}))[0];assert.ok(fresh);assert.notEqual(fresh.lease,old.lease);
  assert.equal((await f.rpc('memory:store',{...old,model,embedding:vector})).stored,false);
  assert.equal((await f.rpc('memory:store',{...fresh,model:'gte-small-en-v1',embedding:vector})).stored,false);
  assert.equal((await f.rpc('memory:store',{...fresh,model,embedding:vector})).stored,true);
  const data={id:ev.id,query:'palabraausente',embedding:vector};
  assert.equal((await f.rpc('memory:search',data)).matches.length,0);
  const found=await f.rpc('memory:search',{...data,model});assert.equal(found.matches.length,1);assert.equal(found.candidate_only,true);
  assert.equal((await f.rpc('memory:store',{...old,embedding:vector})).stored,true);
  await assert.rejects(f.rpc('memory:search',{...data,model:'unknown'}),/unsupported embedding model/);
  assert.equal((await f.rpc('memory:status',{model})).indexed,1);
 }finally{await f.db.close();}
});
test('retiring the English cache aborts with an incomplete E5 index and preserves sources and ledger',async()=>{
 const {readFileSync,readdirSync}=await import('node:fs');const file=readdirSync('supabase/migrations').find(f=>f.endsWith('_retire_legacy_embedding_cache.sql'))!;const sql=readFileSync('supabase/migrations/'+file,'utf8');
 const f=await workerDatabase({skipLegacyEmbeddingCleanup:true});try{
  const ev=await f.ingest({text:'Recuerdo ficticio para retirar caché'});await f.rpc('queue:claim');await f.rpc('pro:conversation',{id:ev.id,text:'Recuerdo ficticio para retirar caché'});const action={type:'clarify',question:'Listo'};await f.rpc('proposal',{id:ev.id,action});await f.rpc('agent:apply',{id:ev.id,action});
  const old=(await f.rpc('memory:next'))[0];await f.rpc('memory:store',{...old,embedding:vector});
  await assert.rejects(f.db.exec(sql),/E5 index incomplete/);assert.equal((await f.rpc('memory:status')).indexed,1);
  const fresh=(await f.rpc('memory:next',{model}))[0];await f.rpc('memory:store',{...fresh,model,embedding:vector});
  const sources=(await f.db.query('select * from private.memory_sources order by key')).rows,ledger=(await f.db.query('select * from private.transactions order by id')).rows;
  await f.db.exec(sql);
  assert.deepEqual((await f.db.query('select * from private.memory_sources order by key')).rows,sources);assert.deepEqual((await f.db.query('select * from private.transactions order by id')).rows,ledger);
  assert.equal((await f.rpc('memory:status')).indexed,0);assert.equal((await f.rpc('memory:status',{model})).indexed,1);
 }finally{await f.db.close();}
});
