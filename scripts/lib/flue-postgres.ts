import {Pool,type PoolConfig} from 'pg';
import {postgres,type PostgresRunner} from '@flue/postgres';
import {readFileSync} from 'node:fs';
// Public CA linked by Supabase Studio SSLConfiguration/custom-content.json.
// SHA256 700723581420dd1ac98fd7e9ac529f0ef210eadcaf87fc868a3ad7d114c2f3b7.
const supabaseCA=readFileSync(new URL('../certs/supabase-prod-ca-2021.crt',import.meta.url),'utf8');
export function fluePoolOptions(supabaseUrl:string,password:string,ca?:string):PoolConfig{
 const url=new URL(supabaseUrl);
 if(url.protocol!=='https:'||!/^([a-z0-9]+)\.supabase\.co$/.test(url.hostname)||url.username||url.password||!password)throw Error('Private database configuration invalid');
 return {host:'db.'+url.hostname,user:'flue_finance_login',password,database:'postgres',port:5432,ssl:{rejectUnauthorized:true,ca:ca??supabaseCA},options:'-c search_path=flue_finance',max:3,connectionTimeoutMillis:15000,idleTimeoutMillis:30000};
}
export function createPostgresRunner(pool:Pool):PostgresRunner{
 return {query:async(text,params)=>(await pool.query(text,params)).rows,transaction:async fn=>{
  const client=await pool.connect();
  try{await client.query('BEGIN');const result=await fn({query:async(text,params)=>(await client.query(text,params)).rows});await client.query('COMMIT');return result;}
  catch(error){await client.query('ROLLBACK');throw error;}
  finally{client.release();}
 },close:()=>pool.end()};
}
export function createFluePersistence(supabaseUrl:string,password:string,ca?:string){
 const pool=new Pool(fluePoolOptions(supabaseUrl,password,ca));pool.on('error',()=>{/* Never forward driver errors containing credentials. Requests report sanitized failures. */});
 return postgres(createPostgresRunner(pool));
}
