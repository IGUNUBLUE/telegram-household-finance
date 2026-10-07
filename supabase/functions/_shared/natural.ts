const clean=(text:string)=>text.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[¡!¿?.,;]/g,'').replace(/\s+/g,' ').trim();
export function socialIntent(text:string):'setup'|'cancel'|null{
 const t=clean(text);
 if(/^(ayudame a empezar|como empezamos|por donde empezamos|quiero empezar|empecemos|quiero (agregar|crear|registrar) una cuenta|agreguemos una cuenta|configurar|cuenta nueva)$/.test(t))return 'setup';
 if(/^(dejemos eso|cancela eso|olvida eso|mejor no|cancelar|nuevo)$/.test(t))return 'cancel';
 return null;
}
export function resolveConfirmation(text:string,proposals:{id:number}[],replyProposal?:number):{command:string;target?:number}|null{
 if(!/^(si|si esta bien|si confirmo|confirmo|confirmar|dale|adelante|de acuerdo|hazlo|esta bien|correcto)$/.test(clean(text)))return null;
 const candidates=replyProposal===undefined?proposals:proposals.filter(p=>Number(p.id)===Number(replyProposal));
 if(candidates.length===0)return {command:'missing'};
 if(candidates.length>1)return {command:'ambiguous'};
 return {command:'confirm',target:candidates[0].id};
}
