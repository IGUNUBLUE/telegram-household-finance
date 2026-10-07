import {z} from 'zod';
import {cop,normalizeAction} from '../domain.ts';
import {pro} from '../pro-domain.ts';
import {conversationGuide,withConversationGuide} from '../conversation-guide.ts';
import {str,id,revision,day,amount,rememberDrafts} from './schemas.ts';
import {defineTool,type ToolContext,type Rpc} from './types.ts';
import {proTool} from './pro-tool.ts';
import {routineTool} from './routine-tool.ts';

function overviewForAgent(r:any){
 const {cash_cents,debt_cents,receivable_cents,net_cash_cents,net_position_cents,accounts,pocket_groups,...metadata}=r;
 const account=(a:any)=>{const {balance,...rest}=a;return {...rest,balance_cop:cop(balance)};};
 return {...metadata,totals_cop:{cash:cop(cash_cents),debt:cop(debt_cents),receivable:cop(receivable_cents),net_cash:cop(net_cash_cents),net_position:cop(net_position_cents)},
  accounts:accounts.map(account),pocket_groups:pocket_groups.map((g:any)=>{const {available,pockets_total,total,pockets,...rest}=g;return {...rest,available_cop:cop(available),pockets_total_cop:cop(pockets_total),total_cop:cop(total),pockets:pockets.map(account)};})};
}

export const queriesTools=[
 defineTool('consultar_cuenta',
  'Consulta una cuenta concreta: saldo SQL verificable, apertura, entradas, salidas y movimientos con signo, incluidos aperturas y reversiones. Para explicar por qué tiene ese saldo o listar sus transacciones, usa esta sola herramienta; no recuerdos. Saldo principal excluye bolsillos y sus totales vienen calculados aparte. Movimientos paginados; nunca sumar solo la página para calcular el saldo.',
  z.strictObject({account:str(64),as_of:day,offset:z.number().int().min(0).optional()}),
  async(args,context,rpc)=>{
   const r=await rpc('agent:statement',{...args,id:context.event_id});
   return {result:{...r,balance_cop:cop(r.balance_cents),opening_cop:cop(r.opening_cents),credits_cop:cop(r.credits_cents),debits_cop:cop(r.debits_cents),...(r.kind==='liability'?{debt_increases_cop:cop(r.credits_cents),debt_payments_cop:cop(r.debits_cents)}:{}),pockets_total_cop:cop(r.pockets_total_cents),total_with_pockets_cop:cop(r.total_with_pockets_cents),pockets:r.pockets.map((p:any)=>({...p,balance_cop:cop(p.balance_cents)})),movements:r.movements.map((m:any)=>({...m,delta_cop:cop(m.delta_cents),effect_cop:cop(m.effect_cents??m.delta_cents)}))}};
  },true),
 defineTool('consultar_mis_cuentas',
  'Consulta de solo lectura de las cuentas administradas por quien escribe: dinero, deudas, dinero por cobrar y bolsillos a una fecha. El servidor filtra por el titular del evento antes de calcular totales. Para mis cuentas, mi dinero o cuentas que administro; no panorama de ambos ni filtro familiar/personal de movimientos. No inicia ni guarda revisión.',
  z.strictObject({as_of:day}),
  async(args,context,rpc)=>({result:overviewForAgent(await rpc('family:overview',{...args,id:context.event_id,account_scope:'mine'}))}),true),
 defineTool("consultar_panorama_familiar",
  "Consulta de solo lectura del dinero, deudas y cuentas de ambos a una fecha. Usar cuando pide todas las cuentas, global, del hogar o entre los dos; para mis cuentas usar consultar_mis_cuentas. Calcula con el libro; bolsillos incluidos una sola vez. Nunca inicia ni guarda una revisión. Saldo global sin fecha usa hoy; conserva una fecha explícita del usuario.",
  z.strictObject({
    as_of: day,
  }),
  async(args,context,rpc)=>({result:overviewForAgent(await rpc('family:overview',{...args,id:context.event_id,account_scope:'all'}))}),true),
 defineTool("consultar_revision_familiar",
  "Consulta de solo lectura del avance de las revisiones individuales de un mes terminado (month primer día). No inicia ni guarda revisiones. Distingue no iniciada, en curso, guardada con pendientes y cambios posteriores; no expone borradores de la pareja.",
  z.strictObject({
    month: day,
  }),
  async(args,context,rpc)=>({result:await rpc('family:review_status',{...args,id:context.event_id})}),true),
 defineTool("consultar_saldos",
  "Consulta cálculos SQL. Importes en centavos COP; saldo desconocido no equivale a cero.",
  z.strictObject({
    from: day,
    to: day,
    scope: z.enum(["all", "family", "personal"]),
  }),
  async(args,context,rpc)=>({result:await rpc('report',{...normalizeAction({type:'report',...args},context),actor:context.actor})}),true),
 defineTool("buscar_recuerdos",
  "Busca recuerdos y movimientos por significado. Solo candidatos históricos: verifica registros con ver_movimiento y calcula con consultar_saldos. No implica que una conversación haya registrado dinero.",
  z.strictObject({
    query: str(300),
    kind: z.enum(["all", "transaction", "conversation", "preference"]).optional(),
    from: day.optional(),
    to: day.optional(),
    account: str(64).optional(),
  }),
  async(args,context,rpc)=>({result:await rpc('memory:search',{...args,id:context.event_id})}),true),
 defineTool("buscar_movimientos",
  "Comprueba movimientos en TODO el libro por importe exacto en pesos, tipo y cuentas; no requiere fecha. from_account es origen y to_account destino. Usa los filtros estructurados conocidos, sin repetirlos como query. Devuelve exists y total_matches exhaustivos; complete indica si los 30 resultados mostrados abarcan todos. Solo lectura, excluye aperturas y reversiones.",
  z.strictObject({
    query: str(120).optional(),
    from: day.optional(),
    to: day.optional(),
    kind: z.enum(["income","expense","refund","transfer","borrow","lend","repayment","collection"]).optional(),
    amount_cop: amount.optional(),
    account: str(64).optional(),
    from_account: str(64).optional(),
    to_account: str(64).optional(),
  }),
  async(args,context,rpc)=>({result:await rpc('agent:search',{...args,id:context.event_id})}),true),
 defineTool("exportar_libro",
  "Envía el libro contable en CSV.",
  z.strictObject({}),
  async()=>({action:{type:'export'}})),
 proTool("consultar_proyectos",
  "projects",
  "Consulta ingresos y gastos por proyecto.",
  z.strictObject({
    from: day,
    to: day,
  })),
 proTool("ver_movimiento",
  "detail",
  "Consulta detalle verificable y correcciones de un movimiento.",
  z.strictObject({
    target: id,
  })),
 proTool("consultar_conciliacion",
  "reconcile",
  "Consulta diferencias de un extracto importado.",
  z.strictObject({
    target: id,
  })),
 proTool("exportar_diferencias",
  "reconciliation_export",
  "Envía diferencias de conciliación en CSV.",
  z.strictObject({
    target: id,
  })),
];
