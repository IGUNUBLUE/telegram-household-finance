import test from 'node:test';import assert from 'node:assert/strict';
import {socialIntent,resolveConfirmation} from '../supabase/functions/_shared/natural.ts';
test('Natural onboarding does not intercept a message containing account details',()=>{
 assert.equal(socialIntent('Ayúdame a empezar'),'setup');assert.equal(socialIntent('Quiero agregar una cuenta'),'setup');assert.equal(socialIntent('Tengo 178000 en Tarjeta Alfa'),null);
});
test('Confirmation requires a unique actor-scoped pending proposal and no qualifiers',()=>{
 assert.deepEqual(resolveConfirmation('Sí, está bien',[{id:4}],undefined),{command:'confirm',target:4});
 assert.equal(resolveConfirmation('Sí, pero cambia el monto',[{id:4}],undefined),null);
 assert.equal(resolveConfirmation('Sí',[{id:4},{id:5}],undefined)?.command,'ambiguous');
 assert.deepEqual(resolveConfirmation('Confirmo',[{id:4},{id:5}],5),{command:'confirm',target:5});
 assert.equal(resolveConfirmation('Sí',[],undefined)?.command,'missing');
});
