import {DatabaseSync,type SQLInputValue} from 'node:sqlite';
import {randomUUID,createHash} from 'node:crypto';
import {link,unlink,rm} from 'node:fs/promises';
import {createSecureFlueSqlite,assertAbsent} from './flue-sqlite.ts';
import type {Pool} from 'pg';

export const flueTables=['flue_meta','flue_conversation_streams','flue_conversation_stream_batches','flue_conversation_fold_checkpoints','flue_agent_submissions','flue_submission_chunks','flue_attachments'] as const;
export type FlueSnapshot=Record<typeof flueTables[number],Record<string,any>[]>;
export async function readFlueSnapshot(pool:Pool):Promise<FlueSnapshot>{
 const client=await pool.connect();
 try{
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  const snapshot={} as FlueSnapshot;
  for(const table of flueTables)snapshot[table]=(await client.query('SELECT * FROM '+table)).rows;
  await client.query('COMMIT');return snapshot;
 }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
}
const canonical=(row:Record<string,any>)=>JSON.stringify(Object.fromEntries(Object.keys(row).sort().map(k=>[k,row[k]===null?null:Buffer.isBuffer(row[k])||row[k] instanceof Uint8Array?Buffer.from(row[k]).toString('base64'):String(row[k])])));
export const snapshotDigest=(snapshot:FlueSnapshot)=>createHash('sha256').update(JSON.stringify(flueTables.map(t=>[t,snapshot[t].map(canonical).sort()]))).digest('hex');
export async function importFlueSnapshot(snapshot:FlueSnapshot,path:string){
 if(flueTables.some(t=>!Array.isArray(snapshot[t]))||snapshot.flue_agent_submissions.some(r=>r.status!=='settled'))throw Error('State snapshot is incomplete or has unfinished work');
 await assertAbsent(path);const temp=path+'.'+randomUUID()+'.import';let adapter,db:DatabaseSync|undefined;
 try{
  adapter=await createSecureFlueSqlite(temp);adapter.migrate!();adapter.close!();adapter=undefined;
  db=new DatabaseSync(temp);db.exec('PRAGMA foreign_keys=ON; BEGIN IMMEDIATE;');
  db.exec('DELETE FROM flue_meta');
  for(const table of flueTables){
   const columns=db.prepare('PRAGMA table_info('+table+')').all() as {name:string;type:string}[];
   for(const original of snapshot[table]){
    const row={...original};if(table==='flue_attachments'){delete row.bytes;row.chunk_count=1;}
    const names=Object.keys(row);if(names.some(n=>!columns.some(c=>c.name===n)))throw Error('Snapshot schema mismatch');
    const values=names.map(n=>{const value=row[n];if(value===null)return null;if(columns.find(c=>c.name===n)!.type==='INTEGER'){if(!/^-?\d+$/.test(String(value)))throw Error('Invalid integer');return BigInt(value);}return value as SQLInputValue;});
    db.prepare('INSERT INTO '+table+' ('+names.join(',')+') VALUES ('+names.map(()=>'?').join(',')+')').run(...values);
    if(table==='flue_attachments')db.prepare('INSERT INTO flue_attachment_chunks (stream_path,attachment_id,chunk_index,bytes) VALUES (?,?,0,?)').run(row.stream_path,row.attachment_id,original.bytes);
   }
  }
  const copied={} as FlueSnapshot;const counts:Record<string,number>={};
  for(const table of flueTables){
   const statement=db.prepare('SELECT * FROM '+table);statement.setReadBigInts(true);
   const rows=statement.all() as Record<string,any>[];counts[table]=rows.length;
   copied[table]=rows.map(row=>{
    if(table==='flue_conversation_fold_checkpoints')delete row.chunk_count;
    if(table==='flue_attachments'){delete row.chunk_count;row.bytes=db!.prepare('SELECT bytes FROM flue_attachment_chunks WHERE stream_path=? AND attachment_id=? ORDER BY chunk_index').get(row.stream_path,row.attachment_id)!.bytes;}
    return row;
   });
  }
  if(snapshotDigest(copied)!==snapshotDigest(snapshot))throw Error('Imported state checksum mismatch');
  if(db.prepare('PRAGMA foreign_key_check').all().length)throw Error('Imported state references are invalid');
  db.exec('COMMIT; PRAGMA wal_checkpoint(TRUNCATE);');
  if(db.prepare('PRAGMA quick_check').get()!.quick_check!=='ok')throw Error('Imported state integrity failed');
  db.close();db=undefined;adapter=await createSecureFlueSqlite(temp);adapter.migrate!();adapter.close!();adapter=undefined;
  await link(temp,path);await unlink(temp);return counts;
 }finally{if(db){try{db.exec('ROLLBACK');}catch{}db.close();}adapter?.close!();for(const suffix of ['','-wal','-shm'])await rm(temp+suffix,{force:true});}
}

