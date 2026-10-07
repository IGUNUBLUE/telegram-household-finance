import test from 'node:test';
import assert from 'node:assert/strict';
import {parseModelJson} from '../supabase/functions/_shared/model-json.ts';
test('MiMo JSON accepts a single code fence without extracting arbitrary prose',()=>{
 assert.deepEqual(parseModelJson('```json\n{"amount_cop":"15000"}\n```'),{amount_cop:'15000'});
 assert.deepEqual(parseModelJson('{"type":"clarify"}'),{type:'clarify'});
 assert.throws(()=>parseModelJson('Some text {"type":"post"}'));
});
