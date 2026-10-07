/** Runtime boundary; shared modules never require a Deno shim in Node. */
export function getRuntimeEnv(name:string):string|undefined{
 const deno=(globalThis as {Deno?:{env:{get:(name:string)=>string|undefined}}}).Deno;
 if(deno)return deno.env.get(name);
 const node=(globalThis as {process?:{env:Record<string,string|undefined>}}).process;
 return node?.env[name];
}
