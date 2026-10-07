import test from 'node:test';
import assert from 'node:assert/strict';
import {z} from 'zod';
import {dispatchTool,toolDefinitions} from '../supabase/functions/_shared/agent-tools.ts';

test('All 57 tools have one Zod schema and a domain implementation',async()=>{
 const registry=await import('../supabase/functions/_shared/tools/registry.ts').catch(()=>null);
 assert.ok(registry,'A domain registry must exist');
 assert.equal(registry.financialTools.length,57);
 assert.equal(new Set(registry.financialTools.map((t:any)=>t.name)).size,57);
 assert.deepEqual(registry.financialTools.map((t:any)=>t.name).sort(),toolDefinitions.map(t=>t.name).sort());
 for(const tool of registry.financialTools){assert.ok(tool.inputSchema instanceof z.ZodType);assert.equal(typeof tool.execute,'function');}
});
test('An impossible date is refused before any family query RPC',async()=>{
 let calls=0;
 await assert.rejects(dispatchTool('consultar_panorama_familiar',{as_of:'2026-02-30'},{actor:'101',event_id:1,members:[],accounts:[]},async()=>{calls++;return {};}));
 assert.equal(calls,0);
});
test('Nested tool schemas reject identity injection while retaining exact decimal strings',async()=>{
 const registry=await import('../supabase/functions/_shared/tools/registry.ts').catch(()=>null);assert.ok(registry);
 const tool=registry.financialTools.find((t:any)=>t.name==='actualizar_borrador');assert.ok(tool);const schema=tool.inputSchema;
 const parsed=schema.parse({fields:{kind:'expense',amount_cop:'1234567.89',memo:'Arroz'}});
 assert.equal(parsed.fields.amount_cop,'1234567.89');
 assert.equal(schema.safeParse({fields:{actor:'202',amount_cop:'1'}}).success,false);
 assert.equal(schema.safeParse({actor:'202',fields:{memo:'Arroz'}}).success,false);
 assert.equal(schema.safeParse({fields:{amount_cop:1234567.89}}).success,false);
});
