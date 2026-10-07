import type {z} from 'zod';
import {normalizePro} from '../pro-domain.ts';
import {defineTool} from './types.ts';

const queries=new Set(['detail','planning','projects','preferences','pending','reconcile']);
export function proTool<S extends z.ZodType>(name:string,command:string,description:string,inputSchema:S){
 return defineTool(name,description,inputSchema,async(args,context,rpc)=>{
  const action=normalizePro({type:'pro',command,...args as Record<string,unknown>},context);
  if(queries.has(command))return {result:await rpc('agent:query',{id:context.event_id,action})};
  return {action};
 },queries.has(command));
}
