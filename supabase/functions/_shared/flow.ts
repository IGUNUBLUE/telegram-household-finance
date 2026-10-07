const plain=(s:string)=>s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'');
export function unknownBalance(text:string){return /\b(no (se|lo se|recuerdo|conozco|tengo el saldo)|desconozco|pendiente|despues|luego)\b/.test(plain(text));}
export function hasAmountEvidence(text:string){return /\d|\b(cero|un|uno|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|veinte|treinta|cuarenta|cincuenta|sesenta|setenta|ochenta|noventa|cien|ciento|doscientos|trescientos|quinientos|mil|millon|millones)\b/.test(plain(text));}
export function explicitOpeningBalance(text:string){return /\b(saldo|tengo|tenia|disponible|en cero)\b/.test(plain(text))&&hasAmountEvidence(text)&&!unknownBalance(text);}
export function asksRegistration(text:string){return /^(?:y )?(?:ya )?(?:quedo|quedaron|esta|estan|se registro|registraste|lo registraste|se guardo|lo guardaste)(?: el gasto| el movimiento| eso| todo)?(?: registrado| guardado| anotado)?[?¿!.\s]*$/.test(plain(text).replace(/^¿/,''));}
