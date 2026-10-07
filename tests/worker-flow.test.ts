import test from 'node:test';import assert from 'node:assert/strict';
import {needsNarration,drainEvents,deliverIndependently} from '../supabase/functions/_shared/worker-flow.ts';
test('Exact receipts and previews skip extra model calls; account continuation retains them',()=>{
 assert.equal(needsNarration({status:'ok',receipt:{amount:'12319'}}),false);
 assert.equal(needsNarration({status:'preview'}),false);
 assert.equal(needsNarration({status:'ok',account_created:true}),false);
 assert.equal(needsNarration({status:'ok',account_created:true,account_name:'Nueva',linked_pending:['1']},{drafts:[{id:'1',state:'pending',fields:{account:'Nueva'}}]}),true);
});
test('A committed payment can guide the next pending item without repeating a completed one',()=>{
 const result={status:'ok',receipt:{amount:'8800300'}};
 assert.equal(needsNarration(result,{drafts:[{id:'1',state:'pending',fields:{memo:'Ibis'}}],turn_focus:{draft_ids:['1']}}),true);
 assert.equal(needsNarration(result,{drafts:[{state:'completed'}]}),false);
 assert.equal(needsNarration({...result,narration:'Ya está'},{drafts:[{state:'pending'}]}),false);
});
test('Drain processes consecutive messages and hands off when start budget is exhausted',async()=>{
 let calls=0;const result=await drainEvents(async()=>++calls<=2,()=>0);assert.equal(calls,3);assert.equal(result.handoff,false);
 let clock=0;calls=0;const bounded=await drainEvents(async()=>{calls++;clock+=25000;return true;},()=>clock);assert.equal(calls,1);assert.equal(bounded.handoff,true);
});
test('Failed delivery is rescheduled independently and next response still sends',async()=>{
 const items=[{id:1},{id:2}];const sent:number[]=[],failed:number[]=[];
 await deliverIndependently(async()=>items.shift(),async i=>{if(i.id===1)throw Error('Telegram failed');sent.push(i.id);},async i=>{failed.push(i.id);},()=>0);
 assert.deepEqual(sent,[2]);assert.deepEqual(failed,[1]);
});
