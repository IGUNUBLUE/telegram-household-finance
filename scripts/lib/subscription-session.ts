import {mkdir,lstat,open,rename,rm} from 'node:fs/promises';
import {constants} from 'node:fs';
import {join,dirname} from 'node:path';
import {randomUUID} from 'node:crypto';
import {refreshCredentials,type SubscriptionCredentials} from './subscription-auth.ts';
class ProtectedError extends Error{}
export const sessionStorageError=(e:unknown)=>e instanceof ProtectedError?e:new ProtectedError(['EACCES','EROFS','EPERM'].includes((e as NodeJS.ErrnoException)?.code??'')?'No se pudo acceder al almacenamiento: revisa los permisos.':'No se pudo acceder a la configuración protegida.');
const protectedError=sessionStorageError;
function checkStat(s:Awaited<ReturnType<typeof lstat>>,directory=false){
 if(s.isSymbolicLink()||!(directory?s.isDirectory():s.isFile())||Number(s.uid)!==process.getuid?.()||(Number(s.mode)&0o777)!==(directory?0o700:0o600))throw new ProtectedError('Configuración protegida con propietario, tipo o permisos inválidos.');
}
async function protectedDirectory(directory:string){await mkdir(directory,{recursive:true,mode:0o700});checkStat(await lstat(directory),true);}
export async function readProtectedJson<T>(path:string):Promise<T|undefined>{
 let handle;
 try{checkStat(await lstat(path));handle=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);checkStat(await handle.stat());return JSON.parse(await handle.readFile('utf8')) as T;}
 catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return;throw protectedError(e);}
 finally{await handle?.close();}
}
export async function writeProtectedJson(path:string,data:unknown):Promise<void>{
 const temp=path+'.'+randomUUID()+'.tmp';let handle;
 try{
  await protectedDirectory(dirname(path));await readProtectedJson(path);
  handle=await open(temp,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
  await handle.writeFile(JSON.stringify(data));await handle.sync();await handle.close();handle=undefined;await rename(temp,path);
 }catch(e){throw protectedError(e);}finally{await handle?.close();await rm(temp,{force:true});}
}
type Owner={pid:number;owner:string};
async function removeOwned(path:string,owner:string){const current=await readProtectedJson<Owner>(path);if(current?.owner===owner)await rm(path);}
async function createLock(path:string,record:Owner){const h=await open(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);try{await h.writeFile(JSON.stringify(record));await h.sync();}finally{await h.close();}}
async function acquire(path:string,record:Owner){
 try{await createLock(path,record);return;}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;}
 const previous=await readProtectedJson<Owner>(path);
 if(!previous||!Number.isSafeInteger(previous.pid)||previous.pid<=0||typeof previous.owner!=='string')throw new ProtectedError('Bloqueo protegido inválido; requiere recuperación del operador.');
 try{process.kill(previous.pid,0);throw new ProtectedError('Ya hay una conexión o prueba en curso.');}
 catch(e){if((e as NodeJS.ErrnoException).code!=='ESRCH')throw e instanceof ProtectedError?e:new ProtectedError('Ya hay una conexión o prueba en curso.');}
 const guard=path+'.recovery';
 try{await createLock(guard,record);}catch(e){if((e as NodeJS.ErrnoException).code==='EEXIST')throw new ProtectedError('Ya hay una recuperación en curso; revisa el bloqueo protegido.');throw e;}
 try{
  const current=await readProtectedJson<Owner>(path);
  if(current?.owner!==previous.owner||current.pid!==previous.pid)throw new ProtectedError('Ya hay una conexión o prueba en curso.');
  try{process.kill(current.pid,0);throw new ProtectedError('Ya hay una conexión o prueba en curso.');}catch(e){if((e as NodeJS.ErrnoException).code!=='ESRCH')throw e;}
  await removeOwned(path,previous.owner);await createLock(path,record);
 }finally{await removeOwned(guard,record.owner);}
}
function validCredentials(c:SubscriptionCredentials,host:string){
 if(c.issuer!=='https://auth.openai.com'||!c.subject||!c.client_id||c.ext_agent_host_id!==host||!c.access_token||!c.refresh_token||!Number.isFinite(c.expires_at)||!Array.isArray(c.scopes)||!['resource.invoke','chatgpt.tokens.use.direct'].every(scope=>c.scopes.includes(scope)))throw new ProtectedError('Sesión protegida inválida; autoriza el cliente propio.');
}
export type SubscriptionSession={accessToken:()=>Promise<string>;close:()=>Promise<void>;model:string|undefined;hostId:string;credentials:()=>SubscriptionCredentials|undefined;save:(value:SubscriptionCredentials)=>Promise<void>};
export async function openSubscriptionSession(options:{directory:string;refresh?:typeof refreshCredentials;persist?:typeof writeProtectedJson;allowMissing?:boolean}):Promise<SubscriptionSession>{
 const directory=options.directory,path=join(directory,'subscription.lock'),record={pid:process.pid,owner:randomUUID()};
 try{await protectedDirectory(directory);await acquire(path,record);}catch(e){throw protectedError(e);}
 try{
  const file=join(directory,'chatgpt-subscription.json');let stored=await readProtectedJson<SubscriptionCredentials>(file);
  if(!stored&&!options.allowMissing)throw new ProtectedError('Falta conexión de ChatGPT; autoriza el cliente propio.');
  const hostFile=join(directory,'host.json');let host=await readProtectedJson<{id:string}>(hostFile);
  if(!host){host={id:stored?.ext_agent_host_id??'urn:uuid:'+randomUUID()};await writeProtectedJson(hostFile,host);}
  if(!/^urn:uuid:[0-9a-f-]{36}$/i.test(host.id))throw new ProtectedError('Identificador protegido de host inválido.');
  if(stored)validCredentials(stored,host.id);
  let closed=false,refreshing:Promise<string>|undefined;
  const save=async(value:SubscriptionCredentials)=>{if(closed)throw new ProtectedError('Sesión cerrada.');validCredentials(value,host!.id);if(stored&&value.subject!==stored.subject)throw new ProtectedError('La autorización pertenece a otra cuenta.');await (options.persist??writeProtectedJson)(file,value);stored=value;};
  const accessToken=async()=>{
   if(closed||!stored)throw new ProtectedError('Sesión de ChatGPT no disponible.');
   if(stored.expires_at-Date.now()>60_000)return stored.access_token;
   if(!refreshing)refreshing=(async()=>{try{await save(await (options.refresh??refreshCredentials)(stored!));return stored!.access_token;}catch{throw new ProtectedError('Sesión de ChatGPT no disponible; revisa autorización y almacenamiento.');}})().finally(()=>{refreshing=undefined;});
   return refreshing;
  };
  return {accessToken,get model(){return stored?.model;},hostId:host.id,credentials:()=>stored,save,close:async()=>{if(closed)return;await refreshing?.catch(()=>{});closed=true;await removeOwned(path,record.owner);}};
 }catch(e){await removeOwned(path,record.owner);throw protectedError(e);}
}
