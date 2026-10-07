import {PGlite} from '@electric-sql/pglite';
import {vector} from '@electric-sql/pglite-pgvector';
import {readFileSync,readdirSync} from 'node:fs';
export async function workerDatabase(options:{vaultFunction?:boolean;skipSqliteCleanup?:boolean;skipLegacyEmbeddingCleanup?:boolean}={}){
 const db=new PGlite({extensions:{vector}});
 await db.exec('create role anon; create role authenticated; create role service_role bypassrls; create schema vault; create table vault.decrypted_secrets(name text, decrypted_secret text); grant usage on schema vault to service_role; grant select on vault.decrypted_secrets to service_role;');
 if(options.vaultFunction)await db.exec(`create function vault.create_secret(new_secret text,new_name text default null,new_description text default '',new_key_id uuid default null) returns uuid language plpgsql as $$ begin insert into vault.decrypted_secrets(name,decrypted_secret) values(new_name,new_secret); return gen_random_uuid(); end $$;`);
 for(const f of readdirSync('supabase/migrations').filter(f=>!f.endsWith('_worker_schedule.sql')&&!(options.skipSqliteCleanup&&f.endsWith('_flue_sqlite_cleanup.sql'))&&!(options.skipLegacyEmbeddingCleanup&&f.endsWith('_retire_legacy_embedding_cache.sql'))).sort())await db.exec(readFileSync('supabase/migrations/'+f,'utf8'));
 const rpc=async(op:string,data:any={})=>{
  const prefix=op.split(':')[0];
  const names:Record<string,string>={approval:'finance_approval',worker:'finance_worker_context',queue:'finance_queue',pro:'finance_pro',agent:'finance_agent',natural:'finance_natural',routine:'finance_routines',memory:'finance_memory',flow:'finance_flow',family:'finance_family',ui:'finance_ui'};
  const name=op==='agent:trace'?'finance_worker_trace':op==='agent:search'?'finance_movement_search':op==='agent:statement'?'finance_account_statement':names[prefix]??'finance_api';
  return (await db.query<{r:any}>(`select public.${name}($1,$2::jsonb) r`,[names[prefix]?op.split(':')[1]:op,JSON.stringify(data)])).rows[0].r;
 };
 await rpc('init',{group:'-100123'});
 let update=1;
 const ingest=async(payload:any)=>rpc('ingest',{update_id:update++,actor:'101',name:'Persona',group:'-100123',payload:{actor:'101',text:'consulta',...payload}});
 return {db,rpc,ingest};
}
