alter table private.outbox add column chat_id text,add column target_thread_id bigint,add column target_message_id bigint,
 add column purpose text check(purpose in ('approval_notice','approval_ack','approval_card_update','receipt')),
 add column approval_notice_id bigint references private.approval_notices(id);

-- Capture resolved proposal contents and current ownership, not only proposal ID.
do $$declare src text;needle text;begin
 src:=pg_get_functiondef('private.finance_approval_inspect(bigint,jsonb,jsonb)'::regprocedure);
 needle:=$n$'fingerprint',md5((action_v-'{_response_draft_ids,_approval_id,confirm_owner}'::text[])::text)$n$;
 if position(needle in src)=0 then raise exception 'missing approval fingerprint target';end if;
 execute replace(src,needle,$n$'fingerprint',md5(jsonb_build_object('action',action_v-'{_response_draft_ids,_approval_id,confirm_owner}'::text[],'effective',a-'{_response_draft_ids,_approval_id,confirm_owner}'::text[],'owners',owners)::text)$n$);
end $$;

create function private.finance_approval_invalidate() returns trigger language plpgsql security invoker set search_path='' as $$
begin
 if tg_table_name='agent_drafts' then
  update private.approval_requests r set state=case when new.state='cancelled' then 'cancelled' else 'superseded' end
   where r.state='pending' and ((r.source_kind='draft' and r.source_id=new.id::text and (r.revision<>new.revision or new.state<>'pending'))
    or (r.source_kind='proposal' and exists(select 1 from private.proposals p,jsonb_array_elements(coalesce(p.action->'linked_drafts','[]')) x where p.id::text=r.source_id and x->>'draft_id'=new.id::text)))
   and not exists(select 1 from private.approval_executions ex where ex.event_id::text=current_setting('finance.approval_execution',true) and ex.request_id=r.id);
 elsif tg_table_name='proposals' then
  update private.approval_requests r set state=case when new.state='cancelled' then 'cancelled' else 'superseded' end where r.state='pending' and r.source_kind='proposal' and r.source_id=new.id::text and (new.action is distinct from old.action or new.state<>'pending')
   and not exists(select 1 from private.approval_executions ex where ex.event_id::text=current_setting('finance.approval_execution',true) and ex.request_id=r.id);
 elsif tg_table_name='accounts' then
  if new.owner is distinct from old.owner or new.name is distinct from old.name or new.management_mode is distinct from old.management_mode or new.parent_account_id is distinct from old.parent_account_id then
   update private.approval_requests set state='superseded' where state='pending' and account_owners ? old.name;
  end if;
 end if;
 update private.approval_notices n set state='cancelled' where n.state='queued' and exists(select 1 from private.approval_requests r where r.id=n.request_id and r.state<>'pending');
 return new;
end $$;
create trigger approval_draft_invalidated after update of revision,fields,state on private.agent_drafts for each row execute function private.finance_approval_invalidate();
create trigger approval_proposal_invalidated after update of action,state on private.proposals for each row execute function private.finance_approval_invalidate();
create trigger approval_owner_invalidated after update of owner,name,management_mode,parent_account_id on private.accounts for each row execute function private.finance_approval_invalidate();

create function private.finance_approval_refresh(request_v bigint) returns jsonb language plpgsql security invoker set search_path='' as $$
declare q private.approval_requests%rowtype;i jsonb;
begin
 select * into strict q from private.approval_requests where id=request_v for update;
 if q.state='pending' then
  if q.expires_at<=now() then update private.approval_requests set state='expired' where id=q.id;
  else
   begin
    i:=private.finance_approval_inspect(q.origin_event,q.action);
    if i->>'valid' is distinct from 'true' or i->>'fingerprint' is distinct from q.fingerprint then update private.approval_requests set state='superseded' where id=q.id;end if;
   exception when others then update private.approval_requests set state='superseded' where id=q.id;end;
  end if;
 end if;
 return private.finance_approval_json(q.id);
end $$;

create function private.finance_approval_reply(event_v bigint) returns jsonb language sql stable security invoker set search_path='' as $$
 select private.finance_approval_json(n.request_id) from private.events e join private.approval_notices n
 on n.telegram_message_id=(e.payload->>'replyTo')::bigint and n.chat_id=coalesce(e.payload->>'chatId',e.payload->>'group',(select group_id from private.household where id=1))
 and coalesce(n.thread_id,0)=coalesce((e.payload->>'threadId')::bigint,0) and n.member_id=e.actor
 where e.id=event_v order by n.id desc limit 1
$$;
create function private.finance_approval_evidence(event_v bigint) returns jsonb language plpgsql stable security invoker set search_path='' as $$
declare e private.events%rowtype;m text[];text_v text;reply_v jsonb;decision_v text;
begin
 select * into strict e from private.events where id=event_v;
 m:=regexp_match(coalesce(e.payload->>'callback',''),'^(aconfirm|areject):([0-9]+):([0-9]+)$');
 if m is not null then return jsonb_build_object('request_id',m[2],'revision',m[3]::integer,'decision',case when m[1]='aconfirm' then 'confirm' else 'reject' end);end if;
 text_v:=btrim(translate(lower(coalesce(e.payload->>'text','')),'áéíóú','aeiou'));
 m:=regexp_match(text_v,'^(confirmar|confirmo|aceptar|acepto|rechazar|rechazo|cancelar)( la)? solicitud ([0-9]+)[.!]*$');
 if m is not null then return jsonb_build_object('request_id',m[3],'decision',case when m[1] in ('rechazar','rechazo','cancelar') then 'reject' else 'confirm' end);end if;
 if text_v~'^(si|correcto|confirmo|confirmar|acepto)[.!]*$' then decision_v:='confirm';
 elsif text_v~'^(no|rechazo|rechazar|cancelar)[.!]*$' then decision_v:='reject';else return null;end if;
 reply_v:=private.finance_approval_reply(event_v);
 if reply_v is null then return null;end if;
 return jsonb_build_object('request_id',reply_v->>'id','revision',reply_v->'revision','decision',decision_v);
end $$;

alter function public.finance_approval(text,jsonb) rename to finance_approval_state_previous;
create function public.finance_approval(op text,data jsonb default '{}') returns jsonb language plpgsql security invoker set search_path='' as $$
declare e private.events%rowtype;r jsonb;q private.approval_requests%rowtype;evidence jsonb;child bigint;old_context text;result_v jsonb;group_v text;chat_v text;inspection jsonb;
begin
 if op in ('enabled','private_member','context') then return public.finance_approval_state_previous(op,data);end if;
 perform 1 from private.household where id=1 for update;
 select group_id into group_v from private.household where id=1;
 if op='ingest' then
  if not exists(select 1 from private.household h join private.members m on m.id=data->>'actor' where h.id=1 and h.manager_confirmations_enabled and h.group_id=data->>'group'
   and data->'payload'->>'chatType'='private' and data->'payload'->>'chatId'=m.id and data->'payload'->>'actor'=m.id) then return jsonb_build_object('state','unauthorized','accepted',false);end if;
  insert into private.events(id,actor,payload,message_id,thread_id) values((data->>'update_id')::bigint,data->>'actor',data->'payload',(data->'payload'->>'messageId')::bigint,(data->'payload'->>'threadId')::bigint) on conflict(id) do nothing;
  return (select jsonb_build_object('id',id,'state',state,'result',result) from private.events where id=(data->>'update_id')::bigint);
 end if;
 select * into strict e from private.events where id=(data->>'id')::bigint for update;
 chat_v:=coalesce(e.payload->>'chatId',group_v);
 if chat_v<>group_v and (e.payload->>'chatType' is distinct from 'private' or chat_v<>e.actor) then raise exception 'invalid approval route';end if;
 if op='reply_target' then r:=private.finance_approval_reply(e.id);return coalesce(r,jsonb_build_object('found',false));end if;
 if e.result is not null then return e.result;end if;
 if op='private_start' then
  if e.payload->>'chatType' is distinct from 'private' or chat_v<>e.actor or lower(e.payload->>'text')!~'^/?start([ @].*)?$' then raise exception 'private start required';end if;
  insert into private.approval_private_chats(member_id,chat_id) values(e.actor,chat_v) on conflict(member_id) do update set enabled=true,updated_at=now();
  result_v:=jsonb_build_object('status','ok','message','Listo: puedes recibir recordatorios y confirmar solicitudes aquí. Abrir este chat no confirma ningún movimiento.');
 elsif op='resolve' then
  evidence:=private.finance_approval_evidence(e.id);
  select * into q from private.approval_requests where id=(data->>'request_id')::bigint for update;
  if not found or not(q.required_members ? e.actor) or evidence is null or evidence->>'request_id' is distinct from q.id::text
   or evidence->>'decision' is distinct from data->>'decision' or q.revision is distinct from (data->>'revision')::integer
   or (evidence ? 'revision' and (evidence->>'revision')::integer is distinct from q.revision) then
   result_v:=jsonb_build_object('status','clarify','message','Responde a la solicitud dirigida a ti o usa sus botones para confirmar o rechazar.');
  else
   r:=private.finance_approval_refresh(q.id);select * into q from private.approval_requests where id=q.id;
   if q.state='posted' then result_v:=q.result||jsonb_build_object('already_resolved',true,'request_id',q.id::text,'message','Esta solicitud ya quedó registrada; no la registré otra vez.');
   elsif q.state<>'pending' then result_v:=jsonb_build_object('status','clarify','request_id',q.id::text,'message','Esta solicitud ya no está pendiente: cambió, venció o fue rechazada.');
   elsif data->>'decision'='reject' then
    insert into private.approval_decisions(request_id,member_id,event_id,decision) values(q.id,e.actor,e.id,'reject') on conflict do nothing;
    update private.approval_requests set state='rejected' where id=q.id;
    result_v:=jsonb_build_object('status','approval_rejected','request_id',q.id::text,'message','Solicitud rechazada. No registré el movimiento.');
    insert into private.outbox(message,result,chat_id,target_thread_id,purpose) values(result_v->>'message',result_v,group_v,(select thread_id from private.events where id=q.origin_event),'approval_ack');
   else
    insert into private.approval_decisions(request_id,member_id,event_id,decision) values(q.id,e.actor,e.id,'confirm') on conflict do nothing;
    if exists(select 1 from jsonb_array_elements_text(q.required_members)m where not exists(select 1 from private.approval_decisions d where d.request_id=q.id and d.member_id=m and d.decision='confirm')) then
     result_v:=jsonb_build_object('status','approval_pending','request_id',q.id::text,'message','Confirmación recibida. Falta la confirmación del otro responsable.');
    else
     child:=nextval('private.child_event_seq');
     insert into private.events(id,actor,parent_event_id,action) values(child,q.reporter,q.origin_event,q.action);
     insert into private.approval_executions(event_id,request_id,fingerprint,action) values(child,q.id,q.fingerprint,q.action);
     old_context:=current_setting('finance.approval_execution',true);perform set_config('finance.approval_execution',child::text,true);
     result_v:=public.finance_agent('apply',jsonb_build_object('id',child,'action',q.action));
     perform set_config('finance.approval_execution',coalesce(old_context,''),true);
     if result_v->>'status'<>'ok' then raise exception 'approved operation could not be committed';end if;
     result_v:=result_v||jsonb_build_object('request_id',q.id::text);
     update private.approval_requests set state='posted',result=result_v where id=q.id;
     update private.outbox set result=result_v,chat_id=group_v,target_thread_id=(select thread_id from private.events where id=q.origin_event),purpose='receipt' where event_id=child;
    end if;
   end if;
   update private.approval_notices set state='cancelled' where request_id=q.id and member_id=e.actor and state='queued';
  end if;
 else raise exception 'unsupported approval operation';end if;
 -- Monetary receipt lives in the group. A decision ack never edits that receipt.
 update private.events set result=result_v,state='done' where id=e.id;
 if chat_v<>group_v or result_v->>'status'<>'ok' or coalesce((result_v->>'already_resolved')::boolean,false) then
  r:=case when result_v ? 'transaction_id' then jsonb_build_object('status','ok','request_id',result_v->>'request_id','message','Confirmación recibida. El comprobante quedó en el grupo.') else result_v end;
  insert into private.outbox(event_id,message,result,chat_id,target_thread_id,target_message_id,purpose) values(e.id,r->>'message',r,chat_v,(e.payload->>'threadId')::bigint,e.message_id,'approval_ack');
 end if;
 return result_v;
end $$;

alter function public.finance_ui(text,jsonb) rename to finance_ui_approval_previous;
create function public.finance_ui(op text,data jsonb default '{}') returns jsonb language plpgsql security invoker set search_path='' as $$
declare cb text:=data->'payload'->>'callback';q private.approval_requests%rowtype;
begin
 if op='ingest' and cb~'^(aconfirm|areject):[0-9]+:[0-9]+$' then
  perform 1 from private.household where id=1 for update;
  if (select group_id from private.household where id=1) is distinct from data->>'group' then raise exception 'wrong group';end if;
  select * into q from private.approval_requests where id=split_part(cb,':',2)::bigint;
  if not found or not(q.required_members ? (data->>'actor')) then return jsonb_build_object('state','unauthorized','accepted',false,'remove_buttons',false);end if;
  if q.state<>'pending' or q.expires_at<=now() or q.revision<>split_part(cb,':',3)::integer then return jsonb_build_object('state','resolved','accepted',false,'remove_buttons',true);end if;
  return public.finance_api('ingest',data);
 end if;
 return public.finance_ui_approval_previous(op,data);
end $$;
revoke all on function private.finance_approval_invalidate(),private.finance_approval_refresh(bigint),private.finance_approval_reply(bigint),private.finance_approval_evidence(bigint),public.finance_approval(text,jsonb),public.finance_ui(text,jsonb) from public,anon,authenticated;
grant execute on function private.finance_approval_invalidate(),private.finance_approval_refresh(bigint),private.finance_approval_reply(bigint),private.finance_approval_evidence(bigint),public.finance_approval(text,jsonb),public.finance_ui(text,jsonb) to service_role;
