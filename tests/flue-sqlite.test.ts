import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,lstat,chmod,symlink,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createSecureFlueSqlite,backupFlueSqlite} from '../scripts/lib/flue-sqlite.ts';
import {importFlueSnapshot,type FlueSnapshot} from '../scripts/lib/flue-state-migration.ts';

const empty=():FlueSnapshot=>({flue_meta:[{key:'format_version',value:'1'}],flue_conversation_streams:[],flue_conversation_stream_batches:[],flue_conversation_fold_checkpoints:[],flue_agent_submissions:[],flue_submission_chunks:[],flue_attachments:[]});
test('production startup refuses a missing, empty or truncated state instead of creating new history',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'flue-existing-'));const path=join(directory,'state.db');
 try{
  await assert.rejects(createSecureFlueSqlite(path,false));await assert.rejects(lstat(path));
  await writeFile(path,'',{mode:0o600});await assert.rejects(createSecureFlueSqlite(path,false));
  const blank=new DatabaseSync(path);blank.exec('create table unrelated(id integer)');blank.close();
  await assert.rejects(createSecureFlueSqlite(path,false));
  await writeFile(path,'SQLite format 3\u0000broken',{mode:0o600});await assert.rejects(createSecureFlueSqlite(path,false));
 }finally{await rm(directory,{recursive:true,force:true});}
});
test('local state has private permissions and a consistent backup includes committed WAL writes',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'flue-private-'));const path=join(directory,'state','flue.db');let adapter;
 try{
  adapter=await createSecureFlueSqlite(path);adapter.migrate!();
  assert.equal((await lstat(path)).mode&0o777,0o600);
  const db=new DatabaseSync(path);db.exec("CREATE TABLE acceptance (amount TEXT); INSERT INTO acceptance VALUES ('170000000');");db.close();
  const copy=join(directory,'backup','snapshot.db');await backupFlueSqlite(path,copy);
  const restored=new DatabaseSync(copy,{readOnly:true});assert.equal(restored.prepare('select amount from acceptance').get()!.amount,'170000000');restored.close();
  assert.equal((await lstat(copy)).mode&0o777,0o600);
  adapter.close!();adapter=await createSecureFlueSqlite(path);adapter.migrate!();
 }finally{adapter?.close!();await rm(directory,{recursive:true,force:true});}
});
test('local persistence rejects memory mode, unsafe permissions and symlink state files',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'flue-private-'));let adapter;
 try{
  await assert.rejects(createSecureFlueSqlite(':memory:'));
  const path=join(directory,'flue.db');adapter=await createSecureFlueSqlite(path);adapter.migrate!();adapter.close!();adapter=undefined;
  await chmod(path,0o644);await assert.rejects(createSecureFlueSqlite(path));await chmod(path,0o600);
  await symlink(path,join(directory,'link.db'));await assert.rejects(createSecureFlueSqlite(join(directory,'link.db')));
  await chmod(directory,0o755);await assert.rejects(createSecureFlueSqlite(path));
 }finally{adapter?.close!();await chmod(directory,0o700);await rm(directory,{recursive:true,force:true});}
});
test('migration preserves conversation batches and binary attachments and refuses an occupied target',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'flue-import-'));const path=join(directory,'state.db');
 try{
  const snapshot=empty();snapshot.flue_conversation_streams.push({path:'agents/finance-event-v1/fixture',identity_json:'{"agentName":"finance-event-v1","instanceId":"fixture"}',next_offset:'1',producer_id:null,producer_epoch:'0',next_producer_sequence:'0',incarnation:'inc_fixture'});
  snapshot.flue_conversation_stream_batches.push({path:'agents/finance-event-v1/fixture',seq:'0',producer_id:'fixture',producer_epoch:'0',producer_sequence:'0',data:'[{"amount_cents":"170000000","account":"Banco Alfa · Reserva"}]',submission_id:null,attempt_id:null});
  snapshot.flue_attachments.push({stream_path:'agents/finance-event-v1/fixture',attachment_id:'photo',mime_type:'image/jpeg',byte_size:'4',digest:'fixture',conversation_id:'conversation',bytes:Buffer.from([0,255,1,128]),created_at:'1790995800000'});
  const result=await importFlueSnapshot(snapshot,path);assert.equal(result.flue_conversation_stream_batches,1);assert.equal(result.flue_attachments,1);
  const db=new DatabaseSync(path,{readOnly:true});assert.equal(db.prepare('select data from flue_conversation_stream_batches').get()!.data,'[{"amount_cents":"170000000","account":"Banco Alfa · Reserva"}]');assert.deepEqual(Buffer.from(db.prepare('select bytes from flue_attachment_chunks').get()!.bytes as Uint8Array),Buffer.from([0,255,1,128]));db.close();
  await assert.rejects(importFlueSnapshot(snapshot,path));
 }finally{await rm(directory,{recursive:true,force:true});}
});
test('migration refuses unfinished submissions and rolls back an invalid snapshot',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'flue-import-'));const path=join(directory,'state.db');
 try{
  const snapshot=empty();snapshot.flue_agent_submissions.push({status:'running'});await assert.rejects(importFlueSnapshot(snapshot,path));await assert.rejects(lstat(path));
  const bad=empty();bad.flue_conversation_streams.push({path:'broken',next_offset:'1'});await assert.rejects(importFlueSnapshot(bad,path));await assert.rejects(lstat(path));
 }finally{await rm(directory,{recursive:true,force:true});}
});
