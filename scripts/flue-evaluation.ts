/** Synthetic financial acceptance; never claims a queue event or contacts Telegram. */
import {randomUUID} from 'node:crypto';
import {createFinancialFlue} from './lib/flue-agent.ts';
import {createProtectedPiProvider} from './lib/pi-provider.ts';
import {readProtectedJson,type SubscriptionSession} from './lib/subscription-session.ts';
import type {SubscriptionCredentials} from './lib/subscription-auth.ts';
import {evaluateFramework,frameworkEvaluationCases} from '../supabase/functions/_shared/framework-evaluation.ts';
import {financialTools} from '../supabase/functions/_shared/agent-tools.ts';
let runtime:Awaited<ReturnType<typeof createFinancialFlue>>|undefined;
let stage='options';
try{
 const args=process.argv.slice(2);
 if(args.length!==2||args[0]!=='--read-only-session')throw Error('Invalid evaluation options');
 stage='protected_session';
 const session={accessToken:async()=>{
  const value=await readProtectedJson<SubscriptionCredentials>(args[1]);
  if(!value||value.issuer!=='https://auth.openai.com'||!value.subject||!value.client_id||!value.scopes.includes('chatgpt.tokens.use.direct')||value.expires_at-Date.now()<60000)throw Error('Protected session unavailable for read-only evaluation');
  return value.access_token;
 }} as SubscriptionSession;
 const token=await session.accessToken();stage='catalog';
 const response=await fetch('https://api.openai.com/v1/models',{headers:{Authorization:'Bearer '+token},signal:AbortSignal.timeout(20000)});
 if(!response.ok)throw Error('Catalog unavailable');
 const provider=createProtectedPiProvider(session,await response.json());
 stage='flue_start';runtime=await createFinancialFlue({provider:provider as unknown as Parameters<typeof createFinancialFlue>[0]['provider'],tools:financialTools});
 let passed=0;
 for(const name of frameworkEvaluationCases){
  const result=await evaluateFramework(name,undefined as never,options=>runtime!.run({key:'evaluation-'+name+'-'+randomUUID(),instructions:options.instructions,text:String(options.messages[0].content),dispatch:options.dispatch,onMetrics:options.onMetrics}));
  if(result.passed)passed++;console.log(JSON.stringify(result));
 }
 console.log(JSON.stringify({status:'evaluation_complete',passed,total:frameworkEvaluationCases.length}));
 if(passed!==frameworkEvaluationCases.length)process.exitCode=1;
}catch{console.log(JSON.stringify({status:'evaluation_unavailable',stage}));process.exitCode=1;}
finally{await runtime?.close();}
