import {z} from 'zod';import {defineTool} from './types.ts';
export const approvalsTools=[
 defineTool('consultar_confirmaciones','Consulta solicitudes de confirmación de cuentas recibidas y enviadas por quien escribe.',z.object({}),async(_a,c,rpc)=>({result:await rpc('approval:context',{id:c.event_id})}),true),
 defineTool('decidir_solicitud','Confirma o rechaza una solicitud dirigida al actor SOLO con evidencia explícita en el mensaje actual. Familiar no concede autorización.',z.object({request_id:z.string().regex(/^\d+$/),revision:z.number().int().positive(),decision:z.enum(['confirm','reject'])}),async(a)=>({action:{type:'approval_decision',...a}})),
];
