/** Only the application creates formatting; user/model content is always escaped. */
export const escapeMarkdownV2=(text:string)=>text.replace(/[_*\[\]()~`>#+\-=|{}.!\\]/g,'\\$&');
export function telegramMarkdown(text:string):string{
 return text.split('\n').map(line=>{
  // Short receipt/report headings. Never interpret markup supplied by a user.
  if(/^(?:📋 Movimiento #\d+|📊 (?:Ingresos|Plan)|📅 Semana anterior|🔎 Antes de confirmar|📌 Tus preferencias)/u.test(line)&&!line.includes('$'))return '*'+escapeMarkdownV2(line)+'*';
  const label=line.match(/^(Autor|Reversiones|Fecha|Cuenta|Categoría|Concepto|Monto|Saldo inicial|Deuda actual|Ingresos|Gastos|Pendientes|Disponible estimado|Dinero registrado|Reservado para metas|Compromisos hasta esa fecha):/);
  const prefix=label?'*'+escapeMarkdownV2(label[0])+'*':'';
  const rest=label?line.slice(label[0].length):line;
  return prefix+rest.split(/(-?\$[\d.]+(?:,\d{1,2})?(?: COP)?)/g).map((part,i)=>i%2?'*'+escapeMarkdownV2(part)+'*':escapeMarkdownV2(part)).join('');
 }).join('\n');
}
/** Split plain text first so neither escape sequences nor bold markers are cut. */
export function telegramParts(text:string,limit=3500):string[]{
 const parts:string[]=[];
 for(let offset=0;offset<text.length;){
  let end=Math.min(offset+limit,text.length);
  if(end<text.length&&/[\uD800-\uDBFF]/.test(text[end-1]))end--;
  parts.push(text.slice(offset,end));offset=end;
 }
 return parts;
}
