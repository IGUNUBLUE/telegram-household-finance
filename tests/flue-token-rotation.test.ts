import {test} from 'node:test';import assert from 'node:assert/strict';
import {createTelegramTokenGuard} from '../scripts/lib/telegram-token-guard.ts';
import {runWorkerServices} from '../scripts/lib/flue-lifecycle.ts';
import {runTelegramPolling} from '../scripts/lib/telegram-polling.ts';
test('rotation stops old polling and intake and requires a fresh service owner',async()=>{
 const stop=new AbortController(),guard=createTelegramTokenGuard('token-A',stop);let current='token-A',admitted=0,drained=false,offset=0;
 await assert.rejects((async()=>{
  await runWorkerServices([
   ()=>runTelegramPolling({readCursor:async()=>offset,saveCursor:async n=>{offset=n;},getUpdates:async()=>{if(offset>=3)stop.abort();return [{update_id:1},{update_id:2}];},admit:async()=>{guard.assertCurrent(current);admitted++;current='token-B';},log:()=>{},sleep:async()=>{}},stop.signal),
   async()=>{if(!stop.signal.aborted)await new Promise<void>(r=>stop.signal.addEventListener('abort',()=>r(),{once:true}));drained=true;},
  ],stop);guard.requireHealthy();
 })(),/restart/i);
 assert.equal(admitted,1);assert.equal(offset,2);assert.equal(drained,true);
 const next=createTelegramTokenGuard('token-B',new AbortController());next.assertCurrent(current);next.requireHealthy();
});
test('tick detects rotation before old intake and fails without leaking tokens',()=>{
 const stop=new AbortController(),guard=createTelegramTokenGuard('secret-A',stop);
 assert.throws(()=>guard.assertCurrent('secret-B'),e=>e instanceof Error&&!/secret-/.test(e.message));assert.equal(stop.signal.aborted,true);assert.throws(()=>guard.requireHealthy(),/restart/i);
});
