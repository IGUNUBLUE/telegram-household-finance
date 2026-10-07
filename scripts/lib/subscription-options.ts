export function parseSubscriptionOptions(args:string[]):{port:number;noOpen:boolean;probeOnly:boolean;model?:string}{
 const options:{port:number;noOpen:boolean;probeOnly:boolean;model?:string}={port:0,noOpen:false,probeOnly:false};
 for(let i=0;i<args.length;i++){
  switch(args[i]){
   case '--no-open':options.noOpen=true;break;
   case '--probe-only':options.probeOnly=true;break;
   case '--port':{
    const value=args[++i];
    if(!value||!/^\d+$/.test(value)||Number(value)<1024||Number(value)>65535)throw Error('El puerto de callback debe ser un entero entre 1024 y 65535.');
    options.port=Number(value);break;
   }
   case '--model':{
    const value=args[++i];
    if(!value||value.startsWith('-')||!value.trim())throw Error('Falta el nombre del modelo después de --model.');
    options.model=value;break;
   }
   default:throw Error('Opción desconocida. Usa --no-open, --port, --model o --probe-only.');
  }
 }
 return options;
}
