import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createFlueInterpretationServices} from '../scripts/lib/flue-interpretation.ts';

test('Flue interpretation binds a trusted attempt and excludes its lease token from model data',async()=>{
 const requests:any[]=[];
 const services=createFlueInterpretationServices({runtime:{run:async r=>{requests.push(r);return {type:'clarify',question:'Listo'};}},rpc:async()=>({}),today:()=> '2026-10-02',telegramFile:async()=>new Uint8Array([1,2]).buffer});
 await services.interpret({text:'¿Cuál es mi saldo?',photo:'synthetic-photo'},{actor:'101',event_id:2,event_attempt_token:'protected-lease',members:[],accounts:[]});
 assert.doesNotMatch(requests[0].text,/protected-lease|event_attempt_token/);assert.deepEqual(requests[0].image,new Uint8Array([1,2]));
 await services.interpret({text:'otra pregunta'},{actor:'202',event_id:2,event_attempt_token:'protected-lease',members:[],accounts:[]});assert.notEqual(requests[0].key,requests[1].key);
 await assert.rejects(services.interpret({text:'mensaje'},{actor:'101',event_id:2}),/evento/);
});
test('narration has no financial tools or dispatch',async()=>{
 const requests:any[]=[];
 const services=createFlueInterpretationServices({runtime:{run:async r=>{requests.push(r);return {type:'clarify',question:'Account balance'};}},rpc:async()=>{throw Error('must not call');},today:()=> '2026-10-02',telegramFile:async()=>new ArrayBuffer(0)});
 await services.narrate({status:'ok',transaction_id:1},{event_attempt_token:'private',actor:'101',members:[],accounts:[]});
 for(const r of requests){assert.equal(r.tools,false);assert.equal(r.maxSteps,1);assert.equal(r.timeoutMs,12000);assert.doesNotMatch(r.text,/private/);await assert.rejects(r.dispatch('any',{}),/herramientas/);}
});
