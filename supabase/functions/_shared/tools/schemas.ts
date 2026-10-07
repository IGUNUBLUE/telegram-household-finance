import {z} from 'zod';

export const str=(max=120)=>z.string().min(1).max(max);
export const id=z.string().regex(/^[0-9]+$/);
export const revision=z.number().int().min(1);
export const day=z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value=>Number.isFinite(Date.parse(value))&&new Date(value).toISOString().slice(0,10)===value,'Fecha inválida');
export const amount=z.string().regex(/^(0|[1-9][0-9]{0,12})(?:[.,][0-9]{1,2})?$/);

export function rememberDrafts(context:{drafts?:any[];turn_focus?:{draft_ids:string[]}},drafts:any[],focus=true){
 const ids=new Set(drafts.map(d=>String(d.id)));
 context.drafts=[...drafts,...(context.drafts??[]).filter(d=>!ids.has(String(d.id)))];
 if(focus&&context.turn_focus)context.turn_focus.draft_ids=[...new Set([...context.turn_focus.draft_ids,...ids])];
}

export const draftFields=z.strictObject({
 kind: z.enum(["income", "expense", "refund", "transfer", "borrow", "lend", "repayment", "collection"]).optional(),
 amount_cop: amount.optional(),
 account: str(64).describe("En transferencias SIEMPRE cuenta de ORIGEN. En ingresos cuenta receptora y en gastos cuenta pagadora; nombre exacto.").optional(),
 other: str(64).describe("En transferencias SIEMPRE cuenta de DESTINO. En préstamos cuenta contraparte. Nunca concepto ni comercio.").optional(),
 from_account: str(64).describe('Origen explícito de una transferencia; no cambia por quién escribe.').optional(),
 to_account: str(64).describe('Destino explícito de una transferencia; si dice me llegó a Banco Alfa, Banco Alfa es destino.').optional(),
 payer: id.describe("ID del miembro del hogar asociado al movimiento: quien paga un gasto o recibe un ingreso. En ingresos recibidos por el autor usa actor; nunca el nombre de un tercero externo.").optional(),
 counterparty: str(120).describe("Persona o entidad externa que entrega/recibe dinero: cliente, arrendatario, empleador o comercio. Nombre o descripción, sin exigir que sea miembro. No sustituye actor, titular ni permisos.").optional(),
 beneficiary: id.optional(),
 date: day.optional(),
 category: str(80).describe("Categoría corta del movimiento, por ejemplo Comida.").optional(),
 scope: z.enum(["family", "personal"]).optional(),
 memo: str(240).describe("Concepto o comercio, por ejemplo almuerzo de ejemplo.").optional(),
});
