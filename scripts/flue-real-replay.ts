/** Real archived inputs/results stay in VPS memory. No financial RPC, OAuth or Telegram. */
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {join,dirname} from 'node:path';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {postgres} from '@flue/postgres';
import {fauxProvider,fauxAssistantMessage,fauxToolCall} from '@earendil-works/pi-ai/providers/faux';
import {openFlueSource} from './lib/flue-source.ts';
import {readFlueSnapshot,importFlueSnapshot,snapshotDigest} from './lib/flue-state-migration.ts';
import {createSecureFlueSqlite} from './lib/flue-sqlite.ts';
import {createPostgresRunner} from './lib/flue-postgres.ts';
import {createFinancialFlue} from './lib/flue-agent.ts';
import {financialTools} from '../supabase/functions/_shared/agent-tools.ts';
import {agentPrompt} from '../supabase/functions/_shared/agent-prompt.ts';

let pool:Awaited<ReturnType<typeof openFlueSource>>|undefined,baseline:Awaited<ReturnType<typeof openFlueSource>>|undefined,directory:string|undefined;
let runtime:Awaited<ReturnType<typeof createFinancialFlue>>|undefined;
const createdPaths:string[]=[];
let stage='options';
try{
 const args=process.argv.slice(2);if(args[0]!=='--config')throw Error('options');
 if(args.length===2||(args.length===3&&args[2]==='--compare-postgres')){
  const results:any[]=[];
  for(const backend of args.length===3?['sqlite','postgres']:['sqlite']){
   const report=await new Promise<any>((resolve,reject)=>{
    const child=spawn(process.execPath,[fileURLToPath(import.meta.url),'--config',args[1],'--backend',backend],{stdio:['ignore','pipe','pipe']});let output='',errors='';
    child.stdout.on('data',chunk=>{output+=chunk.toString();});child.stderr.on('data',chunk=>{errors+=chunk.toString();});child.on('error',reject);
    child.on('close',code=>{const lines=output.trim().split('\n').map(line=>JSON.parse(line));for(const line of lines.filter(l=>l.status!=='real_replay_passed'))console.log(JSON.stringify(line));if(code!==0)reject(Error('Isolated replay failed'));else resolve(lines.find(l=>l.status==='real_replay_passed'));});
   });results.push(report);
  }
  const report={...results[0],comparison:results.length===2?'postgres_and_sqlite':'sqlite_only',cases:results[0].cases.map((c:any,i:number)=>({...c,timings:{...c.timings,...results[1]?.cases[i].timings}}))};
  await writeFile(join(dirname(args[1]),'sqlite-real-replay-report.json'),JSON.stringify(report,null,2),{mode:0o600});console.log(JSON.stringify(report));
 }else{
 if(args.length!==4||args[2]!=='--backend'||!['sqlite','postgres'].includes(args[3]))throw Error('options');
 const selected=args[3] as 'sqlite'|'postgres';
 stage='source_connection';pool=await openFlueSource(args[1]);stage='snapshot';const snapshot=await readFlueSnapshot(pool);
 directory=await mkdtemp(join(dirname(args[1]),'sqlite-simulation-'));const sqlitePath=join(directory,'replay.db');
 stage='import';const counts=await importFlueSnapshot(snapshot,sqlitePath);const report:any={status:'real_replay_started',source_digest:snapshotDigest(snapshot),counts,cases:[]};
 console.log(JSON.stringify({status:report.status,counts}));
 baseline=await openFlueSource(args[1],'flue_sqlite_simulation');
 assert.equal((await baseline.query('select current_schema() as schema')).rows[0].schema,'flue_sqlite_simulation');
 const faux=fauxProvider({provider:'archive-replay',models:[{id:'fixture',contextWindow:32000,maxTokens:1800}],tokensPerSecond:1000000});
 let queries=0;
 const runner=createPostgresRunner(baseline);const tracked={...runner,query:async(sql:string,params?:any[])=>{queries++;return runner.query(sql,params);},transaction:async(fn:any)=>runner.transaction(async tx=>fn({query:async(sql:string,params?:any[])=>{queries++;return tx.query(sql,params);}})),close:async()=>{}};
 stage='runtime_start_'+selected;runtime=await createFinancialFlue({provider:faux.provider,model:'archive-replay/fixture',db:selected==='sqlite'?await createSecureFlueSqlite(sqlitePath):postgres(tracked),tools:financialTools});
 const paths=snapshot.flue_conversation_streams.map(r=>String(r.path)).filter(p=>p.includes('/event-'));
 assert.ok(paths.length>=1,'Need archived financial interactions');
 for(const path of paths){
  stage='reconstruct';const records=snapshot.flue_conversation_stream_batches.filter(b=>b.path===path).sort((a,b)=>Number(a.seq)-Number(b.seq)).flatMap(b=>JSON.parse(b.data));
  const input=records.find(r=>r.type==='user_message');assert.ok(input);
  const text=input.content.filter((c:any)=>c.type==='text').map((c:any)=>c.text).join('\n');assert.ok(text);
  const calls=records.filter(r=>r.type==='assistant_tool_call');const writes=records.filter(r=>r.type==='message_data_write'&&r.name==='financial_action');assert.ok(writes.length<=1);
  const responses=records.filter(r=>r.type==='assistant_message_completed').map(done=>{
   const own=records.filter(r=>r.messageId===done.messageId);
   const blocks:any[]=[];const content=own.filter(r=>r.type==='assistant_text_delta').map(r=>r.delta).join('');if(content)blocks.push({type:'text',text:content});
   for(const call of own.filter(r=>r.type==='assistant_tool_call'))blocks.push(fauxToolCall(call.name,call.arguments,{id:call.toolCallId}));
   assert.ok(blocks.length);return fauxAssistantMessage(blocks,{stopReason:done.stopReason});
  });assert.ok(responses.length);
  const expected=writes[0]?.data??{type:'clarify',question:responses.at(-1)!.content.filter(c=>c.type==='text').map(c=>(c as any).text).join('')};
  const days=records.find(r=>r.timestamp)?.timestamp?.slice(0,10)??'2026-10-03';const instructions=agentPrompt(new Date(days+'T00:00:00-05:00').toLocaleDateString('en-CA',{timeZone:'America/Bogota'}));
  const caseResult:any={index:report.cases.length+1,tool_calls:calls.length,result_type:expected.type,timings:{}};
  for(const backend of [selected]){
   stage='replay_'+backend;faux.setResponses(structuredClone(responses));
   const key='simulation-replay-'+randomUUID();let count=0;queries=0;
   if(backend==='postgres')createdPaths.push('agents/finance-event-v1/'+key);
   try{
    stage='runtime_run_'+backend;const start=performance.now(),usage=process.resourceUsage();
    const actual=await runtime.run({key,instructions,text,timeoutMs:120000,dispatch:async(name,args)=>{
     const call=calls[count++];assert.ok(call);assert.equal(name,call.name);assert.deepEqual(args,call.arguments);
     const outcome=records.find(r=>r.type==='tool_outcome'&&r.toolCallId===call.toolCallId);assert.ok(outcome&&!outcome.isError);
     const output=JSON.parse(outcome.content.filter((c:any)=>c.type==='text').map((c:any)=>c.text).join(''));
     return output.status==='prepared_for_server'?{action:structuredClone(writes[0].data)}:{result:structuredClone(output)};
    }});
    assert.deepEqual(actual,expected);assert.equal(count,calls.length);
    caseResult.timings[backend]={elapsed_ms:Math.round(performance.now()-start),sql_queries:backend==='postgres'?queries:undefined,cpu_ms:Math.round((process.resourceUsage().userCPUTime+process.resourceUsage().systemCPUTime-usage.userCPUTime-usage.systemCPUTime)/1000),rss_mib:Math.round(process.memoryUsage().rss/1048576)};
   }finally{/* Keep one Flue runtime for the isolated backend process. */}
   console.log(JSON.stringify({status:'real_replay_case_passed',index:caseResult.index,backend,...caseResult.timings[backend]}));
  }
  report.cases.push(caseResult);
 }
 stage='cleanup';
 // Delete only fresh simulation streams and their exact submission IDs; never real records.
 for(const path of createdPaths){
  const ids=(await baseline.query('SELECT DISTINCT submission_id FROM flue_conversation_stream_batches WHERE path=$1 AND submission_id IS NOT NULL',[path])).rows.map(r=>r.submission_id);
  await baseline.query('DELETE FROM flue_submission_chunks WHERE submission_id=ANY($1::text[])',[ids]);await baseline.query('DELETE FROM flue_agent_submissions WHERE submission_id=ANY($1::text[])',[ids]);
  await baseline.query('DELETE FROM flue_conversation_fold_checkpoints WHERE path=$1',[path]);await baseline.query('DELETE FROM flue_conversation_stream_batches WHERE path=$1',[path]);await baseline.query('DELETE FROM flue_conversation_streams WHERE path=$1',[path]);
 }
 assert.equal(snapshotDigest(await readFlueSnapshot(pool)),snapshotDigest(snapshot),'Original runtime records must be unchanged');
 report.status='real_replay_passed';report.financial_writes=0;report.telegram_sends=0;
 console.log(JSON.stringify(report));
 }
}catch(error){const message=error instanceof Error?error.message:'';const allowed=['State snapshot is incomplete or has unfinished work','Imported state checksum mismatch','Snapshot schema mismatch','Imported state references are invalid','Imported state integrity failed','Interpretación financiera no disponible.'];console.log(JSON.stringify({status:'real_replay_failed',stage,reason:allowed.includes(message)?message:undefined,code:(error as any)?.code,location:error instanceof Error?error.stack?.split('\n')[1]?.trim():undefined}));process.exitCode=1;}
finally{await runtime?.close();await baseline?.end();await pool?.end();if(directory)await rm(directory,{recursive:true,force:true});}

