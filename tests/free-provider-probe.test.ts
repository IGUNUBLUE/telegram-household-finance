import {test} from 'node:test';
import assert from 'node:assert/strict';
import {generateText,tool} from 'ai';
import {z} from 'zod';
import {createFreeProbeModel} from '../supabase/functions/_shared/free-provider-probe.ts';
import {createFinancialModel,privateProviderOptions} from '../supabase/functions/_shared/llm-provider.ts';

test('free probe rejects a paid model before making any request',()=>{
 let requests=0;
 assert.throws(()=>createFreeProbeModel({model:'gpt-6-luna',apiKey:'test',deadline:Date.now()+5000,fetch:async()=>{requests++;return Response.json({});}}),/Modelo de prueba no permitido/);
 assert.equal(requests,0);
});

test('free probe preserves exact decimal tool arguments through AI SDK chat transport',async()=>{
 let body:any,url='';
 const model=createFreeProbeModel({model:'space-bunny-free',apiKey:'test',deadline:Date.now()+5000,fetch:async(input,init)=>{
  url=String(input);body=JSON.parse(String(init?.body));
  return Response.json({id:'test',object:'chat.completion',created:1,model:'space-bunny-free',choices:[{index:0,message:{role:'assistant',content:null,tool_calls:[{id:'test_call',type:'function',function:{name:'prepare',arguments:'{"amount":"2345678.47"}'}}]},finish_reason:'tool_calls'}],usage:{prompt_tokens:10,completion_tokens:10,total_tokens:20}});
 }});
 const result=await generateText({model,maxRetries:0,prompt:'Prepare the exact amount',tools:{prepare:tool({description:'Prepare an amount without writing it.',inputSchema:z.object({amount:z.string()})})}});
 assert.equal(url,'https://opencode.ai/zen/v1/chat/completions');
 assert.equal(body.model,'space-bunny-free');
 assert.deepEqual(result.toolCalls[0].input,{amount:'2345678.47'});
});

test('financial free mode uses Zen free model without calling the Go quota',async()=>{
 let url='',body:any;
 const model=createFinancialModel({mode:'free',apiKey:'test',session:'synthetic',deadline:Date.now()+5000,fetch:async(input,init)=>{
  url=String(input);body=JSON.parse(String(init?.body));
  return Response.json({id:'test',object:'chat.completion',created:1,model:'space-bunny-free',choices:[{index:0,message:{role:'assistant',content:'Listo'},finish_reason:'stop'}],usage:{prompt_tokens:10,completion_tokens:10,total_tokens:20}});
 }});
 const result=await generateText({model,maxRetries:0,prompt:'Di listo'});
 assert.equal(result.text,'Listo');
 assert.equal(url,'https://opencode.ai/zen/v1/chat/completions');
 assert.equal(body.model,'space-bunny-free');
});

test('unavailable free model does not retry using a paid model',async()=>{
 const calls:string[]=[];
 const model=createFinancialModel({mode:'free',apiKey:'test',session:'synthetic',deadline:Date.now()+5000,fetch:async(input)=>{
  calls.push(String(input));return Response.json({error:{message:'Unavailable'}},{status:403});
 }});
 await assert.rejects(()=>generateText({model,maxRetries:0,prompt:'Synthetic request'}));
 assert.deepEqual(calls,['https://opencode.ai/zen/v1/chat/completions']);
});

test('free chat transports production-shaped receipt files and privacy options',async()=>{
 let body:any;
 const model=createFinancialModel({mode:'free',apiKey:'test',session:'synthetic',deadline:Date.now()+5000,fetch:async(_input,init)=>{
  body=JSON.parse(String(init?.body));
  return Response.json({id:'test',object:'chat.completion',created:1,model:'space-bunny-free',choices:[{index:0,message:{role:'assistant',content:'Listo'},finish_reason:'stop'}]});
 }});
 await generateText({model,maxRetries:0,providerOptions:privateProviderOptions,messages:[{role:'user',content:[{type:'file',data:new Uint8Array([1,2,3]),mediaType:'image/jpeg',providerOptions:{openai:{imageDetail:'low'}}}]}]});
 assert.equal(body.store,false);
 assert.equal(body.parallel_tool_calls,false);
 assert.deepEqual(body.messages[0].content,[{type:'image_url',image_url:{url:'data:image/jpeg;base64,AQID',detail:'low'}}]);
});
