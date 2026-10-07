alter table private.household add column manager_confirmations_enabled boolean not null default false;
create table private.approval_requests(
 id bigint generated always as identity primary key,
 household_id integer not null default 1 references private.household(id),
 reporter text not null references private.members(id), origin_event bigint not null references private.events(id),
 source_kind text not null check(source_kind in ('event','draft','proposal')),source_id text not null,
 revision integer not null check(revision>0),fingerprint text not null,
 action jsonb not null check(jsonb_typeof(action)='object'),account_owners jsonb not null,
 required_members jsonb not null check(jsonb_typeof(required_members)='array' and jsonb_array_length(required_members)>0),
 state text not null default 'pending' check(state in ('pending','posted','rejected','cancelled','superseded','expired')),
 result jsonb,created_at timestamptz not null default now(),expires_at timestamptz not null default now()+interval '48 hours',
 unique(source_kind,source_id,revision,fingerprint)
);
create index approval_requests_pending on private.approval_requests(expires_at,id) where state='pending';
create table private.approval_decisions(
 request_id bigint not null references private.approval_requests(id),member_id text not null references private.members(id),
 event_id bigint not null references private.events(id),decision text not null check(decision in ('confirm','reject')),
 created_at timestamptz not null default now(),primary key(request_id,member_id)
);
create table private.approval_private_chats(member_id text primary key references private.members(id),chat_id text not null unique,enabled boolean not null default true,updated_at timestamptz not null default now(),check(chat_id=member_id));
create table private.approval_executions(event_id bigint primary key references private.events(id),request_id bigint not null references private.approval_requests(id),fingerprint text not null,action jsonb not null);
create table private.approval_notices(
 id bigint generated always as identity primary key,request_id bigint not null references private.approval_requests(id),
 member_id text not null references private.members(id),round smallint not null check(round between 1 and 3),
 outbox_id bigint unique references private.outbox(id),state text not null default 'queued' check(state in ('queued','reserved','sent','uncertain','undeliverable','cancelled')),
 chat_id text,thread_id bigint,telegram_message_id bigint,begin_at timestamptz,token text,fallback boolean not null default false,
 created_at timestamptz not null default now(),unique(request_id,member_id,round)
);
create index approval_notices_due on private.approval_notices(request_id,member_id,begin_at);
do $$declare t text;begin
 foreach t in array array['approval_requests','approval_decisions','approval_private_chats','approval_executions','approval_notices'] loop
 execute format('alter table private.%I enable row level security',t);
 execute format('grant all on private.%I to service_role',t);
 end loop;
end $$;
grant usage,select on sequence private.approval_requests_id_seq,private.approval_notices_id_seq to service_role;

create function private.finance_approval_json(request_v bigint) returns jsonb language sql stable security invoker set search_path='' as $$
 select to_jsonb(r)||jsonb_build_object('id',r.id::text,'accepted_members',coalesce((select jsonb_agg(d.member_id order by d.member_id) from private.approval_decisions d where d.request_id=r.id and d.decision='confirm'),'[]'::jsonb)) from private.approval_requests r where r.id=request_v
$$;
create function private.finance_approval_request(event_v bigint,inspection_v jsonb) returns jsonb language plpgsql security invoker set search_path='' as $$
declare e private.events%rowtype;rid bigint;
begin
 perform 1 from private.household where id=1 for update;
 select * into strict e from private.events where id=event_v;
 if inspection_v->>'valid' is distinct from 'true' or jsonb_typeof(inspection_v->'operation') is distinct from 'object'
  or jsonb_typeof(inspection_v->'required_members') is distinct from 'array' or jsonb_array_length(inspection_v->'required_members')=0
  or exists(select 1 from jsonb_array_elements(inspection_v->'required_members') x where jsonb_typeof(x)<>'string' or x#>>'{}'=e.actor or not exists(select 1 from private.members m where m.id=x#>>'{}')) then raise exception 'invalid approval inspection';end if;
 insert into private.approval_requests(reporter,origin_event,source_kind,source_id,revision,fingerprint,action,account_owners,required_members)
 values(e.actor,event_v,inspection_v->>'source_kind',inspection_v->>'source_id',(inspection_v->>'source_revision')::integer,inspection_v->>'fingerprint',inspection_v->'operation',inspection_v->'account_owners',inspection_v->'required_members')
 on conflict(source_kind,source_id,revision,fingerprint) do nothing returning id into rid;
 if rid is null then select id into strict rid from private.approval_requests where source_kind=inspection_v->>'source_kind' and source_id=inspection_v->>'source_id' and revision=(inspection_v->>'source_revision')::integer and fingerprint=inspection_v->>'fingerprint' and reporter=e.actor;end if;
 return private.finance_approval_json(rid);
end $$;
create function public.finance_approval(op text,data jsonb default '{}') returns jsonb language plpgsql security invoker set search_path='' as $$
declare actor_v text;
begin
 if op='enabled' then return jsonb_build_object('enabled',(select manager_confirmations_enabled from private.household where id=1));end if;
 if op='private_member' then return jsonb_build_object('allowed',exists(select 1 from private.members m join private.household h on h.id=1 where h.manager_confirmations_enabled and h.group_id=data->>'group' and m.id=data->>'actor' and m.id=data->>'chat_id'));end if;
 select actor into strict actor_v from private.events where id=(data->>'id')::bigint;
 if op='context' then return jsonb_build_object(
 'sent',(select coalesce(jsonb_agg(private.finance_approval_json(r.id) order by r.id),'[]') from private.approval_requests r where r.reporter=actor_v and r.state='pending' and r.expires_at>now()),
 'received',(select coalesce(jsonb_agg(private.finance_approval_json(r.id) order by r.id),'[]') from private.approval_requests r where r.required_members ? actor_v and r.state='pending' and r.expires_at>now() and not exists(select 1 from private.approval_decisions d where d.request_id=r.id and d.member_id=actor_v)));
 end if;
 raise exception 'unsupported approval operation';
end $$;
revoke all on function private.finance_approval_json(bigint),private.finance_approval_request(bigint,jsonb),public.finance_approval(text,jsonb) from public,anon,authenticated;
grant execute on function private.finance_approval_json(bigint),private.finance_approval_request(bigint,jsonb),public.finance_approval(text,jsonb) to service_role;
