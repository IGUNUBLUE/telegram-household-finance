import {mkdir,lstat,open,rm,link,unlink,chmod} from 'node:fs/promises';
import {constants} from 'node:fs';
import {dirname,isAbsolute,join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {DatabaseSync,backup} from 'node:sqlite';
import {sqlite} from '@flue/runtime/node';

export const flueStatePath=(directory:string)=>join(directory,'flue-state','flue.db');
async function privatePath(path:string,create:boolean){
 if(!isAbsolute(path))throw Error('Local state requires an absolute persistent path');
 const parent=dirname(path);await mkdir(parent,{recursive:true,mode:0o700});
 const directory=await lstat(parent);
 if(!directory.isDirectory()||directory.isSymbolicLink()||directory.uid!==process.getuid?.()||(directory.mode&0o777)!==0o700)throw Error('Local state directory is not private');
 let file;
 try{file=await lstat(path);}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
 if(!file&&create){const h=await open(path,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);await h.close();file=await lstat(path);}
 if(!file||!file.isFile()||file.isSymbolicLink()||file.uid!==process.getuid?.()||(file.mode&0o777)!==0o600)throw Error('Local state file is not private');
}
export async function createSecureFlueSqlite(path:string,create=true){
 await privatePath(path,create);
 if(!create){
  const verify=new DatabaseSync(path,{readOnly:true});
  try{
   if(verify.prepare('PRAGMA quick_check').get()!.quick_check!=='ok'||!verify.prepare("select value from flue_meta where key='format_version'").get())throw Error('Existing Flue state is invalid');
   for(const table of ['flue_agent_submissions','flue_conversation_streams','flue_conversation_stream_batches','flue_conversation_fold_checkpoints','flue_submission_chunks','flue_attachments','flue_attachment_chunks'])verify.prepare('SELECT 1 FROM '+table+' LIMIT 1').all();
  }finally{verify.close();}
 }
 // Flue 2.2.2 opens file-backed node:sqlite in WAL mode with FULL's default durability.
 return sqlite(path);
}
/** SQLite's online backup includes committed WAL data; copying just .db does not. */
export async function backupFlueSqlite(source:string,destination:string){
 await privatePath(source,false);
 const reserved=await open(destination+'.reservation',constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600).catch(async e=>{
  if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;
  await mkdir(dirname(destination),{recursive:true,mode:0o700});
  return open(destination+'.reservation',constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);
 });await reserved.close();
 const temp=destination+'.'+randomUUID()+'.tmp';let db:DatabaseSync|undefined;
 try{
  await assertAbsent(destination);await privatePath(temp,true);db=new DatabaseSync(source,{readOnly:true});await backup(db,temp);db.close();db=undefined;
  const verify=new DatabaseSync(temp,{readOnly:true});try{if(verify.prepare('PRAGMA quick_check').get()!.quick_check!=='ok')throw Error('Backup integrity failed');}finally{verify.close();}
  await chmod(temp,0o600);await link(temp,destination);await unlink(temp);
 }finally{db?.close();await rm(temp,{force:true});await rm(destination+'.reservation',{force:true});}
}
export async function assertAbsent(path:string){try{await lstat(path);}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return;throw e;}throw Error('Destination already exists');}
