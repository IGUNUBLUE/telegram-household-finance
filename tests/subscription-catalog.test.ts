import test from 'node:test';
import assert from 'node:assert/strict';
import {selectSubscriptionModel} from '../scripts/lib/subscription-catalog.ts';
const catalog={models:[{slug:'gpt-6-luna',display_name:'GPT-6 Luna',visibility:'list'},{slug:'gpt-6-sol',display_name:'GPT-6 Sol',visibility:'list'}]};
test('A model absent from the plan catalog reports actual choices instead of asking the user to guess',()=>{
 assert.throws(()=>selectSubscriptionModel(catalog,'gpt-6.1-sol'),error=>{
  assert.match(String(error),/no aparece/);
  assert.match(String(error),/gpt-6-luna, gpt-6-sol/);
  return true;
 });
 assert.equal(selectSubscriptionModel(catalog,'gpt-6-luna'),'gpt-6-luna');
});
test('A malformed or empty model catalog is distinguished from a missing selected model',()=>{
 assert.throws(()=>selectSubscriptionModel({data:[{id:'gpt-6.1-sol'}]},'gpt-6.1-sol'),/formato/);
 assert.throws(()=>selectSubscriptionModel({models:[]},'gpt-6.1-sol'),/vacío/);
});
test('Catalog diagnostics do not print arbitrary server fields or unsafe model labels',()=>{
 assert.throws(()=>selectSubscriptionModel({models:[...catalog.models,{slug:'bad\nsecret-token',display_name:'secret-token'}],access_token:'secret-token'},'missing'),error=>{
  assert.match(String(error),/gpt-6-luna, gpt-6-sol/);
  assert.doesNotMatch(String(error),/secret-token/);
  return true;
 });
});
test('An invalid requested model does not inject untrusted text into diagnostics',()=>{
 assert.throws(()=>selectSubscriptionModel(catalog,'bad\nTOKEN_SENTINEL'),error=>{
  assert.match(String(error),/gpt-6-luna, gpt-6-sol/);
  assert.doesNotMatch(String(error),/TOKEN_SENTINEL/);
  return true;
 });
});
