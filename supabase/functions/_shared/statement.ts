export type StatementRow={date:string;delta:string;memo:string};
export function exactSignedCop(raw:string):string{
 const v=raw.trim();if(!/^-?\d{1,12}(?:[.,]\d{1,2})?$/.test(v))throw Error('Usa montos sin separador de miles, por ejemplo -15000.50.');
 const [whole,fraction='']=v.replace(',','.').replace('-','').split('.');
 const cents=BigInt(whole)*100n+BigInt(fraction.padEnd(2,'0'));
 if(cents>100000000000000n)throw Error('Monto fuera de rango');
 return ((v.startsWith('-')?-1n:1n)*cents).toString();
}
export function checkRows(rows:any[]):StatementRow[]{
 if(!Array.isArray(rows)||rows.length<1||rows.length>200)throw Error('El extracto debe tener entre 1 y 200 movimientos.');
 return rows.map(r=>{if(typeof r.date!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(r.date)||!Number.isFinite(Date.parse(r.date+'T00:00:00Z'))||new Date(r.date+'T00:00:00Z').toISOString().slice(0,10)!==r.date)throw Error('Fecha inválida: usa AAAA-MM-DD.');if(typeof r.delta!=='string'||!/^[-]?\d{1,15}$/.test(r.delta)||BigInt(r.delta)===0n||BigInt(r.delta)>100000000000000n||BigInt(r.delta)<-100000000000000n)throw Error('Monto del extracto inválido.');return {date:r.date,delta:r.delta,memo:String(r.memo??'').slice(0,240)};});
}
export function parseStatementCsv(text:string):StatementRow[]{
 const delimiter=text.split(/\r?\n/)[0].includes(';')?';':',';const rows:string[][]=[];let row:string[]=[],field='',quoted=false;
 for(let i=0;i<text.length;i++){const c=text[i];if(c==='"'){if(quoted&&text[i+1]==='"'){field+='"';i++;}else quoted=!quoted;}else if(!quoted&&c===delimiter){row.push(field);field='';}else if(!quoted&&c==='\n'){row.push(field.replace(/\r$/,''));if(row.some(v=>v.trim()))rows.push(row);row=[];field='';}else field+=c;}
 if(quoted)throw Error('CSV con comillas incompletas');if(field||row.length){row.push(field.replace(/\r$/,''));rows.push(row);}
 const header=rows.shift()?.map(x=>x.replace(/^\uFEFF/,'').trim().toLowerCase());
 if(!header||header.join(',')!=='fecha,valor,descripcion')throw Error('Columnas requeridas: fecha,valor,descripcion. Valores negativos para salidas; positivos para entradas o abonos.');
 return checkRows(rows.map(r=>{if(r.length!==3)throw Error('Fila CSV incompleta');return {date:r[0].trim(),delta:exactSignedCop(r[1]),memo:r[2]};}));
}
