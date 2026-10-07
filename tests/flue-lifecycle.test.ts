import {test} from 'node:test';import assert from 'node:assert/strict';
import {runWorkerServices} from '../scripts/lib/flue-lifecycle.ts';
test('a service failure stops admission and waits for the other service to drain',async()=>{
 const stop=new AbortController();let drained=false;
 await assert.rejects(runWorkerServices([
  async()=>{await new Promise(r=>setTimeout(r,10));throw Error('synthetic');},
  async()=>{await new Promise<void>(r=>stop.signal.addEventListener('abort',()=>r(),{once:true}));await new Promise(r=>setTimeout(r,15));drained=true;},
 ],stop));assert.equal(stop.signal.aborted,true);assert.equal(drained,true);
});
test('a normal service completion stops polling and drains all in-flight work',async()=>{
 const stop=new AbortController();let finished=false;
 await runWorkerServices([async()=>{},async()=>{if(!stop.signal.aborted)await new Promise<void>(r=>stop.signal.addEventListener('abort',()=>r(),{once:true}));finished=true;}],stop);
 assert.equal(finished,true);
});
