/** Offline cutover only. Source is read-only; ledger, OAuth and Telegram are untouched. */
import {dirname,join} from 'node:path';
import {readProtectedJson} from './lib/subscription-session.ts';
import {openFlueSource} from './lib/flue-source.ts';
import {readFlueSnapshot,importFlueSnapshot,snapshotDigest} from './lib/flue-state-migration.ts';
let pool:Awaited<ReturnType<typeof openFlueSource>>|undefined;
try{
 const args=process.argv.slice(2);if(args.length!==4||args[0]!=='--config'||args[2]!=='--destination')throw Error('options');
 const owner=await readProtectedJson<{pid:number}>(join(dirname(args[1]),'subscription.lock'));
 if(owner){try{process.kill(owner.pid,0);throw Error('Live session owner; stop worker before migration');}catch(e){if((e as NodeJS.ErrnoException).code!=='ESRCH')throw e;}}
 pool=await openFlueSource(args[1]);const snapshot=await readFlueSnapshot(pool);const counts=await importFlueSnapshot(snapshot,args[3]);
 console.log(JSON.stringify({status:'flue_state_migrated',digest:snapshotDigest(snapshot),counts}));
}catch(e){console.log(JSON.stringify({status:'flue_state_migration_failed',reason:e instanceof Error&&/Live session owner|unfinished|checksum|Destination already|schema mismatch/.test(e.message)?e.message:'State migration unavailable'}));process.exitCode=1;}
finally{await pool?.end();}

