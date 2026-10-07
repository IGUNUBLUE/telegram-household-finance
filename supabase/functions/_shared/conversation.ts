// Match whole social messages only: a greeting must never swallow a transaction.
export function routineReply(text:string,seed=0):string|null{
 const clean=text.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[¡!¿?.,:;]/g,'').replace(/\s+/g,' ').trim();
 const choose=(items:string[])=>items[Math.abs(seed)%items.length];
 if(/^(hola|holi|buenas|buenos dias|buenas tardes|buenas noches)( contador| bot)?$/.test(clean))return choose([
  '¡Hola! Cuéntame, ¿qué revisamos hoy?',
  '¡Buenas! Te leo. Cuéntame qué necesitas.',
  '¡Hola! ¿Cómo van las cuentas? Cuéntame y lo vemos.'
 ]);
 if(/^(gracias|muchas gracias|mil gracias|ok gracias|listo gracias)$/.test(clean))return choose(['¡Con gusto! Aquí estoy cuando necesites.','¡De nada! Seguimos cuando quieras.']);
 if(/^(ayuda|que puedes hacer|como funciona esto)$/.test(clean))return 'Cuéntame qué pagaste o qué quieres revisar, como se lo contarías a alguien. También puedes mandarme un audio o un recibo; si falta algo, te pregunto.';
 return null;
}

export const conversationStyle='Al redactar question, habla en español colombiano natural, cálido y sencillo, sin exagerar confianza. Máximo dos frases y 200 caracteres. Responde a lo que la persona realmente dijo; no repitas saludos ni menús de funciones. Si falta información, reconoce brevemente lo entendido y pregunta solo el siguiente dato necesario. No vuelvas a pedir datos ya presentes. Revisa ortografía y usa saldo, cuenta, ingreso y gasto correctamente. No añadas emojis: los añade la aplicación. No afirmes que registraste nada ni calcules saldos en question; el servidor confirma registros y calcula resultados. No inventes nombres. No inventes contexto de conversaciones anteriores.';
