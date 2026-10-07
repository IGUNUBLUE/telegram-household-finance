import {test} from 'node:test';import assert from 'node:assert/strict';
import {pollTelegramBatch,runTelegramPolling,createTelegramPollingSource} from '../scripts/lib/telegram-polling.ts';
import {mkdtemp,rm} from 'node:fs/promises';import {join} from 'node:path';import {tmpdir} from 'node:os';import {writeProtectedJson,readProtectedJson} from '../scripts/lib/subscription-session.ts';
test('polling advances only after durable admission and preserves an update on transient failure',async()=>{
 const admitted:number[]=[],saved:number[]=[];let cursor=4;
 const deps={readCursor:async()=>cursor,saveCursor:async(n:number)=>{saved.push(n);cursor=n;},getUpdates:async()=>[{update_id:4},{update_id:5},{update_id:6}],admit:async(u:any)=>{if(u.update_id===5)throw Error('synthetic temporary failure');admitted.push(u.update_id);},log:()=>{}};
 await assert.rejects(pollTelegramBatch(deps,new AbortController().signal));assert.deepEqual(admitted,[4]);assert.deepEqual(saved,[5]);
 deps.admit=async u=>{admitted.push(u.update_id);};await pollTelegramBatch(deps,new AbortController().signal);assert.deepEqual(admitted,[4,5,6]);assert.equal(cursor,7);
});
test('validated unordered batches cannot skip an unhandled update',async()=>{
 let cursor=4;const admitted:number[]=[];
 await pollTelegramBatch({readCursor:async()=>cursor,saveCursor:async n=>{cursor=n;},getUpdates:async()=>[{update_id:6},{update_id:4},{update_id:5},{update_id:5}],admit:async u=>{admitted.push(u.update_id);},log:()=>{}},new AbortController().signal);
 assert.deepEqual(admitted,[4,5,6]);assert.equal(cursor,7);
});
test('protected polling cursor expires before requesting a lower id after inactivity',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'finance-cursor-'));const file=join(directory,'cursor.json');
 try{
  const offsets:number[]=[];let clock=Date.now();const send:typeof fetch=async(_url,init)=>{offsets.push(JSON.parse(String(init?.body)).offset);return new Response(JSON.stringify({ok:true,result:[{update_id:2}]}),{headers:{'content-type':'application/json'}});};
  const source=createTelegramPollingSource('123:synthetic',file,send,()=>clock);const admitted:number[]=[];
  await writeProtectedJson(file,{offset:900,confirmedAt:clock-8*86400000});
  await pollTelegramBatch({...source,admit:async u=>{admitted.push(u.update_id);},log:()=>{}},new AbortController().signal);
  assert.deepEqual(offsets,[0]);assert.deepEqual(admitted,[2]);assert.deepEqual(await readProtectedJson(file),{offset:3,confirmedAt:clock});assert.equal(await source.readCursor(),3);
  clock+=86400000;assert.equal(await source.readCursor(),0);
  await writeProtectedJson(file,{offset:900});assert.equal(await source.readCursor(),0);
 }finally{await rm(directory,{recursive:true,force:true});}
});
test('a cursor persistence failure replays an already admitted update rather than losing it',async()=>{
 let admissions=0,fail=true,cursor=0;
 const deps={readCursor:async()=>cursor,saveCursor:async(n:number)=>{if(fail)throw Error();cursor=n;},getUpdates:async()=>[{update_id:2}],admit:async()=>{admissions++;},log:()=>{}};
 await assert.rejects(pollTelegramBatch(deps,new AbortController().signal));assert.equal(cursor,0);fail=false;await pollTelegramBatch(deps,new AbortController().signal);assert.equal(admissions,2);assert.equal(cursor,3);
});
test('invalid ids never advance the cursor and shutdown stops further admission',async()=>{
 const stop=new AbortController();let count=0,cursor=1;
 const deps={readCursor:async()=>cursor,saveCursor:async(n:number)=>{cursor=n;},getUpdates:async()=>[{update_id:1},{update_id:2}],admit:async()=>{count++;stop.abort();},log:()=>{}};
 await pollTelegramBatch(deps,stop.signal);assert.equal(count,1);assert.equal(cursor,2);
 await assert.rejects(pollTelegramBatch({...deps,getUpdates:async()=>[{update_id:-1}]},new AbortController().signal));
});
test('polling retry logs never include update data, tokens or transport bodies',async()=>{
 const stop=new AbortController(),logs:string[]=[];
 await runTelegramPolling({readCursor:async()=>0,saveCursor:async()=>{},getUpdates:async()=>{throw Error('secret-token');},admit:async()=>{},log:s=>logs.push(s),sleep:async()=>{stop.abort();}},stop.signal);
 assert.equal(logs.length,1);assert.doesNotMatch(logs.join(),/secret-token/);
});
