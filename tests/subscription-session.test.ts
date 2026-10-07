import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,readFile,stat,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openSubscriptionSession,writeProtectedJson,sessionStorageError} from '../scripts/lib/subscription-session.ts';
import type {SubscriptionCredentials} from '../scripts/lib/subscription-auth.ts';
const credentials:SubscriptionCredentials={issuer:'https://auth.openai.com',subject:'fictional-user',client_id:'fictional-client',ext_agent_host_id:'urn:uuid:11111111-1111-4111-8111-111111111111',access_token:'fictional-access',refresh_token:'fictional-refresh',id_token:'fictional-id',scopes:['resource.invoke','chatgpt.tokens.use.direct'],expires_at:0,model:'gpt-5.6-luna'};
async function fixture(work:(dir:string)=>Promise<void>){const dir=await mkdtemp(join(tmpdir(),'finance-session-'));try{await writeProtectedJson(join(dir,'chatgpt-subscription.json'),credentials);await work(dir);}finally{await rm(dir,{recursive:true,force:true});}}
test('session refresh is single flight and persisted before callers continue',async()=>fixture(async directory=>{
 let refreshes=0;const session=await openSubscriptionSession({directory,refresh:async old=>{refreshes++;return {...old,access_token:'fictional-new',refresh_token:'fictional-rotated',expires_at:Date.now()+3600000};}});
 try{assert.deepEqual(await Promise.all([session.accessToken(),session.accessToken()]),['fictional-new','fictional-new']);assert.equal(refreshes,1);const stored=JSON.parse(await readFile(join(directory,'chatgpt-subscription.json'),'utf8'));assert.equal(stored.refresh_token,'fictional-rotated');assert.equal((await stat(directory)).mode&0o777,0o700);assert.equal((await stat(join(directory,'chatgpt-subscription.json'))).mode&0o777,0o600);await assert.rejects(openSubscriptionSession({directory}),/curso/);}finally{await session.close();}
 await assert.rejects(stat(join(directory,'subscription.lock')),/ENOENT/);
}));
test('two simultaneous dead-owner recoveries create one session owner',async()=>fixture(async directory=>{
 await writeFile(join(directory,'subscription.lock'),JSON.stringify({pid:99999999,owner:'fictional-dead'}),{mode:0o600});
 const results=await Promise.allSettled([openSubscriptionSession({directory}),openSubscriptionSession({directory})]);
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
 for(const r of results)if(r.status==='fulfilled')await r.value.close();
}));
test('symlinked credentials and permissive files are rejected',async()=>fixture(async directory=>{
 const file=join(directory,'chatgpt-subscription.json');await rm(file);await symlink('outside.json',file);await assert.rejects(openSubscriptionSession({directory}),/proteg/);await rm(file);await writeFile(file,JSON.stringify(credentials),{mode:0o644});await assert.rejects(openSubscriptionSession({directory}),/proteg/);
}));
test('read-only filesystem and denied access are diagnosed as permissions rather than busy',()=>{
 for(const code of ['EROFS','EACCES']){const error=sessionStorageError({code});assert.match(error.message,/permisos/);assert.doesNotMatch(error.message,/curso/);}
});
test('failed persistence retains the previous on-disk session',async()=>fixture(async directory=>{
 const session=await openSubscriptionSession({directory,refresh:async old=>({...old,access_token:'fictional-new',expires_at:Date.now()+3600000}),persist:async()=>{throw Error('fictional write failure');}});
 try{await assert.rejects(session.accessToken(),/disponible/);assert.equal(JSON.parse(await readFile(join(directory,'chatgpt-subscription.json'),'utf8')).access_token,'fictional-access');}finally{await session.close();}
}));
test('close never removes a lock replaced by another owner',async()=>fixture(async directory=>{
 const session=await openSubscriptionSession({directory});await writeFile(join(directory,'subscription.lock'),JSON.stringify({pid:process.pid,owner:'replacement'}));await session.close();assert.equal(JSON.parse(await readFile(join(directory,'subscription.lock'),'utf8')).owner,'replacement');
}));
