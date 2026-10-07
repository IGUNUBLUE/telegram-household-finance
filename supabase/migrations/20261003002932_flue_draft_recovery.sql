-- A reclaimed interpretation must recover existing draft identities rather
-- than invent another creation batch or alter committed draft facts.
create table private.agent_draft_effect_owners(
 event_id bigint primary key references private.events(id),
 actor text not null references private.members(id),
 attempt_token text not null,
 created_at timestamptz not null default now()
);
alter table private.agent_draft_effect_owners enable row level security;
revoke all on private.agent_draft_effect_owners from public,anon,authenticated;
grant all on private.agent_draft_effect_owners to service_role;
alter function public.finance_agent(text,jsonb) rename to finance_agent_v5;
create function public.finance_agent(op text,data jsonb default '{}') returns jsonb
 language plpgsql security invoker set search_path='' as $$
declare ev private.events%rowtype;owner_token text;r jsonb;drafts jsonb;
begin
 if op in ('draft_save','drafts_save','draft_cancel','draft_distinct_income') and data ? '_attempt_token' then
  select * into ev from private.events where id=(data->>'id')::bigint for update;
  if not found or ev.state<>'working' or ev.turn_token is distinct from data->>'_attempt_token'
   or ev.turn_until is null or ev.turn_until<=now() then raise exception 'inactive draft attempt';end if;
  select attempt_token into owner_token from private.agent_draft_effect_owners where event_id=ev.id;
  if owner_token is not null and owner_token<>ev.turn_token then
   -- The new attempt receives current actor-owned identities and revisions.
   -- Intentional corrections remain possible through the next user message.
   r:=public.finance_agent_v5('context',jsonb_build_object('id',ev.id));
   drafts:=coalesce(r->'drafts','[]'::jsonb);
   return jsonb_build_object('status','drafts_recovered','recovered',true,'ledger_changed',false,'drafts',drafts,
    'message','Los pendientes de este mensaje ya se conservaron antes del reintento. Usa sus referencias actuales; no crees ni cambies esos datos otra vez.');
  end if;
  r:=public.finance_agent_v5(op,data-'_attempt_token');
  insert into private.agent_draft_effect_owners(event_id,actor,attempt_token) values(ev.id,ev.actor,ev.turn_token)
   on conflict(event_id) do nothing;
  return r;
 end if;
 return public.finance_agent_v5(op,data);
end $$;
revoke all on function public.finance_agent(text,jsonb) from public,anon,authenticated;
grant execute on function public.finance_agent(text,jsonb) to service_role;
