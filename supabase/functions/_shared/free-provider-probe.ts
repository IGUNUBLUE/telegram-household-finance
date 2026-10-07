/** Synthetic evaluations only. This module is not selected by the financial worker. */
import {createOpenAI} from '@ai-sdk/openai';
export const freeProbeModels={
 'opencode-zen':['space-bunny-free','longcat-2.5-preview-free','mimo-v2.6-flash-free','big-pickle'],
 'vercel-gateway':['inclusionai/ling-3.1-flash-free','poolside/laguna-s-2.1-free'],
} as const;
export function createFreeProbeModel(options:{provider?:keyof typeof freeProbeModels;model:string;apiKey:string;deadline:number;fetch?:typeof fetch}){
 const provider=options.provider??'opencode-zen';
 if(!(freeProbeModels[provider] as readonly string[]|undefined)?.includes(options.model))throw Error('Modelo de prueba no permitido');
 const send=options.fetch??fetch;
 return createOpenAI({apiKey:options.apiKey,baseURL:provider==='opencode-zen'?'https://opencode.ai/zen/v1':'https://ai-gateway.vercel.sh/v1',
  headers:{'User-Agent':'finanzas-familiares/synthetic-evaluation'},fetch:async(url,init)=>{
   const remaining=options.deadline-Date.now();if(remaining<1000)throw Error('Tiempo agotado');
   const signal=AbortSignal.timeout(Math.min(25_000,remaining));
   return send(url,{...init,signal:init?.signal?AbortSignal.any([init.signal,signal]):signal});
  },
 }).chat(options.model);
}
