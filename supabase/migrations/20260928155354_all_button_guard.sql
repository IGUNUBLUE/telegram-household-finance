-- Extend the existing atomic intake gate; confirmations retain their permanent target guard.
DO $$declare src text;needle text;replacement text;
begin
 src:=pg_get_functiondef('public.finance_ui(text,jsonb)'::regprocedure);
 needle:='if cb is null or cb!~''^(pconfirm|pcancel|confirm):[0-9]+$'' then return public.finance_api(''ingest'',data);end if;';
 replacement:=$patch$
 if cb is null then return public.finance_api('ingest',data);end if;
 if cb!~'^(pconfirm|pcancel|confirm):[0-9]+$' then
  if cb!~'^((detail|undo|reconcile):[0-9]+|edit:[0-9]+:(amount|account)|match:[0-9]+:[0-9]+)$' then
   return jsonb_build_object('accepted',false,'state','unsupported','remove_buttons',false);
  end if;
  key_v:='button:'||coalesce(data->'payload'->>'messageId','0')||':'||cb;
  select c.event_id into old_id from private.callback_claims c where c.actor=actor_v and c.action_key=key_v;
  if found then
   select * into e from private.events where id=old_id;
   if old_id=(data->>'update_id')::bigint or (e.state<>'failed' and (
    e.state in ('new','working') or (e.state='pending' and e.result is null)
    or exists(select 1 from private.outbox b where b.event_id=old_id and b.sent_at is null)
    or coalesce((select b.sent_at from private.outbox b where b.event_id=old_id),e.created_at)>now()-interval '3 seconds'
    or exists(select 1 from private.proposals qp where qp.id::text=e.result->>'proposal_id' and qp.actor=actor_v and qp.state='pending' and qp.expires_at>now())
   )) then return jsonb_build_object('accepted',false,'state','already_received','remove_buttons',false);end if;
  end if;
  r:=public.finance_api('ingest',data);
  insert into private.callback_claims(actor,action_key,event_id) values(actor_v,key_v,(data->>'update_id')::bigint) on conflict(actor,action_key) do update set event_id=excluded.event_id;
  return r||jsonb_build_object('accepted',true,'remove_buttons',false);
 end if;
$patch$;
 if position(needle in src)=0 then raise exception 'callback guard extension target missing';end if;
 execute replace(src,needle,replacement);
end $$;
