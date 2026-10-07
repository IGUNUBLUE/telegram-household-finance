import test from 'node:test';import assert from 'node:assert/strict';
(globalThis as any).Deno={env:{get:()=>undefined}};
const {dispatchTool,toolDefinitions}=await import('../supabase/functions/_shared/agent-tools.ts');
const ctx={event_id:1,actor:'101',members:[{id:'101',name:'Alex'},{id:'202',name:'Esposa'}],accounts:[{name:'Banco Alfa',kind:'asset',owner:'101'}],pending_proposals:[]};
test('Movement tool can only register a validated persisted draft, with exact cents',async()=>{
 const rpc=async()=>({draft:{id:'8',actor:'101',revision:2,state:'pending',fields:{kind:'expense',amount_cop:'63000',account:'Banco Alfa',payer:'101',scope:'family',date:'2026-09-28',category:'Comida',memo:'almuerzo de ejemplo'}}});
 const {action}=await dispatchTool('registrar_movimiento',{draft_id:'8',revision:2},ctx,rpc);
 assert.equal(action.amount,'6300000');assert.equal(action._draft_id,'8');
 await assert.rejects(dispatchTool('registrar_movimiento',{draft_id:'8',revision:1},ctx,rpc));
 await assert.rejects(dispatchTool('registrar_movimiento',{draft_id:'8',revision:2,amount_cop:'1'},ctx,rpc));
});
test('Missing scope is clarified instead of inferred and unknown tools are denied',async()=>{
 const rpc=async()=>({draft:{id:'8',actor:'101',revision:2,state:'pending',fields:{kind:'expense',amount_cop:'63000',account:'Banco Alfa',payer:'101',date:'2026-09-28',category:'Comida'}}});
 const incomplete=await dispatchTool('registrar_movimiento',{draft_id:'8',revision:2},ctx,rpc);
 assert.equal(incomplete.action,undefined);assert.equal(incomplete.result.status,'needs_clarification');
 assert.deepEqual(incomplete.result.conversation_guide.pending[0].missing_fields,['scope']);
 await assert.rejects(dispatchTool('execute_sql',{},ctx,rpc));
 assert.ok(!toolDefinitions.some((x:any)=>x.name==='operacion_financiera'));
});
test('Account creation never supplies a guessed initial balance',async()=>{
 const args={name:'Tarjeta Alfa',kind:'liability',owner:'101',date:'2026-09-28',balance_known:false};
 const {action}=await dispatchTool('preparar_cuenta',args,ctx,async()=>null);
 assert.equal(action.proposal.balance_known,false);assert.equal(action.proposal.amount,'0');
 await assert.rejects(dispatchTool('preparar_cuenta',{...args,balance_known:true},ctx,async()=>null));
});
test('A tool cannot inject an actor or confirm another person proposal',async()=>{
 await assert.rejects(dispatchTool('actualizar_borrador',{fields:{memo:'hola'},actor:'202'},ctx,async()=>null));
 await assert.rejects(dispatchTool('confirmar_propuesta',{target:'9'},ctx,async()=>null));
});
test('Semantic search binds trusted event and cannot inject actor or embedding',async()=>{
 let called:any;await dispatchTool('buscar_recuerdos',{query:'lo del gato'},ctx,async(op,data)=>{called={op,data};return {matches:[]};});
 assert.deepEqual(called,{op:'memory:search',data:{query:'lo del gato',id:1}});
 await assert.rejects(dispatchTool('buscar_recuerdos',{query:'gato',actor:'202'},ctx,async()=>null));
 await assert.rejects(dispatchTool('buscar_recuerdos',{query:'gato',id:2},ctx,async()=>null));
});
test('Recurring and closing tools preserve exact amounts and trusted actors',async()=>{
 const {action}=await dispatchTool('crear_recurrente',{label:'Arriendo',amount_cop:'900000',account:'Banco Alfa',category:'Vivienda',scope:'family',day:5,start:'2026-10-05'},ctx,async()=>null);
 assert.equal(action.type,'routine');assert.equal(action.amount_cop,'900000');
 await assert.rejects(dispatchTool('crear_recurrente',{label:'Arriendo',amount_cop:'900000',account:'Banco Alfa',category:'Vivienda',scope:'family',day:32,start:'2026-10-05'},ctx,async()=>null));
 let call:any;await dispatchTool('comprobar_saldo_cierre',{month:'2026-08-01',account:'Banco Alfa',balance_cop:'-1500'},ctx,async(op,data)=>{call={op,data};return {};});
 assert.equal(call.data.id,1);assert.equal(call.data.balance_cop,'-1500');
 await assert.rejects(dispatchTool('preparar_pago_recurrente',{occurrence:'2',date:'2026-09-28',actor:'202'},ctx,async()=>null));
});
test('Tarjeta Alfa opening debt preserves all cents without rounding',async()=>{
 const {action}=await dispatchTool('preparar_cuenta',{name:'Tarjeta Alfa',kind:'liability',owner:'101',date:'2026-09-28',balance_known:true,amount_cop:'1234567.89'},ctx,async()=>null);
 assert.equal(action.proposal.amount,'123456789');
});
test('Completing an initial balance stages exact cents for an existing account',async()=>{
 const {action}=await dispatchTool('completar_saldo_inicial',{account:'Banco Alfa',amount_cop:'250.13',date:'2026-09-28'},ctx,async()=>null);
 assert.equal(action.command,'stage');assert.equal(action.proposal.amount,'25013');
 await assert.rejects(dispatchTool('completar_saldo_inicial',{account:'Missing',amount_cop:'250.13',date:'2026-09-28'},ctx,async()=>null));
});
test('Pocket tool proposes a linked initial balance in exact cents',async()=>{
 const {action}=await dispatchTool('preparar_bolsillo',{account:'Banco Alfa',name:'Regalos',amount_cop:'1400.34',date:'2026-09-28'},ctx,async()=>null);
 assert.equal(action.command,'stage');assert.equal(action.proposal.command,'pocket');assert.equal(action.proposal.amount,'140034');
});
test('Explicit transfer endpoints store origin first even when the speaker received it',async()=>{
 let saved:any;
 await dispatchTool('actualizar_borrador',{fields:{kind:'transfer',from_account:'Banco Beta',to_account:'Banco Alfa',amount_cop:'190000'}},ctx,async(_op,data)=>{saved=data;return {};});
 assert.equal(saved.fields.account,'Banco Beta');assert.equal(saved.fields.other,'Banco Alfa');
 assert.equal(saved.fields.from_account,undefined);assert.equal(saved.fields.to_account,undefined);
});
test('Conflicting explicit transfer endpoints are rejected before persistence',async()=>{
 let calls=0;
 await assert.rejects(dispatchTool('actualizar_borrador',{fields:{kind:'transfer',from_account:'Banco Beta',to_account:'Banco Alfa',account:'Banco Alfa',other:'Banco Beta'}},ctx,async()=>{calls++;return {};}),/origen/);
 assert.equal(calls,0);
});
test('Batch transfer endpoint normalization preserves unrelated pending fields',async()=>{
 let data:any;
 await dispatchTool('actualizar_asuntos',{items:[{item_key:'transfer',draft_id:'8',revision:2,fields:{to_account:'Banco Alfa',memo:'Llegó a Banco Alfa'}}]},ctx,async(_op,args)=>{data=args;return {drafts:[]};});
 assert.deepEqual(data.items[0],{item_key:'transfer',draft_id:'8',revision:2,fields:{kind:'transfer',other:'Banco Alfa',memo:'Llegó a Banco Alfa'}});
 assert.equal(Object.hasOwn(data.items[0].fields,'account'),false);assert.equal(Object.hasOwn(data.items[0].fields,'amount_cop'),false);
});
test('Transfer correction stages both explicit endpoints in a single proposal',async()=>{
 const context={...ctx,accounts:[...ctx.accounts,{name:'Banco Beta',kind:'asset',owner:'202'}]};
 const r=await dispatchTool('proponer_correccion',{target:'30',field:'accounts',from_account:'Banco Beta',to_account:'Banco Alfa'},context,async()=>null);
 assert.deepEqual(r.action.proposal,{command:'correct',target:'30',field:'accounts',value:{account:'Banco Beta',other:'Banco Alfa'}});
 await assert.rejects(dispatchTool('proponer_correccion',{target:'30',field:'accounts',from_account:'Banco Alfa',to_account:'Banco Alfa'},context,async()=>null));
});
