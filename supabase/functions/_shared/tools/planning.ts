import {z} from 'zod';
import {cop,normalizeAction} from '../domain.ts';
import {pro} from '../pro-domain.ts';
import {conversationGuide,withConversationGuide} from '../conversation-guide.ts';
import {str,id,revision,day,amount,rememberDrafts} from './schemas.ts';
import {defineTool,type ToolContext,type Rpc} from './types.ts';
import {proTool} from './pro-tool.ts';
import {routineTool} from './routine-tool.ts';


export const planningTools=[
 defineTool("preparar_presupuesto",
  "Registra un presupuesto solicitado para mes y categoría.",
  z.strictObject({
    category: str(80),
    scope: z.enum(["family", "personal"]),
    beneficiary: id.optional(),
    month: day,
    amount_cop: amount,
  }),
  async(args,context)=>({action:normalizeAction({type:'budget',...args},context)})),
 defineTool("crear_recordatorio",
  "Guarda un recordatorio futuro solicitado, sin registrar movimiento.",
  z.strictObject({
    label: str(120),
    date: day,
  }),
  async(args,context)=>({action:normalizeAction({type:'reminder',...args},context)})),
 proTool("consultar_plan",
  "planning",
  "Calcula disponibilidad descontando reservas y compromisos con SQL.",
  z.strictObject({
    to: day,
  })),
 proTool("preparar_compromiso",
  "commitment",
  "Propone reservar un compromiso futuro; no registra un gasto.",
  z.strictObject({
    label: str(120),
    amount_cop: amount,
    due: day,
    project: str(60),
  })),
 proTool("preparar_meta",
  "goal",
  "Propone una meta de ahorro; no mueve dinero.",
  z.strictObject({
    label: str(120),
    amount_cop: amount,
    reserved_cop: amount,
    project: str(60),
  })),
 proTool("cambiar_reserva",
  "reserve",
  "Propone cambiar la reserva de una meta.",
  z.strictObject({
    target: id,
    amount_cop: amount,
  })),
 proTool("cerrar_compromiso",
  "complete_commitment",
  "Propone liberar un compromiso, sin registrar un pago.",
  z.strictObject({
    target: id,
  })),
 proTool("asignar_proyecto",
  "project",
  "Propone asignar un movimiento a un proyecto.",
  z.strictObject({
    target: id,
    project: str(60),
  })),
 proTool("conciliar_linea",
  "match",
  "Propone enlazar una línea de extracto con un movimiento.",
  z.strictObject({
    line: id,
    target: id,
  })),
 proTool("importar_extracto",
  "statement",
  "Propone importar filas de un extracto; no registra gastos.",
  z.strictObject({
    account: str(64),
    rows: z.array(z.strictObject({
      date: day,
      amount_cop: z.string().regex(new RegExp("^-?[0-9]{1,12}(?:[.,][0-9]{1,2})?$")),
      memo: str(240),
    })).min(1).max(200),
  })),
 proTool("consultar_pendientes",
  "pending",
  "Consulta asuntos pendientes de conversación.",
  z.strictObject({})),
 proTool("dejar_conversacion",
  "cancel",
  "Cancela propuestas y conversación cuando lo pidan explícitamente; los borradores se descartan por separado.",
  z.strictObject({})),
];
