import {test} from 'node:test';
import assert from 'node:assert/strict';
import {uploadPrivateFlueBackup} from '../scripts/lib/flue-backup-storage.ts';
const config={SUPABASE_URL:'https://fixture.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'test-secret'};
test('offsite backup refuses public storage before uploading private history',async()=>{
 const calls:string[]=[];
 const request:typeof fetch=async input=>{calls.push(String(input));return new Response(JSON.stringify({public:true}),{status:200});};
 await assert.rejects(uploadPrivateFlueBackup(config,'flue-2026-10-03T03-00-00-000Z.db',Buffer.from('snapshot'),request));
 assert.equal(calls.length,1);
});
test('offsite backup verifies uploaded bytes before pruning old snapshots',async()=>{
 const data=Buffer.from('consistent snapshot');const calls:string[]=[];
 const request:typeof fetch=async(input,options)=>{
  const url=String(input);calls.push((options?.method??'GET')+' '+url);
  if(url.includes('/bucket/'))return Response.json({public:false});
  if(url.includes('/authenticated/'))return new Response(data);
  if(url.includes('/list/'))return Response.json([{name:'flue-2020-01-01T00-00-00-000Z.db'},...Array.from({length:7},(_,i)=>({name:`flue-2026-10-0${i+1}T00-00-00-000Z.db`}))]);
  return Response.json({});
 };
 await uploadPrivateFlueBackup(config,'flue-2026-10-03T03-00-00-000Z.db',data,request);
 assert.ok(calls.findIndex(c=>c.includes('/authenticated/'))<calls.findIndex(c=>c.startsWith('DELETE ')));
 const bad:typeof fetch=async(input,options)=>String(input).includes('/authenticated/')?new Response('corrupt'):request(input,options);
 calls.length=0;await assert.rejects(uploadPrivateFlueBackup(config,'flue-2026-10-03T03-00-00-000Z.db',data,bad));
 assert.ok(!calls.some(c=>c.startsWith('DELETE ')));
});
