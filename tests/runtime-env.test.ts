import {test} from 'node:test';
import assert from 'node:assert/strict';
import {getRuntimeEnv} from '../supabase/functions/_shared/runtime-env.ts';
test('shared IO loads in Node without an emulated Deno runtime',async()=>{
 process.env.FINANCE_RUNTIME_TEST='node';
 assert.equal(getRuntimeEnv('FINANCE_RUNTIME_TEST'),'node');
 const io=await import('../supabase/functions/_shared/io.ts');
 assert.equal(typeof io.rpc,'function');
 delete process.env.FINANCE_RUNTIME_TEST;
});
