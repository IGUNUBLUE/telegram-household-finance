import {test} from 'node:test';import assert from 'node:assert/strict';
import {fauxProvider,fauxAssistantMessage as answer} from '@earendil-works/pi-ai/providers/faux';
import {probeFlueAuthorization} from '../scripts/lib/flue-auth-probe.ts';
test('handoff probe resolves protected authorization before native transport',async()=>{
 const p=fauxProvider({provider:'openai',models:[{id:'gpt-6-luna',contextWindow:32000,maxTokens:1800}],tokensPerSecond:100000});p.setResponses([answer('CONEXION_OK')]);let resolved=0,requests=0;
 const provider={...p.provider,auth:{apiKey:{name:'Protected test session',resolve:async()=>{resolved++;return {auth:{apiKey:'synthetic-session-access'},source:'Protected OAuth'};}}},streamSimple:(model:any,context:any,options:any)=>{requests++;assert.equal(options.apiKey,'synthetic-session-access');return p.provider.streamSimple(model,context,options);}};
 await probeFlueAuthorization(provider);assert.equal(resolved,1);assert.equal(requests,1);
});
