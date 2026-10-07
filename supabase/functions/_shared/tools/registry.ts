import {z} from 'zod';
import {approvalsTools} from './approvals.ts';
import {accountsTools} from './accounts.ts';
import {movementsTools} from './movements.ts';
import {queriesTools} from './queries.ts';
import {planningTools} from './planning.ts';
import {preferencesTools} from './preferences.ts';
import {correctionsTools} from './corrections.ts';
import {routinesTools} from './routines.ts';
import type {FinancialTool,ToolContext,Rpc,ToolOutcome} from './types.ts';

export const financialTools:FinancialTool<any>[]=[...approvalsTools,...routinesTools,...accountsTools,...movementsTools,...queriesTools,...planningTools,...preferencesTools,...correctionsTools];
const registry=new Map(financialTools.map(tool=>[tool.name,tool]));
if(registry.size!==financialTools.length)throw Error('Herramientas repetidas');

export const toolDefinitions=financialTools.map(tool=>{
 const {$schema,...parameters}=z.toJSONSchema(tool.inputSchema,{target:'draft-7',io:'input'});
 return {type:'function' as const,name:tool.name,description:tool.description,parameters,strict:false};
});
export async function dispatchTool(name:string,args:unknown,context:ToolContext,rpc:Rpc):Promise<ToolOutcome>{
 const tool=registry.get(name);if(!tool)throw Error('Herramienta no permitida');
 const parsed=tool.inputSchema.safeParse(args);
 if(!parsed.success)throw Error('Datos inválidos: '+parsed.error.issues.map((issue:any)=>issue.path.join('.')||'argumentos').join(', '));
 return tool.execute(parsed.data,context,rpc);
}
