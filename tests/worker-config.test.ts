import {test} from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,rm,symlink,chmod} from 'node:fs/promises';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {loadWorkerConfig} from '../scripts/lib/worker-config.ts';
import {writeProtectedJson} from '../scripts/lib/subscription-session.ts';
test('worker config accepts only protected explicit backend fields',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'finance-worker-'));const path=join(dir,'worker.json');try{
  const good={SUPABASE_URL:'https://fictional.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'fictional-backend-key'};
  await writeProtectedJson(path,good);assert.deepEqual(await loadWorkerConfig(path),good);
  await writeProtectedJson(path,{...good,NODE_OPTIONS:'--import unknown'});await assert.rejects(loadWorkerConfig(path),/configur/i);
  await writeProtectedJson(path,{...good,SUPABASE_URL:'http://example.test'});await assert.rejects(loadWorkerConfig(path));
  await writeProtectedJson(path,good);await chmod(path,0o644);await assert.rejects(loadWorkerConfig(path),/proteg/);
  await rm(path);await symlink('other.json',path);await assert.rejects(loadWorkerConfig(path),/proteg/);
 }finally{await rm(dir,{recursive:true,force:true});}
});
