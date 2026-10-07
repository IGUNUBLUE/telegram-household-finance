import test from 'node:test';
import assert from 'node:assert/strict';
import {transcribeAudio} from '../supabase/functions/_shared/deepgram.ts';

test('Deepgram sends raw Spanish audio with training opt-out and extracts transcript',async()=>{
 const bytes=new ArrayBuffer(8);
 const request:typeof fetch=async(input,init)=>{
  const url=new URL(String(input));
  assert.equal(url.origin,'https://api.deepgram.com');
  assert.equal(url.searchParams.get('language'),'es');
  assert.equal(url.searchParams.get('model'),'nova-3');
  assert.equal(url.searchParams.get('mip_opt_out'),'true');
  assert.equal(new Headers(init?.headers).get('Authorization'),'Token test-key');
  assert.equal(new Headers(init?.headers).get('Content-Type'),'audio/ogg');
  assert.equal(init?.body,bytes);
  return Response.json({results:{channels:[{alternatives:[{transcript:' Gasté veinte mil pesos. '}]}]}});
 };
 assert.equal(await transcribeAudio(bytes,'test-key','audio/ogg',request),'Gasté veinte mil pesos.');
});
test('Empty or malformed recognition cannot become a ledger instruction',async()=>{
 for(const body of [{},{results:{channels:[{alternatives:[{transcript:'  '}]}]}}]){
  await assert.rejects(transcribeAudio(new ArrayBuffer(0),'key','audio/ogg',async()=>Response.json(body)),/audio sin voz clara/);
 }
});
test('Provider rejection does not expose response contents or credential',async()=>{
 await assert.rejects(transcribeAudio(new ArrayBuffer(0),'secret','audio/ogg',async()=>new Response('sensitive response',{status:401})),{message:'No se pudo transcribir (401)'});
});
