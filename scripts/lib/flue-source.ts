import {Pool} from 'pg';
import {loadWorkerConfig} from './worker-config.ts';
import {fluePoolOptions} from './flue-postgres.ts';
/** Restricted Flue role only; credentials never leave this process. */
export async function openFlueSource(configPath:string,schema:'flue_finance'|'flue_sqlite_simulation'='flue_finance'){
 const config=await loadWorkerConfig(configPath);
 const response=await fetch(config.SUPABASE_URL+'/rest/v1/rpc/finance_runtime_config',{method:'POST',headers:{apikey:config.SUPABASE_SERVICE_ROLE_KEY,Authorization:'Bearer '+config.SUPABASE_SERVICE_ROLE_KEY,'Content-Type':'application/json'},body:'{}',signal:AbortSignal.timeout(15000)});
 if(!response.ok)throw Error('Source configuration unavailable');const values=await response.json();
 if(typeof values.FLUE_DATABASE_PASSWORD!=='string'||!values.FLUE_DATABASE_PASSWORD)throw Error('Source configuration unavailable');
 const options=fluePoolOptions(config.SUPABASE_URL,values.FLUE_DATABASE_PASSWORD);
 if(schema==='flue_sqlite_simulation')options.options='-c search_path=flue_sqlite_simulation';
 const pool=new Pool(options);pool.on('error',()=>{});return pool;
}
