import test from 'node:test';import assert from 'node:assert/strict';
import {generateKeyPair,SignJWT,createLocalJWKSet,exportJWK} from 'jose';
import * as auth from '../scripts/lib/subscription-auth.ts';
test('Subscription login uses a distinct dynamic client, PKCE, nonce and loopback callback',()=>{
 assert.equal(typeof auth.createLoginAttempt,'function');
 const a=auth.createLoginAttempt('http://127.0.0.1:1455/auth/callback','urn:uuid:test-host');
 const url=new URL(a.url);assert.equal(url.origin,'https://auth.openai.com');assert.equal(url.searchParams.get('client_id'),'dynamic_agent_client');assert.equal(url.searchParams.get('code_challenge_method'),'S256');assert.ok(a.nonce);assert.ok(a.state);assert.ok(a.verifier);
 assert.throws(()=>auth.createLoginAttempt('https://example.org/callback','host'),/loopback/);
});
test('Callback rejects wrong state, denied consent and missing issued client before exchange',async()=>{
 const a=auth.createLoginAttempt('http://127.0.0.1:1455/auth/callback','host');let requests=0;
 const send:typeof fetch=async()=>{requests++;return Response.json({});};
 await assert.rejects(auth.completeLogin(a,new URL(a.redirectUri+'?state=wrong&code=x&client_id=oaiapp_test'),send),/state/);
 await assert.rejects(auth.completeLogin(a,new URL(a.redirectUri+'?state='+a.state+'&error=access_denied'),send),/autorización/);
 await assert.rejects(auth.completeLogin(a,new URL(a.redirectUri+'?state='+a.state+'&code=x'),send),/client/);
 assert.equal(requests,0);
});
test('OAuth completion validates signed identity and granted plan scope',async()=>{
 const a=auth.createLoginAttempt('http://127.0.0.1:1455/auth/callback','host');
 const {privateKey,publicKey}=await generateKeyPair('RS256');const jwk=await exportJWK(publicKey);jwk.kid='test';
 const sign=(nonce:string)=>new SignJWT({nonce}).setProtectedHeader({alg:'RS256',kid:'test'}).setIssuer('https://auth.openai.com').setAudience('oaiapp_test').setSubject('test-user').setIssuedAt().setExpirationTime('5m').sign(privateKey);
 const responseFor=(id_token:string,scope='openid offline_access resource.invoke chatgpt.tokens.use.direct')=>async(_url:any,init:any)=>{
  const body=new URLSearchParams(init.body);assert.equal(body.get('client_id'),'oaiapp_test');assert.equal(body.get('redirect_uri'),a.redirectUri);assert.equal(body.get('code_verifier'),a.verifier);
  return Response.json({access_token:'synthetic-access',refresh_token:'synthetic-refresh',id_token,scope,expires_in:3600,token_type:'Bearer'});
 };
 const cb=new URL(a.redirectUri+'?state='+a.state+'&code=test&client_id=oaiapp_test');const keys=createLocalJWKSet({keys:[jwk]});
 const r=await auth.completeLogin(a,cb,responseFor(await sign(a.nonce)),keys);assert.equal(r.subject,'test-user');assert.equal(r.client_id,'oaiapp_test');
 await assert.rejects(auth.completeLogin(a,cb,responseFor(await sign('wrong')),keys),/nonce/);
 await assert.rejects(auth.completeLogin(a,cb,responseFor(await sign(a.nonce),'openid'),keys),/plan/);
 const wrong=createLocalJWKSet({keys:[{...jwk,n:(await exportJWK((await generateKeyPair('RS256')).publicKey)).n}]});
 await assert.rejects(auth.completeLogin(a,cb,responseFor(await sign(a.nonce)),wrong));
});
