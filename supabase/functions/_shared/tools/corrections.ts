import {z} from 'zod';
import {cop,normalizeAction} from '../domain.ts';
import {pro} from '../pro-domain.ts';
import {conversationGuide,withConversationGuide} from '../conversation-guide.ts';
import {str,id,revision,day,amount,rememberDrafts} from './schemas.ts';
import {defineTool,type ToolContext,type Rpc} from './types.ts';
import {proTool} from './pro-tool.ts';
import {routineTool} from './routine-tool.ts';

function proposalAction(command:string,target:string,context:ToolContext){
 if(!context.pending_proposals?.some(p=>String(p.id)===target))throw Error('La propuesta no está pendiente para esta persona.');
 return {action:pro(command,{target})};
}

export const correctionsTools=[
 defineTool("confirmar_propuesta",
  "Confirma una propuesta pendiente propia ante consentimiento inequívoco. Nunca cuando están haciendo una pregunta o pidiendo cambiar datos.",
  z.strictObject({
    target: id,
  }),
  async(args,context)=>proposalAction('confirm',args.target,context)),
 defineTool("cancelar_propuesta",
  "Cancela una propuesta pendiente propia.",
  z.strictObject({
    target: id,
  }),
  async(args,context)=>proposalAction('cancel_proposal',args.target,context)),
 defineTool("confirmar_duplicado",
  "Registra otro movimiento igual solo si el usuario afirma expresamente que es otro gasto real.",
  z.strictObject({
    target: id,
  }),
  async(args,context,rpc)=>{
   const pending=await rpc('pending',{id:args.target});
   if(pending?.status!=='pending'||pending.actor!==context.actor||pending.action?.type!=='post')throw Error('Duplicado pendiente no disponible');
   return {action:{...pending.action,confirm_duplicate:true,pending_event_id:args.target}};
  }),
 proTool("proponer_correccion",
  "correct",
  "Propone corregir monto o cuenta de un movimiento registrado por el actor; conserva auditoría. Para corregir la dirección de una transferencia usa field=accounts, from_account y to_account juntos. Solo su autor puede hacerlo.",
  z.strictObject({
    target: id,
    field: z.enum(["amount", "account", "accounts"]),
    amount_cop: amount.optional(),
    account: str(64).optional(),
    from_account: str(64).optional(),
    to_account: str(64).optional(),
  })),
 proTool("proponer_reversion",
  "undo",
  "Propone deshacer un movimiento registrado por el actor con contrapartida; solo su autor puede hacerlo y nunca elimina el historial.",
  z.strictObject({
    target: id,
  })),
];
