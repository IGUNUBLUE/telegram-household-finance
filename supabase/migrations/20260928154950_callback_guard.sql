create table private.callback_claims(actor text not null references private.members(id),action_key text not null,event_id bigint not null references private.events(id),primary key(actor,action_key));
alter table private.callback_claims enable row level security;
grant all on private.callback_claims to service_role;
create function public.finance_ui(op text,data jsonb default '{}') returns jsonb language plpgsql security invoker set search_path='' as $$
declare cb text:=data->'payload'->>'callback';key_v text;target_v bigint;actor_v text:=data->>'actor';p private.proposals%rowtype;e private.events%rowtype;r jsonb;old_id bigint;
begin
 if op<>'ingest' then raise exception 'unsupported ui operation';end if;
 perform 1 from private.household where id=1 for update;
 if (select group_id from private.household where id=1) is distinct from data->>'group' then raise exception 'wrong group';end if;
 if cb is null or cb!~'^(pconfirm|pcancel|confirm):[0-9]+$' then return public.finance_api('ingest',data);end if;
 target_v:=split_part(cb,':',2)::bigint;
 if cb~'^p' then
  select * into p from private.proposals where id=target_v;
  if not found or p.actor<>actor_v then return jsonb_build_object('accepted',false,'state','unauthorized','remove_buttons',false);end if;
  if p.state<>'pending' or p.expires_at<=now() then return jsonb_build_object('accepted',false,'state','resolved','remove_buttons',true);end if;
  key_v:='proposal:'||target_v;
 else
  select * into e from private.events where id=target_v;
  if not found or e.actor<>actor_v then return jsonb_build_object('accepted',false,'state','unauthorized','remove_buttons',false);end if;
  if e.state<>'pending' or e.action->>'type'<>'post' or e.created_at<now()-interval '48 hours' then return jsonb_build_object('accepted',false,'state','resolved','remove_buttons',true);end if;
  key_v:='duplicate:'||target_v;
 end if;
 select event_id into old_id from private.callback_claims where actor=actor_v and action_key=key_v;
 if found then
  select * into e from private.events where id=old_id;
  if e.state<>'failed' or old_id=(data->>'update_id')::bigint then return jsonb_build_object('accepted',false,'state','already_received','remove_buttons',true);end if;
 end if;
 r:=public.finance_api('ingest',data);
 insert into private.callback_claims(actor,action_key,event_id) values(actor_v,key_v,(data->>'update_id')::bigint) on conflict(actor,action_key) do update set event_id=excluded.event_id;
 return r||jsonb_build_object('accepted',true,'remove_buttons',true);
end $$;
revoke all on function public.finance_ui(text,jsonb) from public,anon,authenticated;
grant execute on function public.finance_ui(text,jsonb) to service_role;
