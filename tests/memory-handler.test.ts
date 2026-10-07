import {test} from 'node:test';import assert from 'node:assert/strict';
import {createMemoryHandler} from '../supabase/functions/_shared/memory-handler.ts';
const vector=[1,...Array(383).fill(0)];
const request=(body:any,secret='fictional-worker')=>new Request('https://example.test/memory',{method:'POST',headers:{Authorization:'Bearer '+secret},body:JSON.stringify(body)});
test('VPS Edge memory delegates without hidden translation and authenticates native embedding',async()=>{
 let translations=0,rpcs=0;
 const handler=createMemoryHandler({rpc:async()=>{rpcs++;return {lexical:true};},translate:async text=>{translations++;return text;},nativeEmbed:async()=>vector,getSecret:()=> 'fictional-worker',getMode:()=> 'vps_subscription'});
 assert.equal((await handler(request({action:'embed',text:'fictional English'},'wrong'))).status,401);assert.equal(rpcs,0);
 assert.equal((await handler(request({action:'embed',text:'fictional English'}))).status,200);
 assert.equal((await handler(request({action:'embed',text:''}))).status,400);assert.equal((await handler(request({action:'embed',text:'x'.repeat(1801)}))).status,400);
 assert.equal((await (await handler(request({action:'index'}))).json()).delegated,true);assert.equal(rpcs,0);
 assert.deepEqual(await (await handler(request({action:'search',id:1,query:'ficticio'}))).json(),{lexical:true});assert.equal(translations,0);
});
test('native embedding rejects malformed dimension and nonfinite components',async()=>{
 for(const vector of [[1],[Infinity,...Array(383).fill(0)]]){const handler=createMemoryHandler({rpc:async()=>({}),translate:async t=>t,nativeEmbed:async()=>vector,getSecret:()=> 'fictional-worker',getMode:()=> 'edge'});assert.equal((await handler(request({action:'embed',text:'fictional English'}))).status,503);}
});
