import {test} from 'node:test';import assert from 'node:assert/strict';
import {approvalDatabase} from './fixtures/approval-database.ts';
import {createTelegramIntake} from '../supabase/functions/_shared/telegram-intake.ts';
import {createTelegramClient} from '../supabase/functions/_shared/telegram-client.ts';
const update=(id:number,actor=202,type='private',chat=202,text='/start')=>({update_id:id,message:{message_id:100,from:{id:actor,is_bot:false,first_name:'Persona'},date:1,chat:{id:chat,type},text}});
async function fixture(status='member',temporary=false){
 const f=await approvalDatabase();await f.enable();const calls:{method:string,body:any}[]=[];const waits:Promise<unknown>[]=[];
 const client=createTelegramClient('synthetic-token',async(url,init)=>{const method=String(url).split('/').at(-1)!,body=JSON.parse(String(init?.body??'{}'));calls.push({method,body});if(method==='getChatMember'&&temporary)throw Error('Transport');return Response.json({ok:true,result:method==='getMe'?{id:99,is_bot:true,first_name:'Bot',username:'synthetic_bot'}:method==='getChatMemberCount'?3:method==='getChatMember'?{status,user:{id:body.user_id,is_bot:false,first_name:'Persona'}}:true});});
 const intake=createTelegramIntake({loadConfig:async()=>{},getConfig:k=>({TELEGRAM_GROUP_ID:'-100123',TELEGRAM_BOT_TOKEN:'synthetic-token'} as Record<string,string>)[k],getClient:()=>client,rpc:f.rpc,waitUntil:p=>waits.push(p),wakeWorker:async()=>{},log:()=>{}});
 return {...f,calls,waits,intake};
}
test('private intake accepts existing member and persists exact private route after membership verification',async()=>{
 const f=await fixture();try{assert.equal(await f.intake(update(200000)),'admitted');await Promise.allSettled(f.waits);const row=(await f.db.query<any>('select actor,payload from private.events where id=200000')).rows[0];assert.equal(row.actor,'202');assert.equal(row.payload.chatId,'202');assert.equal(row.payload.chatType,'private');assert.ok(f.calls.some(x=>x.method==='getChatMember'&&String(x.body.user_id)==='202'&&x.body.chat_id==='-100123'));}finally{await f.db.close();}
});
test('private intake rejects unknown identities, another private chat, wrong groups and departed members',async()=>{
 const f=await fixture('left');try{for(const u of [update(200001,999,'private',999),update(200002,202,'private',101),update(200003,202,'group',-999),update(200004)])assert.equal(await f.intake(u),'discarded');assert.equal((await f.db.query<any>('select count(*)::int n from private.events where id>=200000')).rows[0].n,0);assert.equal((await f.db.query<any>('select count(*)::int n from private.members')).rows[0].n,2);}finally{await f.db.close();}
});
test('temporary member verification failure stays retryable rather than discarding private confirmation',async()=>{const f=await fixture('member',true);try{await assert.rejects(f.intake(update(200005)),/temporary/);assert.equal((await f.db.query<any>('select count(*)::int n from private.events where id=200005')).rows[0].n,0);}finally{await f.db.close();}});
test('wrong owner callback does not remove the responsible member buttons',async()=>{
 const f=await fixture();try{const e=await f.event(),r=await f.request(e);const u={update_id:200006,callback_query:{id:'callback-one',from:{id:101,is_bot:false,first_name:'Persona Uno'},data:'aconfirm:'+r.id+':'+r.revision,chat_instance:'instance',message:{message_id:400,from:{id:99,is_bot:true,first_name:'Bot'},chat:{id:-100123,type:'supergroup'},date:1,text:'Solicitud'}}};assert.equal(await f.intake(u),'admitted');await Promise.allSettled(f.waits);assert.equal(f.calls.filter(x=>x.method==='editMessageReplyMarkup').length,0);assert.equal((await f.db.query<any>('select count(*)::int n from private.events where id=200006')).rows[0].n,0);}finally{await f.db.close();}
});
