import test from 'node:test';
import assert from 'node:assert/strict';
import {replyRoute,withTyping} from '../supabase/functions/_shared/experience.ts';
test('Reply uses original message and forum topic, tolerating deleted original',()=>{
 assert.deepEqual(replyRoute({messageId:12,threadId:3}),{reply_parameters:{message_id:12,allow_sending_without_reply:true},message_thread_id:3});
 assert.deepEqual(replyRoute({}),{});
});
test('Typing failure does not fail work and heartbeat stops on completion',async()=>{
 let pulses=0;
 const result=await withTyping(async()=>{pulses++;throw Error('Telegram unavailable');},async()=>{await new Promise(r=>setTimeout(r,35));return 42;},10);
 assert.equal(result,42);assert.ok(pulses>1);const done=pulses;
 await new Promise(r=>setTimeout(r,25));assert.equal(pulses,done);
});
test('Normal reply threads must not scope typing to a forum topic',async()=>{
 const {typingRoute}=await import('../supabase/functions/_shared/experience.ts');
 assert.deepEqual(typingRoute({threadId:62,isTopic:false}),{action:'typing'});
 assert.deepEqual(typingRoute({threadId:62}),{action:'typing'});
 assert.deepEqual(typingRoute({threadId:7,isTopic:true}),{action:'typing',message_thread_id:7});
});
