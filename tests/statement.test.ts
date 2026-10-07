import test from 'node:test';import assert from 'node:assert/strict';
import {parseStatementCsv} from '../supabase/functions/_shared/statement.ts';
test('Statement CSV preserves exact signed cents and quoted descriptions',()=>{assert.deepEqual(parseStatementCsv('fecha,valor,descripcion\n2026-09-27,-15000.50,"Mercado, centro"'),[{date:'2026-09-27',delta:'-1500050',memo:'Mercado, centro'}]);});
test('Ambiguous grouping and invalid calendar date are rejected',()=>{assert.throws(()=>parseStatementCsv('fecha;valor;descripcion\n2026-02-30;-15.000;Mercado'));assert.throws(()=>parseStatementCsv('fecha,valor,descripcion\n2026-09-27,NaN,Test'));});
