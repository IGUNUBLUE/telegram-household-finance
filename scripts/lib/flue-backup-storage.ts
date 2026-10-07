import {createHash} from 'node:crypto';
type Config={SUPABASE_URL:string;SUPABASE_SERVICE_ROLE_KEY:string};
const bucket='flue-runtime-backups';
const backupName=/^flue-[0-9TZ-]+\.db$/;
const digest=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
/** Service-role access only. Never expose the bucket or print credentials/history. */
export async function uploadPrivateFlueBackup(config:Config,name:string,data:Uint8Array,request:typeof fetch=fetch){
 if(!backupName.test(name))throw Error('Invalid backup name');
 const base=config.SUPABASE_URL+'/storage/v1';
 const headers={apikey:config.SUPABASE_SERVICE_ROLE_KEY,Authorization:'Bearer '+config.SUPABASE_SERVICE_ROLE_KEY};
 const call=(path:string,method='GET',body?:BodyInit,extra:Record<string,string>={})=>request(base+path,{method,headers:{...headers,...extra},body,signal:AbortSignal.timeout(60000)});
 let metadata=await call('/bucket/'+bucket);
 if(!metadata.ok){
  const error=await metadata.json().catch(()=>({}));
  if(metadata.status!==404&&Number(error.statusCode)!==404)throw Error('Backup storage unavailable');
  const created=await call('/bucket','POST',JSON.stringify({id:bucket,name:bucket,public:false,allowed_mime_types:['application/octet-stream']}),{'Content-Type':'application/json'});
  if(!created.ok)throw Error('Backup storage creation failed');
  metadata=await call('/bucket/'+bucket);
 }
 if(!metadata.ok||(await metadata.json()).public!==false)throw Error('Backup bucket must be private');
 const uploaded=await call('/object/'+bucket+'/'+name,'POST',new Uint8Array(data),{'Content-Type':'application/octet-stream','x-upsert':'false'});
 if(!uploaded.ok)throw Error('Backup upload failed');
 const restored=await call('/object/authenticated/'+bucket+'/'+name);
 if(!restored.ok||digest(new Uint8Array(await restored.arrayBuffer()))!==digest(data))throw Error('Offsite restore verification failed');
 const listed=await call('/object/list/'+bucket,'POST',JSON.stringify({prefix:'',limit:1000,sortBy:{column:'name',order:'desc'}}),{'Content-Type':'application/json'});
 if(!listed.ok)throw Error('Backup inventory unavailable');
 const objects=await listed.json();if(!Array.isArray(objects))throw Error('Backup inventory invalid');
 const old=objects.map(o=>o.name).filter((n:unknown):n is string=>typeof n==='string'&&backupName.test(n)).sort().slice(0,-7);
 if(old.length){const removed=await call('/object/'+bucket,'DELETE',JSON.stringify({prefixes:old}),{'Content-Type':'application/json'});if(!removed.ok)throw Error('Backup retention failed');}
 return {sha256:digest(data),offsite_verified:true};
}

