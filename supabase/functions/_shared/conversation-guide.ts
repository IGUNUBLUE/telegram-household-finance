/** Derive next-step facts from persistent data; never infer financial values. */
export function conversationGuide(context:any){
 const pending=(context.drafts??[]).filter((d:any)=>d.state==='pending'&&(!d.actor||d.actor===context.actor)).map((d:any)=>{
  const f=d.fields??{};
  const counterpart=['transfer','borrow','lend','repayment','collection'].includes(f.kind);
  const missing=['kind','amount_cop','account','payer','date','scope',...(counterpart?['other']:[])].filter(k=>f[k]===undefined||f[k]===null||f[k]==='');
  const waiting=(context.approvals?.sent??[]).find((q:any)=>q.state==='pending'&&(q.source_kind==='draft'&&q.source_id===String(d.id)||q.action?.items?.some((a:any)=>a._draft_id===String(d.id))));
  const blockers=[...(d.issues??[]),...waiting?[{code:'approval_pending',request_id:waiting.id,message:'Esperando al responsable de la cuenta; todavía no registrado.'}]:[]];
  const unknown=[...new Set([f.account,counterpart?f.other:undefined].filter(v=>v&&!(context.accounts??[]).some((a:any)=>a.name===v)))];
  for(const account of unknown)blockers.push({code:'unknown_account',account});
  if(counterpart&&f.account&&f.account===f.other)blockers.push({code:'same_account',account:f.account,message:'La cuenta de origen y la deuda/destino no pueden ser la misma.'});
  return {draft_id:String(d.id),revision:d.revision,known:f,sources:d.sources??{},missing_fields:missing,
   optional_fields:!f.category&&['income','expense','refund'].includes(f.kind)?['category']:[],
   blockers,ready:missing.length===0&&blockers.length===0};
 });
 const focus=new Set(context.turn_focus?.draft_ids??[]);
 const previous=new Set(context.turn_focus?.previous_draft_ids??context.conversation?.previous_draft_ids??[]);
 return {pending,active_pending:pending.filter((d:any)=>focus.has(d.draft_id)),previous_pending:pending.filter((d:any)=>previous.has(d.draft_id)),background_pending:pending.filter((d:any)=>!focus.has(d.draft_id)),registered_recently:context.recent_completed??[],pending_proposals:context.pending_proposals??[]};
}
/** A receipt does not authorize resuming unrelated older work. */
export function narrationContext(result:any,context:any){
 const ids=new Set<string>(context.turn_focus?.draft_ids??[]);
 for(const id of result.linked_pending??[])ids.add(String(id));
 return {...context,turn_focus:{draft_ids:[...ids]}};
}
/** Retry focus comes from stored actor-owned event provenance, never text guesses. */
export function recoverTurnFocus(context:any,eventId:number){
 return (context.drafts??[]).filter((d:any)=>d.state==='pending'&&(!d.actor||d.actor===context.actor)
  &&(String(d.origin_event)===String(eventId)||Object.values(d.sources??{}).some(id=>String(id)===String(eventId))))
  .map((d:any)=>String(d.id));
}
export function withConversationGuide(context:any){const {event_attempt_token,...safe}=context;return {...safe,conversation_guide:conversationGuide(context)};}
