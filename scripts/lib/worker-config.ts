import {readProtectedJson} from './subscription-session.ts';
import {lstat} from 'node:fs/promises';
import {dirname} from 'node:path';
export async function loadWorkerConfig(path:string):Promise<{SUPABASE_URL:string;SUPABASE_SERVICE_ROLE_KEY:string}>{
 const dir=await lstat(dirname(path));if(!dir.isDirectory()||dir.isSymbolicLink()||dir.uid!==process.getuid?.()||(dir.mode&0o777)!==0o700)throw Error('Directorio de configuración protegido inválido');
 const config=await readProtectedJson<Record<string,unknown>>(path);
 const keys=['SUPABASE_URL','SUPABASE_SERVICE_ROLE_KEY'];
 if(!config||Object.keys(config).length!==2||Object.keys(config).some(k=>!keys.includes(k))||keys.some(k=>typeof config[k]!=='string'||!String(config[k]).trim()))throw Error('Configuración privada inválida');
 const url=new URL(config.SUPABASE_URL as string);
 if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||url.pathname!=='/')throw Error('Configuración de Supabase inválida');
 return {SUPABASE_URL:url.origin,SUPABASE_SERVICE_ROLE_KEY:config.SUPABASE_SERVICE_ROLE_KEY as string};
}
