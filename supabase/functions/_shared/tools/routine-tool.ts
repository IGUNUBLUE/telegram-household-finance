import type {z} from 'zod';
import {normalizeAction} from '../domain.ts';
import {defineTool} from './types.ts';

export function routineTool<S extends z.ZodType>(name:string,command:string,description:string,inputSchema:S){
 return defineTool(name,description,inputSchema,async(args,context)=>{
  const data=args as Record<string,unknown>;
  if(command==='recurring_create'||command==='recurring_update')normalizeAction({type:'post',kind:'expense',...data,payer:context.actor,beneficiary:data.scope==='personal'?context.actor:undefined,date:data.start,memo:data.label},context);
  return {action:{type:'routine',command,...data}};
 });
}
