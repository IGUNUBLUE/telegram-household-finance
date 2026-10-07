import test from 'node:test';import assert from 'node:assert/strict';
const adapter=await import('../supabase/functions/_shared/telegram-client.ts').catch(()=>null);
const create=(fetcher:typeof fetch)=>{assert.ok(adapter,'Telegram client adapter is implemented');return adapter.createTelegramClient('synthetic-token',fetcher);};
test('grammY preserves Markdown, replies and topics without duplicating delivery',async()=>{
 let captured:any;const client=create(async(_url,init)=>{captured=JSON.parse(String(init?.body));return Response.json({ok:true,result:{message_id:11}});});
 const r=await client.telegram('sendMessage',{chat_id:'-1',text:'**saldo**',parse_mode:'MarkdownV2',reply_parameters:{message_id:7,allow_sending_without_reply:true},message_thread_id:9});
 assert.equal(r.message_id,11);assert.equal(captured.parse_mode,'MarkdownV2');assert.equal(captured.reply_parameters.message_id,7);assert.equal(captured.message_thread_id,9);
});
test('grammY uploads CSV bytes with BOM, filename and original reply route',async()=>{
 let payload='';let contentType='';const client=create(async(_url,init)=>{contentType=new Headers(init?.headers).get('Content-Type')??'';payload=await new Response(init?.body as BodyInit).text();return Response.json({ok:true,result:{message_id:12}});});
 await client.telegramDocument('-1','libro.csv','monto\r\n250,13',{reply_parameters:{message_id:7},message_thread_id:9});
 assert.match(contentType,/multipart\/form-data/);assert.match(payload,/filename="?libro.csv"?/);assert.ok(payload.includes('\uFEFFmonto\r\n250,13'));assert.match(payload,/"message_id":7/);assert.match(payload,/name="message_thread_id"/);
});
test('File downloads cap both declared and actual byte lengths',async()=>{
 let downloads=0;const client=create(async(url)=>{if(String(url).includes('/getFile'))return Response.json({ok:true,result:{file_id:'x',file_path:'photos/file.jpg',file_size:8_000_001}});downloads++;return new Response('x');});
 await assert.rejects(client.telegramFile('x'),/grande/);assert.equal(downloads,0);
 const streamed=create(async(url)=>String(url).includes('/getFile')?Response.json({ok:true,result:{file_path:'voice/file.ogg'}}):new Response(new Uint8Array(8_000_001)));
 await assert.rejects(streamed.telegramFile('x'),/grande/);
});
test('Telegram transport errors never expose the token or Telegram request data',async()=>{
 const client=create(async()=>{throw Error('https://api.telegram.org/botsynthetic-token/sendMessage private-financial-text');});
 await assert.rejects(client.telegram('sendMessage',{chat_id:'-1',text:'private-financial-text'}),error=>String(error).includes('Telegram')&&!String(error).includes('synthetic-token')&&!String(error).includes('private-financial-text'));
});
test('Token rotation invalidates cached API client and bot identity',async()=>{
 assert.ok(adapter);let requests:string[]=[];const fetcher:typeof fetch=async(url)=>{requests.push(String(url));return Response.json({ok:true,result:{id:99,is_bot:true,first_name:'Bot',username:'synthetic_bot'}});};
 const cache=adapter.createTelegramClientCache(fetcher);const a=cache('old-token');await Promise.all([a.botInfo(),a.botInfo()]);
 assert.equal(requests.length,1);const b=cache('new-token');assert.notEqual(a,b);await b.botInfo();assert.equal(requests.length,2);assert.match(requests[1],/new-token/);
});
test('pending message edits preserve a safe error classification without exposing Telegram descriptions',async()=>{
 for(const [description,code] of [['Bad Request: message is not modified','unchanged'],['Bad Request: message to edit not found','uneditable'],["Bad Request: message can't be edited",'uneditable'],['Too Many Requests: retry later','unavailable']] as const){
  const client=create(async()=>Response.json({ok:false,error_code:code==='unavailable'?429:400,description:description+' synthetic-token private-financial-text'}));
  await assert.rejects(client.telegram('editMessageText',{chat_id:'-1',message_id:8,text:'private-financial-text'}),(e:any)=>e.editStatus===code&&!String(e).includes('synthetic-token')&&!String(e).includes('private-financial-text'));
 }
});
test('Reaction transport supports replacing and clearing the bot reaction with a short deadline',async()=>{
 const requests:any[]=[];const client=create(async(url,init)=>{requests.push({url:String(url),body:JSON.parse(String(init?.body)),signal:init?.signal});return Response.json({ok:true,result:true});});
 await client.telegram('setMessageReaction',{chat_id:'-1',message_id:7,reaction:[{type:'emoji',emoji:'🤔'}],is_big:false});
 await client.telegram('setMessageReaction',{chat_id:'-1',message_id:7,reaction:[]});
 assert.match(requests[0].url,/setMessageReaction$/);assert.deepEqual(requests[0].body.reaction,[{type:'emoji',emoji:'🤔'}]);assert.deepEqual(requests[1].body.reaction,[]);
 const started=Date.now();const unavailable=create(async(_url,init)=>new Promise((_resolve,reject)=>{init?.signal?.addEventListener('abort',()=>reject(Error('Timeout')),{once:true});}));
 await assert.rejects(unavailable.telegram('setMessageReaction',{chat_id:'-1',message_id:7,reaction:[]}),/Telegram/);assert.ok(Date.now()-started<3000);
});
