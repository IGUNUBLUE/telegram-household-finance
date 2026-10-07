import {z} from 'zod';
import {cop,normalizeAction} from '../domain.ts';
import {pro} from '../pro-domain.ts';
import {conversationGuide,withConversationGuide} from '../conversation-guide.ts';
import {str,id,revision,day,amount,rememberDrafts} from './schemas.ts';
import {defineTool,type ToolContext,type Rpc} from './types.ts';
import {proTool} from './pro-tool.ts';
import {routineTool} from './routine-tool.ts';


export const accountsTools=[
 defineTool("listar_cuentas",
  "Devuelve nombres, tipos y titulares de cuentas existentes. No modifica nada.",
  z.strictObject({}),
  async(_args,context)=>({result:{accounts:context.accounts}}),true),
 defineTool("preparar_cuenta",
  "Propone crear cuenta. Conserva antes los movimientos solicitados que requieren esa cuenta y enlázalos mediante drafts; la misma confirmación autoriza crearlos juntos cuando estén completos. No enlazar pendientes ajenos al pedido. balance_known=false solo si acuerdan dejar saldo sin verificar. amount_cop obligatorio cuando balance_known=true.",
  z.strictObject({
    name: str(64),
    kind: z.enum(["asset", "liability", "receivable"]),
    owner: id,
    date: day,
    balance_known: z.boolean(),
    amount_cop: amount.optional(),
    drafts: z.array(z.strictObject({draft_id:id,revision})).min(1).max(8).optional(),
  }),
  async(args,context,rpc)=>{
   const parsed=normalizeAction({...args,type:'account',amount_cop:args.balance_known?args.amount_cop:'0'},context);
   const linked=[];
   if(args.drafts){
    if(new Set(args.drafts.map(d=>d.draft_id)).size!==args.drafts.length)throw Error('No repitas movimientos.');
    for(const ref of args.drafts){
     const {draft}=await rpc('agent:draft_get',{id:context.event_id,draft_id:ref.draft_id});
     if(draft.actor!==context.actor||draft.state!=='pending'||draft.revision!==ref.revision)throw Error('El movimiento cambió; consulta su versión actual.');
     if(![draft.fields.account,draft.fields.other].includes(parsed.name))throw Error('El movimiento no requiere esa cuenta.');
     linked.push({...ref,fields:draft.fields});
    }
   }
   return {action:pro('stage',{proposal:{...parsed,type:undefined,balance_known:args.balance_known,ownerName:context.members.find(m=>m.id===parsed.owner)?.name,command:'account',...linked.length?{linked_drafts:linked}:{}}})};
  }),
 proTool("preparar_bolsillo",
  "pocket",
  "Propone un bolsillo real dentro de una cuenta propia. amount_cop es dinero que YA existía allí, adicional al disponible de la cuenta. Para separar dinero disponible crea saldo inicial 0 y luego registra la transferencia, nunca una apertura que duplique dinero.",
  z.strictObject({
    account: str(64),
    name: str(40),
    amount_cop: amount,
    date: day,
  })),
 proTool("completar_saldo_inicial",
  "opening_balance",
  "Propone completar el saldo INICIAL desconocido de una cuenta existente del actor. No es ingreso ni gasto. Usa saldo y fecha anteriores a los movimientos registrados; no confundir saldo actual con inicial si ya hay movimientos.",
  z.strictObject({
    account: str(64),
    amount_cop: amount,
    date: day,
  })),
];
