import {workerDatabase} from './worker-database.ts';
export async function approvalDatabase(){
 const f=await workerDatabase();let next=100000;
 const event=async(actor='101',text='Operación ficticia',route:any={})=>f.rpc('ingest',{update_id:next++,actor,name:actor==='101'?'Persona Uno':'Persona Dos',group:'-100123',payload:{actor,text,chatId:'-100123',chatType:'supergroup',...route}});
 for(const actor of ['101','202']){const e=await event(actor);await f.rpc('agent:apply',{id:e.id,action:{type:'account',name:actor==='101'?'Cuenta Uno':'Cuenta Dos',kind:'asset',owner:actor,amount:'0',date:'2026-10-05'}});}
 const enable=async(value=true)=>f.db.query('update private.household set manager_confirmations_enabled=$1 where id=1',[value]);
 const snapshotLedger=async()=>(await f.db.query<any>("select jsonb_build_object('transactions',(select coalesce(jsonb_agg(t order by t.id),'[]') from private.transactions t),'entries',(select coalesce(jsonb_agg(e order by e.id),'[]') from private.entries e),'accounts',(select coalesce(jsonb_agg(a order by a.id),'[]') from private.accounts a)) value")).rows[0].value;
 const inspection=(ev:any)=>({valid:true,operation:{type:'post',kind:'transfer',account:'Cuenta Dos',other:'Cuenta Uno',amount:'12319',date:'2026-10-05',payer:'202',scope:'family',memo:'Movimiento ficticio'},source_kind:'event',source_id:String(ev.id),source_revision:1,account_owners:{'Cuenta Dos':'202','Cuenta Uno':'101'},required_members:['202'],fingerprint:'fixture-transfer-'+ev.id});
 const request=async(ev:any)=>(await f.db.query<any>('select private.finance_approval_request($1,$2::jsonb) r',[ev.id,JSON.stringify(inspection(ev))])).rows[0].r;
 const elapse=async(ms:number)=>{await f.db.query("update private.approval_requests set created_at=created_at-($1::text||' milliseconds')::interval,expires_at=expires_at-($1::text||' milliseconds')::interval",[ms]);await f.db.query("update private.approval_notices set created_at=created_at-($1::text||' milliseconds')::interval,begin_at=begin_at-($1::text||' milliseconds')::interval",[ms]);};
 return {...f,event,enable,snapshotLedger,inspection,request,elapse};
}
