import {test} from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,readFile,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import {execFile} from 'node:child_process';import {promisify} from 'node:util';
const exec=promisify(execFile);
test('Flue survives a process restart and does not resume stale tools after a crash',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'finance-flue-restart-'));const db=join(directory,'state.db'),counter=join(directory,'counter.json');
 try{
  const run=(mode:string)=>exec(process.execPath,['tests/fixtures/flue-recovery-process.ts',db,counter,mode],{timeout:15000});
  await run('complete');assert.equal(JSON.parse(await readFile(counter,'utf8')).effects,1);
  await run('replay');assert.equal(JSON.parse(await readFile(counter,'utf8')).effects,1);
  await run('crash');assert.equal(JSON.parse(await readFile(counter,'utf8')).effects,2);
  const recovered=await run('recover');assert.match(recovered.stdout,/stale_tools_blocked/);assert.equal(JSON.parse(await readFile(counter,'utf8')).effects,2);
 }finally{await rm(directory,{recursive:true,force:true});}
});
