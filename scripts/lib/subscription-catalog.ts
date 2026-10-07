export function selectSubscriptionModel(catalog:unknown,requested:string):string{
 const models=catalog&&typeof catalog==='object'?(catalog as {models?:unknown}).models:undefined;
 if(!Array.isArray(models))throw Error('El catálogo de modelos tiene un formato inesperado; no se puede comprobar el modelo solicitado.');
 const names=[...new Set<string>(models.map(item=>item?.slug).filter((slug:unknown):slug is string=>typeof slug==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/.test(slug)))];
 if(!names.length)throw Error('El catálogo de modelos está vacío o no contiene identificadores válidos.');
 if(!names.includes(requested))throw Error('El modelo solicitado no aparece en el catálogo de tu cuenta. Modelos del catálogo: '+names.join(', ')+'. Repite la prueba con --model y uno de esos nombres.');
 return requested;
}
