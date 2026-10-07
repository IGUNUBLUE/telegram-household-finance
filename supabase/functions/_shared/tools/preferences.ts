import {z} from 'zod';
import {cop,normalizeAction} from '../domain.ts';
import {pro} from '../pro-domain.ts';
import {conversationGuide,withConversationGuide} from '../conversation-guide.ts';
import {str,id,revision,day,amount,rememberDrafts} from './schemas.ts';
import {defineTool,type ToolContext,type Rpc} from './types.ts';
import {proTool} from './pro-tool.ts';
import {routineTool} from './routine-tool.ts';


export const preferencesTools=[
 proTool("guardar_preferencia",
  "preference",
  "Propone una preferencia explícitamente solicitada; no inferir hábitos.",
  z.strictObject({
    merchant: str(80),
    account: str(64),
    category: str(80),
    scope: z.enum(["family", "personal"]),
  })),
 proTool("consultar_preferencias",
  "preferences",
  "Consulta preferencias confirmadas.",
  z.strictObject({})),
 proTool("olvidar_preferencia",
  "forget",
  "Propone eliminar una preferencia.",
  z.strictObject({
    merchant: str(80),
  })),
 proTool("configurar_resumen",
  "summary",
  "Propone activar o pausar el resumen semanal.",
  z.strictObject({
    enabled: z.boolean(),
  })),
];
