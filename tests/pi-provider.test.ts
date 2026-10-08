import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {toPiCredential,createPiRefresh,createProtectedPiProvider,requireCompletePiMessage} from '../scripts/lib/pi-provider.ts';
import {openSubscriptionSession,writeProtectedJson} from '../scripts/lib/subscription-session.ts';
import type {SubscriptionCredentials} from '../scripts/lib/subscription-auth.ts';

const old:SubscriptionCredentials={issuer:'https://auth.openai.com',subject:'synthetic-user',client_id:'synthetic-client',ext_agent_host_id:'urn:uuid:11111111-1111-4111-8111-111111111111',access_token:'synthetic-access',refresh_token:'synthetic-refresh',id_token:'synthetic-id',scopes:['resource.invoke','chatgpt.tokens.use.direct'],expires_at:0,model:'gpt-5.6-luna'};
test('Luna 6 is selected despite legacy session metadata and never falls back to Luna 5.6',()=>{
 const session={model:old.model,accessToken:async()=>old.access_token} as Parameters<typeof createProtectedPiProvider>[0];
 const provider=createProtectedPiProvider(session,{models:[{slug:'gpt-5.6-luna'},{slug:'gpt-6-luna'}]});
 assert.deepEqual(provider.getModels().map(m=>m.id),['gpt-6-luna']);
 assert.throws(()=>createProtectedPiProvider(session,{models:[{slug:'gpt-5.6-luna'}]}),/catálogo/);
});
test('Pi credential mapping preserves the issued client and required scopes',()=>{
 assert.deepEqual(toPiCredential(old),{type:'oauth',access:old.access_token,refresh:old.refresh_token,expires:old.expires_at,clientId:old.client_id,scopes:old.scopes});
});
test('native Pi refresh rotates once under the protected session and persists before authorization',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'finance-pi-'));let calls=0;
 try{
  await writeProtectedJson(join(directory,'chatgpt-subscription.json'),old);
  const refresh=createPiRefresh(async(c)=>{calls++;assert.equal(c.refresh,old.refresh_token);return {...c,access:'new-access',refresh:'new-refresh',expires:Date.now()+3600000};});
  const session=await openSubscriptionSession({directory,refresh});
  try{
   const provider=createProtectedPiProvider(session,{models:[{slug:'gpt-6-luna'}]});
   const resolve=()=>provider.auth.apiKey!.resolve({ctx:{env:async()=>undefined,fileExists:async()=>false},signal:new AbortController().signal});
   const results=await Promise.all([resolve(),resolve()]);
   assert.equal(results[0]?.auth.apiKey,'new-access');assert.equal(results[1]?.auth.apiKey,'new-access');assert.equal(calls,1);
   const saved=JSON.parse(await readFile(join(directory,'chatgpt-subscription.json'),'utf8'));
   assert.equal(saved.refresh_token,'new-refresh');assert.equal(saved.subject,old.subject);assert.equal(saved.ext_agent_host_id,old.ext_agent_host_id);
  }finally{await session.close();}
 }finally{await rm(directory,{recursive:true,force:true});}
});
test('Pi has no ambient key or alternate model fallback',()=>{
 const session={accessToken:async()=>old.access_token} as Parameters<typeof createProtectedPiProvider>[0];
 assert.throws(()=>createProtectedPiProvider(session,{models:[{slug:'other'}]}),/catálogo/);
 const provider=createProtectedPiProvider(session,{models:[{slug:'gpt-6-luna'},{slug:'other'}]});
 assert.deepEqual(provider.getModels().map(m=>m.id),['gpt-6-luna']);assert.equal(provider.auth.oauth,undefined);
});
test('native refresh failures and malformed grants do not expose provider payloads',async()=>{
 await assert.rejects(createPiRefresh(async()=>{throw Error('secret-token provider body');})(old),e=>e instanceof Error&&!e.message.includes('secret-token'));
 for(const change of [{clientId:'other'},{access:''},{refresh:''},{expires:0},{scopes:['chatgpt.tokens.use.direct']}]){
  await assert.rejects(createPiRefresh(async c=>({...c,expires:Date.now()+3600000,...change}))(old),/autorización/);
 }
});
test('truncated, failed and malformed Pi results are never dispatchable',()=>{
 const message={role:'assistant',content:[{type:'text',text:'Respuesta'}],stopReason:'stop'};
 assert.equal(requireCompletePiMessage(message),message);
 for(const invalid of [null,{...message,stopReason:'length'},{...message,stopReason:'error',errorMessage:'secret-token'},{...message,content:[]},{...message,content:[{type:'toolCall',name:'guardar',arguments:{}}]}]){
  assert.throws(()=>requireCompletePiMessage(invalid),e=>e instanceof Error&&!e.message.includes('secret-token'));
 }
});
test('the Responses transport explicitly supports strict=false so optional arguments stay optional',()=>{
 const provider=createProtectedPiProvider({accessToken:async()=>old.access_token} as any,{models:[{slug:'gpt-6-luna'}]});
 assert.equal(provider.getModels()[0].compat?.supportsStrictMode,true);
});
test('the financial provider requests sequential tool calls',()=>{
 const provider=createProtectedPiProvider({accessToken:async()=>old.access_token} as any,{models:[{slug:'gpt-6-luna'}]});assert.equal(provider.getModels()[0].samplingParams?.parallel_tool_calls,false);
});
