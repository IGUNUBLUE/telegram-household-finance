import {test} from 'node:test';import assert from 'node:assert/strict';
import {createLocalEmbedding,LOCAL_EMBEDDING_REVISION} from '../scripts/lib/local-embedding.ts';
const vector=Array.from({length:384},(_,i)=>i===0?1:0);
test('local embeddings pin model revision and use mean pooling and normalization',async()=>{
 let loading=0;const calls:any[]=[];
 const embed=createLocalEmbedding('/tmp/synthetic-model-cache',async options=>{loading++;assert.match(options.revision,/^[a-f0-9]{40}$/);assert.equal(options.dtype,'q8');assert.deepEqual(options.session_options,{intraOpNumThreads:1,interOpNumThreads:1,executionMode:'sequential'});return async(text,args)=>{calls.push({text,args});return {tolist:()=>[vector]};};});
 assert.deepEqual(await Promise.all([embed('ingreso',undefined,'query'),embed('gasto',undefined,'passage')]),[vector,vector]);assert.equal(loading,1);assert.deepEqual(calls.map(c=>c.text),['query: ingreso','passage: gasto']);assert.deepEqual(calls[0].args,{pooling:'mean',normalize:true,truncation:true,max_length:512});assert.equal(LOCAL_EMBEDDING_REVISION.length,40);
});
test('invalid vectors and late results cannot enter memory storage',async()=>{
 const stop=new AbortController();const embed=createLocalEmbedding('/tmp/synthetic-model-cache',async()=>async()=>{stop.abort();return {tolist:()=>[vector]};});
 await assert.rejects(embed('income',stop.signal));
 const malformed=createLocalEmbedding('/tmp/synthetic-model-cache',async()=>async()=>({tolist:()=>[[1,2]]}));await assert.rejects(malformed('income'),/Vector/);
 await assert.rejects(malformed(''));await assert.rejects(malformed('x'.repeat(1801)));
});
test('model loading failure can retry without retaining a rejected initializer',async()=>{
 let attempts=0;const embed=createLocalEmbedding('/tmp/synthetic-model-cache',async()=>{if(++attempts===1)throw Error('download');return async()=>({tolist:()=>[vector]});});
 await assert.rejects(embed('income'));assert.deepEqual(await embed('income'),vector);assert.equal(attempts,2);
});
