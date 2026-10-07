-- A valid single duplicate must retain the existing explicit conflict workflow.
-- A duplicate in a compound operation still prevents applying the whole group.
do $$declare src text;needle text;begin
 src:=pg_get_functiondef('private.finance_approval_gate(bigint,jsonb)'::regprocedure);
 needle:=$n$if inspection->>'valid' is distinct from 'true' then return private.finance_approval_settle$n$;
 if position(needle in src)=0 then raise exception 'missing duplicate gate target';end if;
 execute replace(src,needle,$n$if inspection->>'valid' is distinct from 'true' and action_v->>'type'='post' and inspection->'issues'->0->>'code'='duplicate' then return null;end if;
 if inspection->>'valid' is distinct from 'true' then return private.finance_approval_settle$n$);
 src:=pg_get_functiondef('public.finance_agent(text,jsonb)'::regprocedure);
 needle:=$n$if inspection->>'valid' is distinct from 'true' then return private.finance_approval_settle$n$;
 if position(needle in src)=0 then raise exception 'missing duplicate agent target';end if;
 execute replace(src,needle,$n$if inspection->>'valid' is distinct from 'true' and a->>'type'='post' and inspection->'issues'->0->>'code'='duplicate' then return public.finance_agent_approval_previous(op,data);end if;
 if inspection->>'valid' is distinct from 'true' then return private.finance_approval_settle$n$);
end $$;

-- Snapshot every financial effect and the reporter's displayed identity.
alter table private.approval_requests add column reporter_name text;
do $$declare src text;needle text;begin
 src:=pg_get_functiondef('private.finance_approval_inspect(bigint,jsonb,jsonb)'::regprocedure);
 needle:=$n$'effective_operation',a$n$;
 if position(needle in src)=0 then raise exception 'missing immutable details target';end if;
 src:=replace(src,needle,$n$'effective_operation',a||jsonb_build_object('approval_items',items,'original_movement',old_action)$n$);
 needle:=$n$elsif a->>'type'='reverse' then$n$;
 src:=replace(src,needle,needle||$n$
  select original_event.action into old_action from private.transactions original_tx join private.events original_event on original_event.id=original_tx.event_id where original_tx.id=(a->>'target')::bigint;$n$);
 execute src;
end $$;
create or replace function private.finance_approval_details() returns trigger language plpgsql security invoker set search_path='' as $$
begin
 new.effective_action:=private.finance_approval_inspect(new.origin_event,new.action)->'effective_operation';
 new.reporter_name:=(select name from private.members where id=new.reporter);
 return new;
end $$;
-- A family movement does not consume the optional personal beneficiary retained
-- on its draft. Author, payer, accounts, version and financial values remain exact.
do $$declare src text;needle text;begin
 src:=pg_get_functiondef('private.finance_approval_inspect(bigint,jsonb,jsonb)'::regprocedure);
 needle:=$n$array['kind','account','other','payer','date','scope','beneficiary','counterparty']$n$;
 if position(needle in src)=0 then raise exception 'missing beneficiary validation target';end if;
 src:=replace(src,needle,$n$array['kind','account','other','payer','date','scope','counterparty']$n$);
 needle:=$n$if a->>'amount' is distinct from private.cop_cents(d.fields->>'amount_cop')::text$n$;
 src:=replace(src,needle,$n$if a->>'scope'='personal' and a->>'beneficiary' is distinct from d.fields->>'beneficiary' then raise exception 'action differs from stored draft';end if;
  $n$||needle);
 needle:=$n$pe.action=a-'{confirm_duplicate,pending_event_id}'::text[]$n$;
 if position(needle in src)=0 then raise exception 'missing duplicate inspection equality target';end if;
 src:=replace(src,needle,$n$pe.action-'_response_draft_ids'=a-'{confirm_duplicate,pending_event_id,_response_draft_ids}'::text[]$n$);execute src;
 src:=pg_get_functiondef('public.finance_api_approval_previous(text,jsonb)'::regprocedure);
 needle:=$n$action=a-'{confirm_duplicate,pending_event_id}'::text[]$n$;
 if position(needle in src)=0 then raise exception 'missing duplicate commit equality target';end if;
 execute replace(src,needle,$n$action-'_response_draft_ids'=a-'{confirm_duplicate,pending_event_id,_response_draft_ids}'::text[]$n$);
end $$;
create or replace function private.finance_approval_details() returns trigger language plpgsql security invoker set search_path='' as $$
begin
 new.effective_action:=private.finance_approval_inspect(new.origin_event,new.action)->'effective_operation';
 new.reporter_name:=(select name from private.members where id=new.reporter);
 -- The reporter already confirmed the proposal before this owner request.
 -- Its consent must survive the same 48h window; retries never extend it.
 if new.source_kind='proposal' and not exists(select 1 from private.approval_requests r where r.source_kind=new.source_kind and r.source_id=new.source_id and r.revision=new.revision and r.fingerprint=new.fingerprint) then
  update private.proposals set expires_at=new.expires_at where id::text=new.source_id and actor=new.reporter and state='pending';
 end if;
 return new;
end $$;
