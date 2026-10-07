import {test} from 'node:test';
import assert from 'node:assert/strict';
import {normalizeAction, money, intendedChat, messageText, extractUpdate, formatResult, ledgerCsv} from '../supabase/functions/_shared/domain.ts';
const accounts=[{name:'Banco',kind:'asset',owner:'101'},{name:'Tarjeta',kind:'liability',owner:'101'}];
const members=[{id:'101',name:'Alex'},{id:'102',name:'Esposa'}];
test('COP parsed to exact integer cents and rejects ambiguous separators',()=>{assert.equal(money('85000'),'8500000');assert.equal(money('0'),'0');for(const s of ['85.000','85,000','1.234','-1','10000000000000'])assert.throws(()=>money(s));});
test('rejects fabricated account, payer and future promise',()=>{
 const base={type:'post',kind:'expense',amount_cop:'85000',account:'Banco',payer:'101',date:'2026-09-27',category:'mercado',scope:'family',memo:'market'};
 assert.equal(normalizeAction(base,{accounts,members}).amount,'8500000');
 assert.throws(()=>normalizeAction({...base,account:'Banco falso'},{accounts,members}));
 assert.throws(()=>normalizeAction({...base,payer:'103'},{accounts,members}));
 assert.throws(()=>normalizeAction({...base,kind:'transfer',other:'Banco'},{accounts,members}));
});
test('rejects unknown group without fixing Telegram ID',()=>{assert.equal(intendedChat('-100123','-100123'),true);assert.equal(intendedChat('100000001','-100123'),false);assert.throws(()=>intendedChat('100000001','100000001'));});
test('command shortcuts do not infer financial events',()=>{assert.equal(messageText('/saldo'),'saldo');assert.equal(messageText('/deshacer 27'),'deshacer 27');assert.equal(messageText('Mañana pagaré la tarjeta'),'Mañana pagaré la tarjeta');});
test('extracts sender and group from Telegram update without trusting message text',()=>{
 const event=extractUpdate({update_id:8,message:{message_id:5,from:{id:101,first_name:'Alex'},chat:{id:-100123,type:'supergroup'},text:'Gasté 50'}});
 assert.equal(event.actor,'101');assert.equal(event.group,'-100123');assert.equal(event.text,'Gasté 50');
 assert.throws(()=>extractUpdate({update_id:9,message:{sender_chat:{id:88},chat:{id:-100123},text:'yo'}}));
});
test('display COP amounts exactly and show registered-balance warning',()=>{
 assert.match(formatResult({status:'ok',report:{expense:'12345',income:'100000',balances:[{name:'Banco',balance:'87655'}],categories:[],budgets:[]}}),/\$123,45 COP/);
 assert.match(formatResult({status:'ok',report:{expense:'0',income:'0',balances:[],categories:[],budgets:[]}}),/registrados/);
});
test('CSV escapes memos and retains signed integer cents',()=>{
 const csv=ledgerCsv([{transaction_id:1,date:'2026-09-27',kind:'expense',category:'Taxi',scope:'family',payer:'101',beneficiary:null,account:'Banco',delta:'-12345',memo:'"taxi, centro"',reverses:null}]);
 assert.match(csv,/"""taxi, centro"""/);assert.match(csv,/-12345/);assert.match(csv,/transaction_id,date,kind/);
});

test('Decimal COP is exact including leading fractional zero and maximum limit',()=>{assert.equal(money('1234567.89'),'123456789');assert.equal(money('1.2'),'120');assert.equal(money('0,01'),'1');assert.equal(money('1000000000000.00'),'100000000000000');assert.throws(()=>money('1000000000000.01'));});
test('Extract distinguishes ordinary reply thread from a real forum topic',()=>{
 const message={message_id:66,message_thread_id:62,from:{id:101,first_name:'Test'},chat:{id:-100123,type:'supergroup'},text:'Sí',reply_to_message:{message_id:65,text:'¿Confirmas?'}};
 const reply=extractUpdate({update_id:900,message});assert.equal(reply.isTopic,false);assert.equal(reply.replyTo,65);
 assert.equal(extractUpdate({update_id:901,message:{...message,is_topic_message:true}}).isTopic,true);
});
test('Pocket report displays available and SQL total without repeating flat accounts',()=>{
 const text=formatResult({report:{income:'0',expense:'0',balances:[{name:'Banco Alfa',balance:'25013'},{name:'Banco Alfa · Regalos',balance:'140034'}],pocket_groups:[{account:'Banco Alfa',available:'25013',total:'165047',balance_known:true,pockets:[{name:'Regalos',account:'Banco Alfa · Regalos',balance:'140034',balance_known:true}]}]}});
 assert.match(text,/Total Banco Alfa: \$1\.650,47/);assert.equal((text.match(/250,13/g)??[]).length,1);assert.doesNotMatch(text,/Banco Alfa · Regalos/);
});
