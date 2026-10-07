/** Stop all owners before closing shared persistence or authorization. */
export async function runWorkerServices(services:(()=>Promise<void>)[],stop:AbortController){
 const tasks=services.map(run=>Promise.resolve().then(run).finally(()=>stop.abort()));
 const results=await Promise.allSettled(tasks);
 if(results.some(r=>r.status==='rejected'))throw Error('Runtime service unavailable');
}
