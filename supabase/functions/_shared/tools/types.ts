import type {z} from 'zod';
import type {Context} from '../domain.ts';

export type ToolContext=Context&{event_id:number;actor:string;approvals?:{received:any[];sent:any[]};pending_proposals?:any[];drafts?:any[];turn_focus?:{draft_ids:string[];previous_draft_ids?:string[]}};
export type Rpc=(op:string,data?:any,signal?:AbortSignal)=>Promise<any>;
export type ToolOutcome={action?:any;result?:any};
export type FinancialTool<S extends z.ZodType=z.ZodType>={
 name:string;
 description:string;
 inputSchema:S;
 readOnly?:boolean;
 execute:(args:z.output<S>,context:ToolContext,rpc:Rpc)=>Promise<ToolOutcome>;
};
export function defineTool<S extends z.ZodType>(name:string,description:string,inputSchema:S,execute:FinancialTool<S>['execute'],readOnly=false):FinancialTool<S>{
 return {name,description,inputSchema,execute,readOnly};
}

/** Prevent sequential tool RPCs from continuing after the turn deadline. */
export function abortableRpc(rpc:Rpc,signal:AbortSignal):Rpc{
 return async(op,data)=>{signal.throwIfAborted();const result=await rpc(op,data,signal);signal.throwIfAborted();return result;};
}
