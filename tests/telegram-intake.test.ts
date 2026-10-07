import test from 'node:test';import assert from 'node:assert/strict';
const adapter=await import('../supabase/functions/_shared/telegram-intake.ts').catch(()=>null);
const transport=await import('../supabase/functions/_shared/telegram-client.ts').catch(()=>null);
const update=(extra:any={})=>({update_id:10,message:{message_id:9,from:{id:101,is_bot:false,first_name:'Alex'},date:1,chat:{id:-1001,type:'supergroup',title:'Familia'},text:'Guárdalo',...extra}});
const request=(value:any,secret='webhook-secret')=>new Request('https://test.invalid/telegram',{method:'POST',headers:{'X-Telegram-Bot-Api-Secret-Token':secret},body:JSON.stringify(value)});
function fixture({count=3,state='new',ingest}: {count?:number;state?:string;ingest?:(data:any)=>Promise<any>}={}){
 assert.ok(adapter,'grammY intake implemented');assert.ok(transport);
 const calls:string[]=[];const events:any[]=[];const waits:Promise<unknown>[]=[];let wakes=0,loads=0;
 const client=transport.createTelegramClient('synthetic-token',async(url)=>{const method=String(url).split('/').at(-1)!;calls.push(method);return Response.json({ok:true,result:method==='getMe'?{id:99,is_bot:true,first_name:'Bot',username:'synthetic_bot'}:method==='getChatMemberCount'?count:true});});
 const handler=adapter.createTelegramHandler({getConfig:(key:string)=>({TELEGRAM_WEBHOOK_SECRET:'webhook-secret',TELEGRAM_GROUP_ID:'-1001',TELEGRAM_BOT_TOKEN:'synthetic-token'} as Record<string,string>)[key],loadConfig:async()=>{loads++;},getClient:()=>client,rpc:async(op:string,data:any)=>{assert.equal(op,'ui:ingest');events.push(data);return ingest?ingest(data):{state};},waitUntil:(p:Promise<unknown>)=>{waits.push(p);},wakeWorker:async()=>{wakes++;},log:()=>{}});
 const deps={getConfig:(key:string)=>({TELEGRAM_WEBHOOK_SECRET:'webhook-secret',TELEGRAM_GROUP_ID:'-1001',TELEGRAM_BOT_TOKEN:'synthetic-token'} as Record<string,string>)[key],loadConfig:async()=>{loads++;},getClient:()=>client,rpc:async(op:string,data:any)=>{assert.equal(op,'ui:ingest');events.push(data);return ingest?ingest(data):{state};},waitUntil:(p:Promise<unknown>)=>{waits.push(p);},wakeWorker:async()=>{wakes++;},log:()=>{}};
 return {handler,deps,calls,events,waits,get wakes(){return wakes;},get loads(){return loads;}};
}
test('Webhook secret, configured group and extra members are rejected before ingest',async()=>{
 const f=fixture();assert.equal((await f.handler(request(update(),''))).status,401);assert.equal(f.loads,0);
 assert.equal((await f.handler(request(update(),'wrong'))).status,401);
 assert.equal((await f.handler(request(update({chat:{id:-2,type:'group'}})))).status,403);assert.equal(f.events.length,0);
 const extra=fixture({count:4});assert.equal((await extra.handler(request(update()))).status,403);assert.equal(extra.events.length,0);
});
test('Callbacks acknowledge immediately before database latency and do not repeat worker for duplicates',async()=>{
 let release!:()=>void;const gate=new Promise<void>(r=>{release=r;});const f=fixture({ingest:async()=>{await gate;return {state:'duplicate',remove_buttons:true};}});
 const value={update_id:11,callback_query:{id:'cb1',from:{id:101,is_bot:false,first_name:'Alex'},chat_instance:'x',data:'confirm:1',message:{...update().message,from:{id:99,is_bot:true,first_name:'Bot'}}}};
 const pending=f.handler(request(value));for(let i=0;i<30;i++)await Promise.resolve();
 assert.equal(f.calls[0],'answerCallbackQuery');release();assert.equal((await pending).status,200);await Promise.all(f.waits);
 assert.equal(f.wakes,0);assert.ok(f.calls.includes('editMessageReplyMarkup'));
});
test('grammY intake keeps reply, forum, voice and largest photo in persisted payload',async()=>{
 const f=fixture();const r=await f.handler(request(update({message_thread_id:12,is_topic_message:true,reply_to_message:{message_id:8,text:'¿Desde qué cuenta?'},voice:{file_id:'audio'},photo:[{file_id:'small'},{file_id:'large'}]})));
 assert.equal(r.status,200);await Promise.all(f.waits);const p=f.events[0].payload;
 assert.equal(p.reply,'¿Desde qué cuenta?');assert.equal(p.replyTo,8);assert.equal(p.voice,'audio');assert.equal(p.photo,'large');assert.equal(p.threadId,12);assert.equal(p.isTopic,true);assert.equal(f.wakes,1);assert.ok(f.calls.includes('sendChatAction'));
});
test('Database failure returns retryable HTTP response and no misleading successful acknowledgment',async()=>{
 const f=fixture({ingest:async()=>{throw Error('private data');}});const r=await f.handler(request(update()));assert.equal(r.status,503);assert.equal(f.wakes,0);assert.doesNotMatch(await r.text(),/private/);
});
test('polling uses the same authorization, media and callback admission without a synthetic webhook',async()=>{
 const f=fixture();assert.equal(typeof adapter?.createTelegramIntake,'function');
 const admit=adapter!.createTelegramIntake(f.deps);
 assert.equal(await admit(update({voice:{file_id:'voice'},reply_to_message:{message_id:8,text:'saldo'},message_thread_id:12,is_topic_message:true})),'admitted');
 assert.equal(f.events[0].payload.voice,'voice');assert.equal(f.events[0].payload.replyTo,8);assert.equal(f.events[0].payload.threadId,12);
 assert.equal(await admit(update({chat:{id:-2,type:'group'}})),'discarded');
 assert.equal(await admit({update_id:12,message:{from:{id:99,is_bot:true},chat:{id:-1001,type:'supergroup'}}}),'discarded');
 assert.equal(f.events.length,1);await Promise.all(f.waits);
 const retry=fixture({ingest:async()=>{throw Error('private');}});await assert.rejects(adapter!.createTelegramIntake(retry.deps)(update()),/temporary/);
});
