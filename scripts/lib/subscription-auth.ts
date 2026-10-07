import {randomBytes,createHash} from 'node:crypto';
import {createRemoteJWKSet,jwtVerify,type JWTVerifyGetKey} from 'jose';
const issuer='https://auth.openai.com',resource='https://api.openai.com/v1';
const remoteKeys=createRemoteJWKSet(new URL(issuer+'/.well-known/jwks.json'));
export type SubscriptionCredentials={issuer:string;subject:string;client_id:string;ext_agent_host_id:string;access_token:string;refresh_token:string;id_token:string;scopes:string[];expires_at:number;model?:string};
export function createLoginAttempt(redirectUri:string,hostId:string,previous?:Pick<SubscriptionCredentials,'client_id'|'subject'>){
 const uri=new URL(redirectUri);if(uri.protocol!=='http:'||uri.hostname!=='127.0.0.1'||uri.pathname!=='/auth/callback'||uri.search||uri.hash)throw Error('OAuth requiere callback loopback');
 const state=randomBytes(32).toString('base64url'),nonce=randomBytes(32).toString('base64url'),verifier=randomBytes(64).toString('base64url');
 const url=new URL(issuer+'/api/accounts/authorize');url.search=new URLSearchParams({client_id:previous?.client_id??'dynamic_agent_client',ext_agent_host_id:hostId,
  ...(!previous?{agent_name_hint:'Finanzas Familiares'}:{}),response_type:'code',redirect_uri:redirectUri,scope:'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct',resource,state,nonce,code_challenge_method:'S256',code_challenge:createHash('sha256').update(verifier).digest('base64url')}).toString();
 return {redirectUri,hostId,state,nonce,verifier,url:url.toString(),previous,expiresAt:Date.now()+5*60_000};
}
type Attempt=ReturnType<typeof createLoginAttempt>;
async function tokenRequest(data:Record<string,string>,send:typeof fetch){
 const r=await send(issuer+'/api/accounts/oauth/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams(data),signal:AbortSignal.timeout(20_000)});
 if(!r.ok)throw Error('No se pudo obtener la autorización de ChatGPT ('+r.status+')');
 return r.json();
}
async function credentials(tokens:any,client:string,host:string,keys:JWTVerifyGetKey,expected:{nonce?:string;subject?:string},previous?:SubscriptionCredentials):Promise<SubscriptionCredentials>{
 const scopes=typeof tokens.scope==='string'?tokens.scope.split(/\s+/):previous?.scopes??[];
 if(!scopes.includes('chatgpt.tokens.use.direct')||!scopes.includes('resource.invoke'))throw Error('No se autorizó el uso del plan de ChatGPT');
 if(typeof tokens.access_token!=='string'||!tokens.access_token||!(tokens.refresh_token??previous?.refresh_token)||tokens.token_type?.toLowerCase()!=='bearer'||!Number.isFinite(tokens.expires_in)||tokens.expires_in<=0||tokens.expires_in>86400)throw Error('Autorización incompleta');
 let subject=previous?.subject;
 if(tokens.id_token){
  const {payload}=await jwtVerify(tokens.id_token,keys,{issuer,audience:client,requiredClaims:['sub','exp','iat'],clockTolerance:5});
  if(expected.nonce&&payload.nonce!==expected.nonce)throw Error('OAuth nonce incorrecto');
  if(typeof payload.sub!=='string'||!payload.sub||expected.subject&&payload.sub!==expected.subject)throw Error('La autorización pertenece a otra cuenta');
  subject=payload.sub;
 }else if(!previous)throw Error('Falta identidad firmada de ChatGPT');
 if(!subject)throw Error('Identidad no validada');
 return {issuer,subject,client_id:client,ext_agent_host_id:host,access_token:tokens.access_token,refresh_token:tokens.refresh_token??previous!.refresh_token,id_token:tokens.id_token??previous!.id_token,scopes,expires_at:Date.now()+tokens.expires_in*1000,model:previous?.model};
}
export async function completeLogin(attempt:Attempt,callback:URL,send:typeof fetch=fetch,keys:JWTVerifyGetKey=remoteKeys){
 if(Date.now()>attempt.expiresAt)throw Error('OAuth expirado');
 if(callback.origin!==new URL(attempt.redirectUri).origin||callback.pathname!=='/auth/callback'||callback.searchParams.get('state')!==attempt.state)throw Error('OAuth state incorrecto');
 if(callback.searchParams.get('error'))throw Error('No se concedió la autorización de ChatGPT');
 const client=callback.searchParams.get('client_id')??attempt.previous?.client_id;
 if(!client||client==='dynamic_agent_client'||attempt.previous&&client!==attempt.previous.client_id)throw Error('Falta el client emitido por ChatGPT');
 const code=callback.searchParams.get('code');if(!code)throw Error('Falta código de autorización');
 const tokens=await tokenRequest({grant_type:'authorization_code',client_id:client,code,code_verifier:attempt.verifier,redirect_uri:attempt.redirectUri,resource},send);
 return credentials(tokens,client,attempt.hostId,keys,{nonce:attempt.nonce,subject:attempt.previous?.subject});
}
export async function refreshCredentials(previous:SubscriptionCredentials,send:typeof fetch=fetch,keys:JWTVerifyGetKey=remoteKeys){
 const tokens=await tokenRequest({grant_type:'refresh_token',client_id:previous.client_id,refresh_token:previous.refresh_token,resource},send);
 return credentials(tokens,previous.client_id,previous.ext_agent_host_id,keys,{subject:previous.subject},previous);
}
