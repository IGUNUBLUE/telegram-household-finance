import test from 'node:test';
import assert from 'node:assert/strict';
import {routineReply} from '../supabase/functions/_shared/conversation.ts';
test('Reviewed social replies tolerate accents and punctuation',()=>{
 assert.ok(routineReply('¡Hola!'));
 assert.ok(routineReply('¡Buenos días!'));
 assert.ok(routineReply('Muchas gracias.'));
 assert.notEqual(routineReply('hola',0),routineReply('hola',1));
});
test('Greetings combined with financial intent always reach the LLM',()=>{
 for(const text of ['Hola, gasté 15000 en mercado','Gracias, pero ese saldo está mal','Buenas, ¿cuánto debo?','hola pagué la tarjeta','Necesito ayuda con un gasto'])assert.equal(routineReply(text),null);
});
