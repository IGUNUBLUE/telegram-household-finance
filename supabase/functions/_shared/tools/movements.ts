import {z} from 'zod';
import {cop,normalizeAction} from '../domain.ts';
import {pro} from '../pro-domain.ts';
import {conversationGuide,withConversationGuide} from '../conversation-guide.ts';
import {str,id,revision,day,amount,draftFields,rememberDrafts} from './schemas.ts';
import {defineTool,type ToolContext,type Rpc} from './types.ts';
import {proTool} from './pro-tool.ts';
import {routineTool} from './routine-tool.ts';

function transferDirection(fields:any){
 const {from_account,to_account,...rest}=fields;
 if(from_account===undefined&&to_account===undefined)return rest;
 if(rest.kind&&rest.kind!=='transfer')throw Error('Origen y destino explícitos solo aplican a transferencias.');
 if(from_account&&rest.account&&from_account!==rest.account)throw Error('La cuenta de origen contradice account.');
 if(to_account&&rest.other&&to_account!==rest.other)throw Error('La cuenta de destino contradice other.');
 return {...rest,kind:'transfer',...(from_account?{account:from_account}:{}),...(to_account?{other:to_account}:{})};
}

function updateDraft(result:any,context:ToolContext){
 if(result.recovered&&Array.isArray(result.drafts))rememberDrafts(context,result.drafts);
 if(result.draft?.state==='pending'){
  const f=result.draft.fields;
  result.missing_fields=['kind','amount_cop','account','payer','date','scope',...(['income','expense','refund'].includes(f.kind)?['category']:[]),...(['transfer','borrow','lend','repayment','collection'].includes(f.kind)?['other']:[])].filter(k=>!f[k]);
  result.unknown_accounts=[f.account,f.other].filter(v=>v&&!context.accounts.some(a=>a.name===v));
 }
 if(result.draft)rememberDrafts(context,[result.draft]);
 result.conversation_guide=conversationGuide(context);return {result};
}
async function registerDrafts(refs:{draft_id:string;revision:number}[],batch:boolean,context:ToolContext,rpc:Rpc){
 if(new Set(refs.map(r=>r.draft_id)).size!==refs.length)throw Error('No incluyas el mismo movimiento dos veces.');
 const drafts=[];
 for(const ref of refs){
  const {draft}=await rpc('agent:draft_get',{id:context.event_id,draft_id:ref.draft_id});
  if(draft.actor!==context.actor||draft.state!=='pending'||draft.revision!==ref.revision)throw Error('El borrador cambió; consulta su versión actual.');drafts.push(draft);
 }
 rememberDrafts(context,drafts);
 const guide=conversationGuide({...context,drafts});
 if(guide.pending.some((d:any)=>!d.ready))return {result:{status:'needs_clarification',ledger_changed:false,conversation_guide:guide}};
 const actions=[];
 for(let draft of drafts){
  if(!draft.fields.category&&['income','expense','refund'].includes(draft.fields.kind))({draft}=await rpc('agent:draft_save',{id:context.event_id,draft_id:draft.id,revision:draft.revision,fields:{category:'Por clasificar'}}));
  actions.push({...normalizeAction({...draft.fields,type:'post'},context),_draft_id:draft.id,_draft_revision:draft.revision});
 }
 return {action:batch?{type:'batch_post',items:actions}:actions[0]};
}

export const movementsTools=[
 defineTool("verificar_registro",
  "Comprueba estado real de un borrador o del asunto de esta conversación.",
  z.strictObject({
    draft_id: id.optional(),
  }),
  async(args,context,rpc)=>({result:await rpc(args.draft_id?'agent:draft_get':'flow:status',{id:context.event_id,...args})})),
 defineTool("consultar_borradores",
  "Recupera todos tus asuntos pendientes, incluso fuera del historial reciente.",
  z.strictObject({}),
  async(_args,context,rpc)=>{
   const result=await rpc('agent:context',{id:context.event_id});Object.assign(context,result);
   return {result:withConversationGuide({...context,...result})};
  }),
 defineTool("actualizar_borrador",
  "Guarda datos conocidos de UN movimiento pendiente. No registra dinero. Conserva el mismo draft_id y revision para continuarlo; omite ambos solo para un movimiento nuevo. Guarda un gasto antes de resolver una cuenta inexistente. No alteres un borrador por una pregunta conceptual.",
  z.strictObject({
    draft_id: id.optional(),
    revision: revision.optional(),
    fields: draftFields,
  }),
  async(args,context,rpc)=>{
   if((args.draft_id===undefined)!==(args.revision===undefined))throw Error('Indica borrador y versión juntos');
   if(['income','expense','refund'].includes(args.fields.kind??'')&&args.fields.other)throw Error('other es cuenta contraparte; guarda el concepto en memo.');
   return updateDraft(await rpc('agent:draft_save',{id:context.event_id,...args,fields:transferDirection(args.fields)}),context);
  }),
 defineTool("actualizar_asuntos",
  "Conserva TODOS los movimientos mencionados juntos en una llamada, sin registrar dinero. item_key identifica cada concepto nuevo en este mensaje y se conserva en reintentos. Para continuar un pendiente incluye su draft_id/revision. Datos compartidos solo cuando la conversación lo deja claro. Categoría ausente queda Por clasificar.",
  z.strictObject({
    items: z.array(z.strictObject({
      item_key: str(64),
      draft_id: id.optional(),
      revision: revision.optional(),
      fields: draftFields,
    })).min(1).max(8),
  }),
  async(args,context,rpc)=>{
   if(new Set(args.items.map(x=>x.item_key)).size!==args.items.length)throw Error('Cada asunto necesita una clave distinta.');
   for(const item of args.items){
    if((item.draft_id===undefined)!==(item.revision===undefined))throw Error('Indica borrador y versión juntos');
    if(['income','expense','refund'].includes(item.fields.kind??'')&&item.fields.other)throw Error('other es cuenta contraparte; guarda el concepto en memo.');
   }
   const result=await rpc('agent:drafts_save',{id:context.event_id,items:args.items.map(item=>({...item,fields:transferDirection(item.fields)}))});rememberDrafts(context,result.drafts??[]);
   return {result:{...result,conversation_guide:conversationGuide(context)}};
  }),
 defineTool("descartar_borrador",
  "Cancela un borrador explícitamente descartado por su autor.",
  z.strictObject({
    draft_id: id,
    revision: revision,
  }),
  async(args,context,rpc)=>updateDraft(await rpc('agent:draft_cancel',{id:context.event_id,...args}),context)),
 defineTool("distinguir_ingreso_adicional",
  "SOLO cuando el usuario aclara explícitamente que el ingreso pendiente es dinero adicional distinto de la apertura marcada por opening_overlap. Conserva auditoría de esa distinción, sin registrar dinero. No usar si era el mismo sueldo o hay duda.",
  z.strictObject({
    draft_id: id,
    revision: revision,
    opening_transaction_id: id,
  }),
  async(args,context,rpc)=>{
   const result=await rpc('agent:draft_distinct_income',{id:context.event_id,...args});
   if(result.draft)rememberDrafts(context,[result.draft]);
   return {result:{...result,conversation_guide:conversationGuide(context)}};
  }),
 defineTool("registrar_movimiento",
  "Ejecuta un borrador completo solicitado: registra inmediatamente si las cuentas son propias o CREA la solicitud de confirmación del responsable si alguna es ajena. Familiar no autoriza por otro. Guardar datos sin usar esta herramienta no crea esa solicitud. Devuelve acción terminal que el servidor ejecutará.",
  z.strictObject({
    draft_id: id,
    revision: revision,
  }),
  async(args,context,rpc)=>registerDrafts([args],false,context,rpc)),
 defineTool("registrar_movimientos",
  "Ejecuta los borradores completos del pedido: registra los independientes propios y CREA solicitudes para los ajenos, sin medias transferencias. Usa también con cuentas de otro miembro; el servidor exigirá sus aprobaciones. Devuelve acción terminal, nunca simules solicitudes con una respuesta de texto.",
  z.strictObject({
    drafts: z.array(z.strictObject({
      draft_id: id,
      revision: revision,
    })).min(2).max(8),
  }),
  async(args,context,rpc)=>registerDrafts(args.drafts,true,context,rpc)),
];
