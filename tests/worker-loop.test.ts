import {test} from 'node:test';import assert from 'node:assert/strict';
import {runWorkerLoop} from '../scripts/lib/worker-loop.ts';
test('worker polls idle at five seconds and never indexes during foreground work',async()=>{
 const controller=new AbortController(),waits:number[]=[];let ticks=0,indexes=0,active=0;let now=0;
 await runWorkerLoop({tick:async()=>{assert.equal(active,0);active++;await Promise.resolve();active--;return ++ticks===1;},index:async()=>{indexes++;return false;},clock:()=>now,sleep:async ms=>{waits.push(ms);now+=ms;if(waits.length===3)controller.abort();},log:()=>{}},controller.signal);
 assert.deepEqual(waits,[250,5000,5000]);assert.equal(indexes,1);assert.equal(ticks,3);
});
test('worker uses bounded backoff and never logs provider error content',async()=>{
 const controller=new AbortController(),waits:number[]=[],logs:any[]=[];
 await runWorkerLoop({tick:async()=>{throw Error('fictional-token and financial-private-text');},index:async()=>false,sleep:async ms=>{waits.push(ms);if(waits.length===6)controller.abort();},log:r=>logs.push(r)},controller.signal);
 assert.deepEqual(waits,[5000,10000,20000,40000,60000,60000]);assert.doesNotMatch(JSON.stringify(logs),/fictional-token|financial-private/);
});
test('shutdown finishes in-flight work without a new tick or memory claim',async()=>{
 const controller=new AbortController();let ticks=0,indexes=0,finished=false;
 await runWorkerLoop({tick:async()=>{ticks++;controller.abort();await Promise.resolve();finished=true;return true;},index:async()=>{indexes++;return false;},sleep:async()=>{throw Error('must not wait');},log:()=>{}},controller.signal);
 assert.equal(finished,true);assert.equal(ticks,1);assert.equal(indexes,0);
});
