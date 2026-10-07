/** Send temporary audio bytes to Deepgram; never log credentials or audio. */
export async function transcribeAudio(bytes:ArrayBuffer,key:string,contentType='audio/ogg',request:typeof fetch=fetch):Promise<string>{
 const url='https://api.deepgram.com/v1/listen?model=nova-3&language=es&smart_format=true&punctuate=true&mip_opt_out=true';
 const response=await request(url,{method:'POST',headers:{Authorization:'Token '+key,'Content-Type':contentType},body:bytes,signal:AbortSignal.timeout(45_000)});
 if(!response.ok)throw Error('No se pudo transcribir ('+response.status+')');
 const result=await response.json();
 const transcript=result?.results?.channels?.[0]?.alternatives?.[0]?.transcript;
 if(typeof transcript!=='string'||!transcript.trim())throw Error('No se pudo transcribir: audio sin voz clara');
 return transcript.trim();
}
