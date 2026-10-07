export const response=(output:any[],extra:Record<string,unknown>={})=>({id:'resp_test',model:'gpt-6-luna',created_at:1,status:'completed',output,usage:{input_tokens:12,output_tokens:7,total_tokens:19},...extra});
export const message=(text:string)=>({type:'message',role:'assistant',id:'msg_test',content:[{type:'output_text',text,annotations:[]}]});
export const call=(name:string,args:unknown,call_id='call_test')=>({type:'function_call',id:'fc_'+call_id,call_id,name,arguments:JSON.stringify(args),status:'completed'});
export function providerFetch(replies:any[]){
 const requests:{url:string;body:any;headers:Headers}[]=[];
 const fetcher:typeof fetch=async(url,init)=>{
  const index=requests.length;requests.push({url:String(url),body:JSON.parse(String(init?.body)),headers:new Headers(init?.headers)});
  const reply=replies[Math.min(index,replies.length-1)];
  if(reply instanceof Error)throw reply;
  return Response.json(reply);
 };
 return {fetcher,requests};
}
