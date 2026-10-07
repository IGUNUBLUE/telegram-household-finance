import test from 'node:test';
import assert from 'node:assert/strict';
import {parseSubscriptionOptions} from '../scripts/lib/subscription-options.ts';
import {createLoginAttempt} from '../scripts/lib/subscription-auth.ts';

test('Headless login keeps the forwarded port in the OAuth redirect',()=>{
 const options=parseSubscriptionOptions(['--no-open','--port','1455']);
 const attempt=createLoginAttempt(`http://127.0.0.1:${options.port}/auth/callback`,'test-vm');
 assert.equal(new URL(attempt.url).searchParams.get('redirect_uri'),'http://127.0.0.1:1455/auth/callback');
 assert.equal(options.noOpen,true);
});

test('Invalid or missing callback ports fail rather than selecting an unreachable redirect',()=>{
 for(const args of [['--port'],['--port','--no-open'],['--port','0'],['--port','80'],['--port','65536'],['--port','1455.5'],['--port','1455oops']]){
  assert.throws(()=>parseSubscriptionOptions(args),/puerto/);
 }
});

test('Mistyped options and missing model names fail before attempting authorization',()=>{
 assert.throws(()=>parseSubscriptionOptions(['--prot','1455']),/Opción/);
 assert.throws(()=>parseSubscriptionOptions(['--model']),/modelo/);
 assert.throws(()=>parseSubscriptionOptions(['--model','--probe-only']),/modelo/);
 assert.equal(parseSubscriptionOptions(['--probe-only','--model','gpt-6-luna']).model,'gpt-6-luna');
 assert.equal(parseSubscriptionOptions([]).port,0);
});
