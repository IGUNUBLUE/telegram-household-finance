/** Synthetic SQL retrieval probe; never connects to production. */
import {readFileSync,writeFileSync} from 'node:fs';
import {workerDatabase} from '../tests/fixtures/worker-database.ts';
const fixture=JSON.parse(readFileSync(process.argv[2],'utf8')),model='multilingual-e5-small-es-q8-v1';
const f=await workerDatabase();
try{
 const ev=await f.ingest({text:'consulta ficticia'});
 // Substitute only the source view in an isolated PGlite fixture, retaining the actual RPC.
 await f.db.exec(`drop view private.memory_sources;create table private.synthetic_memory_sources(key text,kind text,source_id text,actor text,access_ids text[],shared boolean,source_date date,account text,content text,reference jsonb);create view private.memory_sources as select * from private.synthetic_memory_sources;`);
 for(const d of fixture.documents){
  await f.db.query(`insert into private.synthetic_memory_sources values($1,'conversation',$2,'101',array['101'],false,'2026-10-03',null,$3,'{}')`,['synthetic:'+d.id,d.id,d.es]);
  await f.db.query(`insert into private.memory_embeddings(key,source_hash,model,embedding)values($1,md5($2),$3,$4::extensions.vector)`,['synthetic:'+d.id,d.es,model,JSON.stringify(d.vector)]);
 }
 const results=[];
 for(const q of fixture.queries){
  const r=await f.rpc('memory:search',{id:ev.id,query:q.es,embedding:q.vector,model});
  if(!r.candidate_only)throw Error('Candidates must not be treated as verified ledger records');
  const rank=r.matches.findIndex((m:{source_id:string})=>q.relevant.includes(m.source_id));
  results.push({id:q.id,group:q.group,relevant:q.relevant,rank:rank<0?null:rank+1,candidates:r.matches.map((m:{source_id:string})=>m.source_id)});
 }
 const positive=results.filter(q=>q.relevant.length),report={model,positive:{n:positive.length,hit1:positive.filter(q=>q.rank===1).length,hit8:positive.filter(q=>q.rank!==null).length},no_answer:results.filter(q=>!q.relevant.length),results,financial_writes:0,telegram_sends:0};
 writeFileSync(process.argv[3],JSON.stringify(report,null,2)+'\n');
 console.log(JSON.stringify({positive:report.positive,no_answer_candidates:report.no_answer.map(q=>({id:q.id,n:q.candidates.length})),failed:positive.filter(q=>q.rank===null)}));
 if(report.positive.hit8!==40)process.exitCode=1;
}finally{await f.db.close();}
