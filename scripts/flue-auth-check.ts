/** Controlled handoff only: previous session owner must be stopped first. */
import {dirname} from 'node:path';import {loadWorkerConfig} from './lib/worker-config.ts';import {openSubscriptionSession,type SubscriptionSession} from './lib/subscription-session.ts';import {createPiRefresh,createProtectedPiProvider} from './lib/pi-provider.ts';import {probeFlueAuthorization} from './lib/flue-auth-probe.ts';
let session:SubscriptionSession|undefined;
try{
 const args=process.argv.slice(2);if(args.length!==2||args[0]!=='--config')throw Error('options');await loadWorkerConfig(args[1]);const refresh=createPiRefresh();session=await openSubscriptionSession({directory:dirname(args[1]),refresh});
 // Force one real native rotation under the same exclusive lock; save before use.
 await session.save(await refresh(session.credentials()!));
 const catalog=await fetch('https://api.openai.com/v1/models',{headers:{Authorization:'Bearer '+await session.accessToken()},signal:AbortSignal.timeout(20000)});if(!catalog.ok)throw Error('catalog');const provider=createProtectedPiProvider(session,await catalog.json()),model=provider.getModels()[0];
 await probeFlueAuthorization(provider as unknown as Parameters<typeof probeFlueAuthorization>[0]);
 console.log(JSON.stringify({status:'native_pi_refresh_passed',model:model.id}));
}catch{console.log(JSON.stringify({status:'native_pi_refresh_failed'}));process.exitCode=1;}
finally{await session?.close();}
