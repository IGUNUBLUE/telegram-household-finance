/** Synthetic state only; no Telegram calls, OAuth or financial ledger access. */
import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';
import {fauxProvider,fauxAssistantMessage as answer,fauxToolCall as call} from '@earendil-works/pi-ai/providers/faux';import {z} from 'zod';
import {loadWorkerConfig} from './lib/worker-config.ts';import {createFluePersistence} from './lib/flue-postgres.ts';import {createFinancialFlue} from './lib/flue-agent.ts';
let runtime:Awaited<ReturnType<typeof createFinancialFlue>>|undefined;
try{
 const args=process.argv.slice(2);if(args.length!==2||args[0]!=='--config')throw Error('options');const config=await loadWorkerConfig(args[1]);
 const r=await fetch(config.SUPABASE_URL+'/rest/v1/rpc/finance_runtime_config',{method:'POST',headers:{apikey:config.SUPABASE_SERVICE_ROLE_KEY,Authorization:'Bearer '+config.SUPABASE_SERVICE_ROLE_KEY,'Content-Type':'application/json'},body:'{}',signal:AbortSignal.timeout(10000)});if(!r.ok)throw Error('config');const password=(await r.json()).FLUE_DATABASE_PASSWORD;if(!password)throw Error('config');
 const provider=fauxProvider({provider:'persistence-test',models:[{id:'fixture',contextWindow:32000,maxTokens:1800}],tokensPerSecond:100000});
 const options=()=>({provider:provider.provider,model:'persistence-test/fixture',db:createFluePersistence(config.SUPABASE_URL,password),tools:[{name:'prepare_synthetic',description:'Synthetic persisted action',inputSchema:z.object({cents:z.string()}),readOnly:false}]});
 const key='acceptance-'+randomUUID();let effects=0;const request={key,instructions:'Synthetic test only.',text:'Synthetic acceptance',dispatch:async()=>{effects++;return {action:{type:'synthetic',cents:'25013'}};}};
 provider.setResponses([answer(call('prepare_synthetic',{cents:'25013'}))]);runtime=await createFinancialFlue(options());assert.equal((await runtime.run(request)).cents,'25013');assert.equal(effects,1);await runtime.close();runtime=undefined;
 runtime=await createFinancialFlue(options());assert.equal((await runtime.run(request)).cents,'25013');assert.equal(effects,1);
 console.log(JSON.stringify({status:'private_postgres_restart_passed',effects}));
}catch{console.log(JSON.stringify({status:'private_postgres_restart_failed'}));process.exitCode=1;}
finally{await runtime?.close();}
