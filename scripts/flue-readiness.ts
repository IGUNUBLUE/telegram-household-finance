/** Readiness only: no session refresh, queue claims, polling or Telegram sends. */
import {dirname,join} from 'node:path';import {DatabaseSync} from 'node:sqlite';import {Api} from 'grammy/web';
import {loadWorkerConfig} from './lib/worker-config.ts';import {readProtectedJson,type SubscriptionSession} from './lib/subscription-session.ts';
import type {SubscriptionCredentials} from './lib/subscription-auth.ts';import {createProtectedPiProvider,FINANCE_MODEL} from './lib/pi-provider.ts';import {createSecureFlueSqlite,flueStatePath} from './lib/flue-sqlite.ts';import {createLocalEmbedding} from './lib/local-embedding.ts';
try{
 const args=process.argv.slice(2);if(args.length!==2||args[0]!=='--config')throw Error('options');const config=await loadWorkerConfig(args[1]),directory=dirname(args[1]);
 process.env.SUPABASE_URL=config.SUPABASE_URL;process.env.SUPABASE_SERVICE_ROLE_KEY=config.SUPABASE_SERVICE_ROLE_KEY;
 const {getConfig,loadRuntimeConfig}=await import('../supabase/functions/_shared/config.ts');await loadRuntimeConfig();
 if(getConfig('FINANCE_EXECUTOR')!=='vps_subscription'||!getConfig('TELEGRAM_GROUP_ID')||!getConfig('DEEPGRAM_API_KEY'))throw Error('runtime config');
 const credentials=await readProtectedJson<SubscriptionCredentials>(join(directory,'chatgpt-subscription.json'));if(!credentials||credentials.expires_at<Date.now()+60000||credentials.issuer!=='https://auth.openai.com')throw Error('session');
 const session={accessToken:async()=>credentials.access_token} as SubscriptionSession;const catalog=await fetch('https://api.openai.com/v1/models',{headers:{Authorization:'Bearer '+await session.accessToken()},signal:AbortSignal.timeout(20000)});if(!catalog.ok)throw Error('catalog');createProtectedPiProvider(session,await catalog.json());
 const state=flueStatePath(directory);const persistence=await createSecureFlueSqlite(state,false);persistence.close!();
 const db=new DatabaseSync(state,{readOnly:true});try{if(db.prepare('PRAGMA quick_check').get()!.quick_check!=='ok'||db.prepare('PRAGMA journal_mode').get()!.journal_mode!=='wal'||!db.prepare("select value from flue_meta where key='format_version'").get())throw Error('sqlite integrity');}finally{db.close();}
 const {createTelegramClientCache}=await import('../supabase/functions/_shared/telegram-client.ts');const client=createTelegramClientCache()(getConfig('TELEGRAM_BOT_TOKEN')!);await client.botInfo();
 const webhook=await new Api(getConfig('TELEGRAM_BOT_TOKEN')!,{timeoutSeconds:20,sensitiveLogs:false}).getWebhookInfo(AbortSignal.timeout(20000) as never);
 await createLocalEmbedding(join(directory,'model-cache'))('Synthetic readiness.',AbortSignal.timeout(60000));
 console.log(JSON.stringify({status:'flue_readiness_passed',model:FINANCE_MODEL,persistence:'private_sqlite_wal',embedding_dimensions:384,intake:webhook.url?'current_webhook_preserved':'polling_available'}));
}catch{console.log(JSON.stringify({status:'flue_readiness_failed'}));process.exitCode=1;}
