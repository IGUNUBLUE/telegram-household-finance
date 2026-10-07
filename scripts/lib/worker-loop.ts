type LoopDependencies={tick:()=>Promise<boolean>;index:()=>Promise<boolean>;sleep:(ms:number,signal:AbortSignal)=>Promise<void>;log:(record:{status:string})=>void;clock?:()=>number};
export async function runWorkerLoop(deps:LoopDependencies,signal:AbortSignal):Promise<void>{
 let failures=0,lastIndex=-Infinity;const clock=deps.clock??Date.now;
 while(!signal.aborted){
  let wait=5000;
  try{
   const worked=await deps.tick();if(signal.aborted)break;
   if(!worked&&clock()-lastIndex>=60000){lastIndex=clock();await deps.index();if(signal.aborted)break;}
   failures=0;wait=worked?250:5000;
  }catch{if(signal.aborted)break;wait=Math.min(60000,5000*2**Math.min(failures++,4));deps.log({status:'worker_retry'});}
  try{await deps.sleep(wait,signal);}catch{if(!signal.aborted)throw Error('Worker timer unavailable');}
 }
}
