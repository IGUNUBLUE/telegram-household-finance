import test from 'node:test';import assert from 'node:assert/strict';
import {explicitOpeningBalance,unknownBalance,hasAmountEvidence,asksRegistration} from '../supabase/functions/_shared/flow.ts';
test('Approval of debit account is not evidence of zero opening balance',()=>{
 assert.equal(explicitOpeningBalance('Sí, débito, Banco Alfa'),false);assert.equal(hasAmountEvidence('Sí, débito, Banco Alfa'),false);
 assert.equal(explicitOpeningBalance('Gasté 63000 con Banco Alfa'),false);assert.equal(explicitOpeningBalance('Tengo 178000 en Tarjeta Alfa'),true);
 assert.equal(unknownBalance('No sé el saldo'),true);assert.equal(hasAmountEvidence('ciento setenta y ocho mil'),true);
});
test('Registration questions are distinct from balance reports',()=>{assert.ok(asksRegistration('Quedó registrado?'));assert.ok(asksRegistration('¿Lo registraste?'));assert.equal(asksRegistration('¿Cuánto tengo?'),false);});
