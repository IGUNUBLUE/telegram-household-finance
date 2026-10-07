import type {Provider} from '@earendil-works/pi-ai';
import {createFinancialFlue} from './flue-agent.ts';
import {randomUUID} from 'node:crypto';
export async function probeFlueAuthorization(provider:Provider){
 const runtime=await createFinancialFlue({provider,tools:[]});
 try{
  const result=await runtime.run({key:'authorization-'+randomUUID(),instructions:'Responde únicamente CONEXION_OK. No uses herramientas.',text:'Verifica la conexión.',tools:false,maxSteps:1,timeoutMs:20000,dispatch:async()=>{throw Error('No tools');}});
  if(result.question!=='CONEXION_OK')throw Error('Authorization probe failed');
 }finally{await runtime.close();}
}
