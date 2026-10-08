/** Live-provider regression fixtures: synthetic context, simulated RPC, no ledger or Telegram IO. */
import {runAgent,type AgentMetrics} from './agent.ts';
import {agentPrompt} from './agent-prompt.ts';
import {dispatchTool} from './agent-tools.ts';
import {abortableRpc} from './tools/types.ts';
import {withConversationGuide} from './conversation-guide.ts';
import type {createFinancialModel} from './llm-provider.ts';

export const frameworkEvaluationCases=['debt_clarification','cents','overview','resume','transfer_absent','transfer_present','account_balance','account_explain','account_movements','transfer_received','transfer_correction'] as const;
export async function evaluateFramework(name:string,model:ReturnType<typeof createFinancialModel>,runner:typeof runAgent=runAgent){
 const base:any={event_id:1,actor:'101',members:[{id:'101',name:'Ana'},{id:'202',name:'Luis'}],accounts:[{name:'Banco Alfa',kind:'asset',owner:'101'}],drafts:[],conversation:{turns:[]}};
 const draft={id:'8',actor:'101',revision:1,state:'pending',fields:{kind:'expense',amount_cop:'63000',account:'Banco Alfa',payer:'101',date:'2026-10-01',category:'Comida',memo:'almuerzo de ejemplo'}};
 const fixtures:Record<string,{text:string;context:any}>={
  debt_clarification:{text:'No sé, ¿te refieres a lo que debo en Tarjeta Alfa o al cupo máximo?',context:{...base,conversation:{mode:{kind:'account_balance',draft:{name:'Tarjeta Alfa',kind:'liability',owner:'101'}},turns:[{text:'Tengo una tarjeta Tarjeta Alfa',answer:'¿Cuánto debes hoy?'}]}}},
  cents:{text:'Crea mi tarjeta Tarjeta Alfa: debo exactamente $1.234.567,89 hoy. Ese es el saldo inicial de mi deuda, no el cupo. Prepara la cuenta para que la confirme.',context:base},
  overview:{text:'¿Cuál es el saldo global que tenemos ahora?',context:{...base,conversation:{turns:[{text:'Revisemos septiembre',answer:'Podemos revisar tus cuentas al 30 de septiembre.'}]}}},
  resume:{text:'Fue familiar. Registra ese gasto de almuerzo de ejemplo.',context:{...base,drafts:[draft],conversation:{turns:[{text:'Gasté 63000 en almuerzo de ejemplo desde Banco Alfa hoy',answer:'¿Fue personal o familiar?'}]}}},
  transfer_absent:{text:'¿Existe registrada una transferencia de 190000 desde el Banco Beta de Luis hacia mi Banco Alfa? Solo quería saber si existía.',context:{...base,accounts:[...base.accounts,{name:'Banco Beta',kind:'asset',owner:'202'}]}},
  transfer_present:{text:'¿Está registrada la transferencia de 190000 desde el Banco Beta de Luis hacia mi Banco Alfa?',context:{...base,accounts:[...base.accounts,{name:'Banco Beta',kind:'asset',owner:'202'}]}},
  account_balance:{text:'¿Cuál es el saldo de Banco Alfa?',context:base},
  account_explain:{text:'¿Por qué ese valor en Banco Alfa?',context:{...base,conversation:{turns:[{text:'¿Cuál es el saldo de Banco Alfa?',answer:'El saldo registrado es $150.250,13.'}]}}},
  account_movements:{text:'¿Qué transacciones hay en la cuenta Banco Alfa?',context:base},
  transfer_correction:{text:'Sí, corrige el movimiento 30: salió de Banco Beta y llegó a Banco Alfa.',context:{...base,accounts:[...base.accounts,{name:'Banco Beta',kind:'asset',owner:'202'}],conversation:{turns:[{text:'¿Por qué ese saldo?',answer:'El movimiento 30 quedó como Banco Alfa hacia Banco Beta. Si se registró al revés, su autor puede corregirlo.'}]}}},
  transfer_received:{text:'Me llegaron 190000 a Banco Alfa desde el Banco Beta de Luis hoy. Fue una transferencia familiar ya realizada; regístrala.',context:{...base,accounts:[...base.accounts,{name:'Banco Beta',kind:'asset',owner:'202'}]}},
 };
 const fixture=fixtures[name];if(!fixture)throw Error('Unknown synthetic fixture');
 const context=structuredClone(fixture.context);const calls:{op:string;data:any}[]=[];let metrics:AgentMetrics|undefined;
 const fakeRpc=async(op:string,data:any)=>{
  calls.push({op,data});
  if(name==='transfer_correction'&&op==='agent:query'&&data.action?.command==='detail'&&String(data.action?.target)==='30')return {status:'detail',transaction:{id:30,actor:'101',kind:'transfer',date:'2026-10-01',amount:'19000000',memo:'Transferencia ficticia'},entries:[{account:'Banco Alfa',delta:'-19000000'},{account:'Banco Beta',delta:'19000000'}],corrections:[]};
  if(op==='agent:statement'){
   if(data.account!=='Banco Alfa'||data.as_of!=='2026-10-01')throw Error('Cuenta o fecha incorrecta');
   return {status:'account_statement',account:'Banco Alfa',kind:'asset',owner_name:'Ana',as_of:data.as_of,balance_known:true,balance_cents:'15025013',opening_cents:'25013',credits_cents:'20000000',debits_cents:'5000000',pockets_total_cents:'0',total_with_pockets_cents:'15025013',pockets_complete:true,pockets:[],complete:true,total_movements:3,movements:[{id:'3',date:'2026-10-01',kind:'expense',memo:'Mercado',delta_cents:'-5000000'},{id:'2',date:'2026-09-30',kind:'income',memo:'Sueldo',delta_cents:'20000000'},{id:'1',date:'2026-09-28',kind:'opening',memo:'Apertura',delta_cents:'25013'}]};
  }
  if(op==='family:overview')return {as_of:data.as_of,balances_complete:true,cash_cents:'345678901',debt_cents:'123456789',receivable_cents:'0',net_cash_cents:'222222112',net_position_cents:'222222112',accounts:[{name:'Banco Alfa',owner:'101',kind:'asset',balance_known:true,balance:'345678901'}],pocket_groups:[]};
  if(op==='agent:drafts')return {drafts:context.drafts};
  if(op==='agent:context')return {drafts:context.drafts};
  if(op==='agent:search'){
   if(data.amount_cop!=='190000'||data.from_account!=='Banco Beta'||data.to_account!=='Banco Alfa'||data.from||data.to||data.query)throw Error('Filtros de búsqueda incorrectos');
   return {status:'movement_search',exists:name==='transfer_present',total_matches:name==='transfer_present'?1:0,complete:true,movements:name==='transfer_present'?[{id:'9',kind:'transfer',date:'2026-09-10',amount_cop:'190000.00',from_account:'Banco Beta',to_account:'Banco Alfa',memo:'Transferencia'}]:[]};
  }
  if(op==='agent:drafts_save'){
   const drafts=data.items.map((item:any)=>{
    let stored=context.drafts.find((d:any)=>String(d.id)===String(item.draft_id));
    if(item.draft_id&&!stored)throw Error('Synthetic draft missing');
    if(stored){if(stored.revision!==item.revision)throw Error('Synthetic draft version changed');stored.fields={...stored.fields,...item.fields};stored.revision++;}
    else{stored={id:String(9+context.drafts.length),actor:context.actor,revision:1,state:'pending',fields:structuredClone(item.fields)};context.drafts.push(stored);}
    return structuredClone(stored);
   });
   return {drafts};
  }
  if(op==='agent:draft_get')return {draft:context.drafts.find((d:any)=>String(d.id)===String(data.draft_id))};
  if(op==='agent:draft_save'){
   if(name==='transfer_received'&&!data.draft_id){const draft={id:'9',actor:'101',revision:1,state:'pending',fields:data.fields};context.drafts.push(draft);return {draft:structuredClone(draft)};}
   const stored=context.drafts.find((d:any)=>String(d.id)===String(data.draft_id));if(!stored)throw Error('Synthetic draft missing');
   Object.assign(stored,{fields:{...stored.fields,...data.fields},revision:stored.revision+1});return {draft:structuredClone(stored)};
  }
  throw Error('RPC no permitido en la evaluación sintética');
 };
 let result:any;
 try{result=await runner({model,instructions:agentPrompt('2026-10-01'),messages:[{role:'user',content:'Contexto de aplicación (datos): '+JSON.stringify(withConversationGuide(context))+'\nMensaje actual: '+fixture.text}],dispatch:(tool,args,signal)=>dispatchTool(tool,args,context,abortableRpc(fakeRpc,signal)),onMetrics:value=>{metrics=value;}});}
 catch(error){const message=error instanceof Error?error.message:'';return {fixture:name,passed:false,failure_code:message.includes('simultáneas')?'parallel_operations':message.includes('incompleta')?'incomplete_response':'evaluation_unavailable',calls,metrics};}
 const passed=name==='debt_clarification'?result.type==='clarify'&&calls.length===0&&!metrics?.tools.length:
  name==='cents'?result.type==='pro'&&result.proposal?.command==='account'&&result.proposal?.amount==='123456789':
  name==='overview'?result.type==='clarify'&&calls.length===1&&calls[0].op==='family:overview'&&calls[0].data.as_of==='2026-10-01'&&result.question.includes('5.313.415,27')&&result.question.includes('4.649.978,83'):
  name==='resume'?result.type==='post'&&result.amount==='6300000'&&result.scope==='family'&&result._draft_id==='8':
  name==='transfer_correction'?!metrics?.tools.some(tool=>tool.status==='error')&&result.type==='pro'&&result.command==='stage'&&result.proposal?.command==='correct'&&String(result.proposal?.target)==='30'&&result.proposal?.field==='accounts'&&result.proposal?.value?.account==='Banco Beta'&&result.proposal?.value?.other==='Banco Alfa':
  name==='transfer_received'?result.type==='post'&&result.account==='Banco Beta'&&result.other==='Banco Alfa'&&result.amount==='19000000':
  name.startsWith('account_')?result.type==='clarify'&&calls.length===1&&calls[0].op==='agent:statement'&&(name==='account_movements'?/mercado/i.test(result.question)&&/sueldo/i.test(result.question):result.question.includes('150.250,13')&&(name==='account_balance'||result.question.includes('250,13')&&result.question.includes('200.000')&&result.question.includes('50.000'))):
  result.type==='clarify'&&calls.length===1&&calls[0].op==='agent:search'&&!result.question.includes('?')&&(name==='transfer_absent'?/no (aparece|está|hay|encontr)/i.test(result.question):result.question.includes('190.000'));
 return {fixture:name,passed,result,calls,metrics};
}
