import test from 'node:test';import assert from 'node:assert/strict';
import {embedText,validEmbedding} from '../supabase/functions/_shared/memory.ts';
const vector=Array.from({length:384},(_,i)=>i===0?1:0);
test('Embedding translation preserves original input and validates native vector',async()=>{
 let captured:any;
 const result=await embedText('comida para el gato',async text=>{captured=text;return 'food for the cat';},async text=>{assert.equal(text,'food for the cat');return vector;});
 assert.equal(captured,'comida para el gato');assert.deepEqual(result,vector);
});
test('Invalid model/vector output cannot poison the index',async()=>{
 for(const value of [null,[],Array(384).fill(0),Array(384).fill(NaN),Array(384).fill(1)])assert.throws(()=>validEmbedding(value));
 await assert.rejects(embedText('gato',async()=>'',async()=>vector));
 await assert.rejects(embedText('gato',async()=>{throw Error('provider down');},async()=>vector));
});
