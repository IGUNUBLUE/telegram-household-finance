import {dirname,join} from 'node:path';
import {readdir,unlink,readFile} from 'node:fs/promises';
import {loadWorkerConfig} from './lib/worker-config.ts';
import {flueStatePath,backupFlueSqlite} from './lib/flue-sqlite.ts';
import {uploadPrivateFlueBackup} from './lib/flue-backup-storage.ts';
try{
 const args=process.argv.slice(2);if(args.length!==2||args[0]!=='--config')throw Error('options');const config=await loadWorkerConfig(args[1]);const directory=dirname(args[1]),backups=join(directory,'flue-backups');
 const name='flue-'+new Date().toISOString().replace(/[:.]/g,'-')+'.db';await backupFlueSqlite(flueStatePath(directory),join(backups,name));
 const result=await uploadPrivateFlueBackup(config,name,await readFile(join(backups,name)));
 const names=(await readdir(backups)).filter(n=>/^flue-[0-9TZ-]+\.db$/.test(n)).sort();for(const old of names.slice(0,-7))await unlink(join(backups,old));
 console.log(JSON.stringify({status:'flue_backup_passed',retained:Math.min(names.length,7),...result}));
}catch{console.log(JSON.stringify({status:'flue_backup_failed'}));process.exitCode=1;}

