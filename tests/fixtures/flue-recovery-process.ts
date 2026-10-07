import assert from 'node:assert/strict';import {readFile,writeFile} from 'node:fs/promises';
import {DatabaseSync} from 'node:sqlite';
import {fauxProvider,fauxAssistantMessage as answer,fauxToolCall as call} from '@earendil-works/pi-ai/providers/faux';import {sqlite} from '@flue/runtime/node';import {z} from 'zod';import {createFinancialFlue} from '../../scripts/lib/flue-agent.ts';
const [db,counter,mode]=process.argv.slice(2);assert.ok(db&&counter&&['complete','replay','crash','recover'].includes(mode));
let interruptedId:string|undefined;
if(mode==='recover'){
 const inspect=new DatabaseSync(db);interruptedId=String(inspect.prepare("select submission_id from flue_agent_submissions where status='running'").get()!.submission_id);const expired=inspect.prepare("update flue_agent_submissions set lease_expires_at=1 where status='running'").run();assert.equal(expired.changes,1);inspect.close();
}
const p=fauxProvider({provider:'restart-test',models:[{id:'fixture',contextWindow:32000,maxTokens:1800}],tokensPerSecond:100000});p.setResponses([answer(call('prepare_synthetic',{amount:'25013'}))]);
const runtime=await createFinancialFlue({provider:p.provider,model:'restart-test/fixture',db:sqlite(db),tools:[{name:'prepare_synthetic',description:'Synthetic test only',inputSchema:z.object({amount:z.string()}),readOnly:false}]});
try{
 if(mode==='recover'){
  const inspect=new DatabaseSync(db);let settled=false;
  try{
   for(let i=0;i<100;i++){
    const rows=inspect.prepare("select status,error from flue_agent_submissions where submission_id=?").all(interruptedId!);
    if(rows.length===1&&rows[0].status==='settled'){assert.ok(rows[0].error,'interrupted attempt must settle as a failure');settled=true;break;}
    await new Promise(r=>setTimeout(r,20));
   }
   assert.equal(settled,true,'expired interrupted submission must reach a terminal state');assert.equal(p.state.callCount,0);console.log('stale_tools_blocked');
  }finally{inspect.close();}
 }else{
  const result=await runtime.run({key:mode==='crash'?'pending-admission':'completed-admission',instructions:'Synthetic test.',text:'Synthetic test.',dispatch:async()=>{
   const value=await readFile(counter,'utf8').then(JSON.parse).catch(()=>({effects:0}));await writeFile(counter,JSON.stringify({effects:value.effects+1}),{mode:0o600});
   if(mode==='crash')process.exit(0);
   return {action:{type:'synthetic',amount:'25013'}};
  }});assert.equal(result.amount,'25013');
 }
}finally{await runtime.close();}
