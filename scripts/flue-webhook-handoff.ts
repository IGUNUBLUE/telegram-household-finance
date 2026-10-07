/** Controlled intake handoff; backup stays in the existing protected directory. */
import {dirname,join} from 'node:path';import {Api} from 'grammy/web';
import {loadWorkerConfig} from './lib/worker-config.ts';import {readProtectedJson,writeProtectedJson} from './lib/subscription-session.ts';
type Backup={botId:number;url:string;secret_token:string;max_connections:number;allowed_updates?:string[]};
try{
 const [flag,path,step]=process.argv.slice(2);if(flag!=='--config'||!path||!['backup','remove','restore','status'].includes(step))throw Error('options');
 const c=await loadWorkerConfig(path);process.env.SUPABASE_URL=c.SUPABASE_URL;process.env.SUPABASE_SERVICE_ROLE_KEY=c.SUPABASE_SERVICE_ROLE_KEY;
 const {loadRuntimeConfig,getConfig}=await import('../supabase/functions/_shared/config.ts');await loadRuntimeConfig();
 const api=new Api(getConfig('TELEGRAM_BOT_TOKEN')!,{timeoutSeconds:20,sensitiveLogs:false}),signal=()=>AbortSignal.timeout(20000) as never;
 const bot=await api.getMe(signal()),info=await api.getWebhookInfo(signal()),file=join(dirname(path),'flue-webhook-backup.json');
 if(step==='status'){console.log(JSON.stringify({status:'telegram_intake_status',webhook_active:!!info.url,pending_updates:info.pending_update_count}));}
 else if(step==='backup'){
  if(!info.url||info.has_custom_certificate||!getConfig('TELEGRAM_WEBHOOK_SECRET'))throw Error('unsupported webhook backup');
  const previous=await readProtectedJson<Backup>(file);if(previous&&(previous.botId!==bot.id||previous.url!==info.url))throw Error('backup mismatch');
  await writeProtectedJson(file,{botId:bot.id,url:info.url,secret_token:getConfig('TELEGRAM_WEBHOOK_SECRET'),max_connections:info.max_connections??40,allowed_updates:info.allowed_updates});
  console.log(JSON.stringify({status:'webhook_backup_saved',pending_updates:info.pending_update_count}));
 }else{
  const backup=await readProtectedJson<Backup>(file);if(!backup||backup.botId!==bot.id||!backup.url||!backup.secret_token||(info.url&&info.url!==backup.url))throw Error('backup mismatch');
  if(step==='remove')await api.deleteWebhook({drop_pending_updates:false},signal());
  else await api.setWebhook(backup.url,{secret_token:backup.secret_token,max_connections:backup.max_connections,allowed_updates:backup.allowed_updates as never,drop_pending_updates:false},signal());
  const after=await api.getWebhookInfo(signal());if(step==='remove'?!!after.url:after.url!==backup.url)throw Error('handoff verification failed');
  console.log(JSON.stringify({status:step==='remove'?'webhook_removed_pending_preserved':'webhook_restored',pending_updates:after.pending_update_count}));
 }
}catch{console.log(JSON.stringify({status:'webhook_handoff_failed'}));process.exitCode=1;}
