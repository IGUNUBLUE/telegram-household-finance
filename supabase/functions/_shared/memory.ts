export const EMBEDDING_MODEL='gte-small-en-v1';
export function validEmbedding(value:unknown):number[]{
 if(!Array.isArray(value)||value.length!==384||!value.every(v=>typeof v==='number'&&Number.isFinite(v)))throw Error('Vector inválido');
 const norm=Math.sqrt(value.reduce((n,v)=>n+v*v,0));if(norm<0.9||norm>1.1)throw Error('Vector sin normalizar');return value;
}
export async function embedText(text:string,translate:(text:string)=>Promise<string>,embed:(text:string)=>Promise<unknown>):Promise<number[]>{
 if(!text.trim()||text.length>1000)throw Error('Texto fuera de límites');
 const translated=(await translate(text)).trim();
 if(!translated||translated.length>1800)throw Error('Traducción no disponible');
 return validEmbedding(await embed(translated));
}
