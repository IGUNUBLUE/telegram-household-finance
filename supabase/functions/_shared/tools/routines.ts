import {z} from 'zod';
import {cop,normalizeAction} from '../domain.ts';
import {pro} from '../pro-domain.ts';
import {conversationGuide,withConversationGuide} from '../conversation-guide.ts';
import {str,id,revision,day,amount,rememberDrafts} from './schemas.ts';
import {defineTool,type ToolContext,type Rpc} from './types.ts';
import {proTool} from './pro-tool.ts';
import {routineTool} from './routine-tool.ts';


export const routinesTools=[
 routineTool("crear_recurrente",
  "recurring_create",
  "Programa un gasto mensual explícitamente solicitado por quien lo paga. Nunca registra dinero automáticamente. day 1..31; start es el primer vencimiento, ajustado al último día en meses cortos.",
  z.strictObject({
    label: str(120),
    amount_cop: amount,
    account: str(64),
    category: str(80),
    scope: z.enum(["family", "personal"]),
    day: z.number().int().min(1).max(31),
    start: day,
  })),
 routineTool("actualizar_recurrente",
  "recurring_update",
  "Actualiza una regla propia en una operación; conserva vencimientos ya emitidos. Consulta la regla para conservar los campos no cambiados. day 1..31; start es el primer vencimiento, ajustado al último día en meses cortos.",
  z.strictObject({
    target: id,
    label: str(120),
    amount_cop: amount,
    account: str(64),
    category: str(80),
    scope: z.enum(["family", "personal"]),
    day: z.number().int().min(1).max(31),
    start: day,
  })),
 routineTool("activar_recurrente",
  "recurring_toggle",
  "Pausa o reactiva una regla propia. Los vencimientos pendientes se conservan.",
  z.strictObject({
    target: id,
    enabled: z.boolean(),
  })),
 routineTool("omitir_vencimiento",
  "recurring_skip",
  "Omite SOLO este vencimiento cuando el usuario dice que no aplica. No usar si simplemente aún no pagó.",
  z.strictObject({
    occurrence: id,
  })),
 routineTool("vincular_pago_recurrente",
  "recurring_link",
  "Vincula un gasto ya registrado al vencimiento tras verificar que es el pago correcto; no crea otro gasto.",
  z.strictObject({
    occurrence: id,
    transaction_id: id,
  })),
 routineTool("finalizar_cierre",
  "close_finish",
  "Guarda revisión mensual solo con consentimiento explícito. accept_pending=true requiere aceptar expresamente dejar diferencias/asuntos pendientes; nunca asumir conciliación bancaria.",
  z.strictObject({
    month: day,
    accept_pending: z.boolean(),
  })),
 defineTool("consultar_recurrentes",
  "Consulta tus reglas y vencimientos pendientes.",
  z.strictObject({}),
  async(_args,context,rpc)=>({result:await rpc('routine:context',{id:context.event_id})})),
 defineTool("preparar_pago_recurrente",
  "SOLO cuando confirma que ya pagó: recupera/crea borrador del vencimiento. No registra todavía. date es la fecha REAL del pago, no asumir vencimiento; después actualizar datos cambiados y registrar_movimiento.",
  z.strictObject({
    occurrence: id,
    date: day,
  }),
  async(args,context,rpc)=>({result:await rpc('routine:prepare',{...args,id:context.event_id})})),
 defineTool("revisar_mes",
  "Inicia o retoma revisión de un mes terminado (month primer día). accounts contiene SOLO las cuentas y bolsillos del actor para verificar; report conserva los totales del hogar. Pregunta únicamente sobre esas accounts, nunca sobre cuentas ajenas del contexto general.",
  z.strictObject({
    month: day,
  }),
  async(args,context,rpc)=>({result:await rpc('routine:review',{...args,id:context.event_id})})),
 defineTool("comprobar_saldo_cierre",
  "Compara saldo/deuda de una cuenta PROPIA que su titular confirmó para el último día de ese mes. Nunca verificar cuentas de la pareja ni tratar su cierre como completo. No usa cupo y no ajusta el libro. balance_cop pesos con signo y hasta dos decimales, sin separadores de miles.",
  z.strictObject({
    month: day,
    account: str(64),
    balance_cop: z.string().regex(new RegExp("^-?[0-9]{1,13}(?:[.,][0-9]{1,2})?$")),
  }),
  async(args,context,rpc)=>{
   const account=context.accounts.find(a=>a.name===args.account);
   if(!account||account.owner!==context.actor)throw Error('Solo el titular puede verificar el saldo de esa cuenta en su cierre mensual. Continúa con las cuentas propias de revisar_mes.');
   return {result:await rpc('routine:check',{...args,id:context.event_id})};
  }),
];
