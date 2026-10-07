-- One Telegram message may describe several independent movements. A stable key
-- identifies each new draft within that event; retries keep the original receipt.
alter table private.agent_drafts add column item_key text not null default 'single'
 check(length(item_key) between 1 and 64);
alter table private.agent_drafts drop constraint agent_drafts_origin_event_key;
alter table private.agent_drafts add constraint agent_drafts_origin_item_key unique(origin_event,item_key);
alter table private.agent_drafts add column opening_distinction jsonb;
alter table private.events add column parent_event_id bigint references private.events(id);
create index events_parent_event on private.events(parent_event_id) where parent_event_id is not null;
do $$declare src text;patched text;
begin
 src:=pg_get_functiondef('public.finance_agent_v3(text,jsonb)'::regprocedure);
 patched:=replace(src,'where origin_event=ev.id) then raise exception',
  'where origin_event=ev.id and item_key=coalesce(data->>''item_key'',''single'')) then raise exception');
 if src=patched then raise exception 'Missing draft uniqueness patch';end if;src:=patched;
 patched:=replace(src,'insert into private.agent_drafts(actor,origin_event,fields,sources) values(ev.actor,ev.id,',
  'insert into private.agent_drafts(actor,origin_event,item_key,fields,sources) values(ev.actor,ev.id,coalesce(data->>''item_key'',''single''),');
 if src=patched then raise exception 'Missing draft insert patch';end if;execute patched;
end $$;

-- This is a warning about an overlapping interpretation, not an automatic edit.
-- Only openings created AFTER this pending income can represent its same money.
create function private.finance_draft_issues(draft_id bigint) returns jsonb
 language plpgsql stable security invoker set search_path='' as $$
declare d private.agent_drafts%rowtype;cents bigint;day date;tx bigint;
begin
 select * into d from private.agent_drafts where id=draft_id;
 if not found or d.state<>'pending' then return '[]';end if;
 if d.fields->>'kind' is distinct from 'income' or d.fields->>'amount_cop' is null or d.fields->>'date' is null then return '[]';end if;
 begin
  cents:=private.cop_cents(d.fields->>'amount_cop');day:=(d.fields->>'date')::date;
 exception when others then
  return jsonb_build_array(jsonb_build_object('code','invalid_money_or_date','message','Revisa el importe o la fecha antes de registrar.'));
 end;
 select t.id into tx from private.transactions t join private.entries e on e.transaction_id=t.id
 join private.accounts a on a.id=e.account_id
 where t.kind='opening' and t.actor=d.actor and t.created_at>=d.created_at
 and t.date=day and a.name=d.fields->>'account' and a.kind='asset' and a.balance_known
 and e.delta=cents and cents>0
 and not exists(select 1 from private.transactions r where r.reverses=t.id)
 order by t.id desc limit 1;
 if tx is null then return '[]';end if;
 if d.opening_distinction->>'transaction_id'=tx::text and d.opening_distinction->'facts'=
  jsonb_build_object('kind',d.fields->'kind','amount_cop',d.fields->'amount_cop','account',d.fields->'account','date',d.fields->'date') then return '[]';end if;
 return jsonb_build_array(jsonb_build_object('code','opening_overlap','transaction_id',tx::text,
  'account',d.fields->>'account','amount_cents',cents::text,
  'message','Ese importe ya quedó como saldo inicial de esa cuenta. ¿Es el mismo dinero o un ingreso adicional distinto? No lo sumaré dos veces.'));
end $$;
revoke all on function private.finance_draft_issues(bigint) from public,anon,authenticated;
grant execute on function private.finance_draft_issues(bigint) to service_role;

alter function public.finance_agent(text,jsonb) rename to finance_agent_v4;
create function public.finance_agent(op text,data jsonb default '{}') returns jsonb
 language plpgsql security invoker set search_path='' as $$
declare ev private.events%rowtype;d private.agent_drafts%rowtype;r jsonb;item jsonb;items jsonb;
 enriched jsonb;issues jsonb;f jsonb;k text;child bigint;receipts jsonb:='[]';failure text;
begin
 if op='apply' then perform 1 from private.household where id=1 for update;end if;
 select * into ev from private.events where id=(data->>'id')::bigint for update;
 if not found then raise exception 'unknown event';end if;
 if op='context' then
  r:=public.finance_agent_v4(op,data);enriched:='[]';
  for item in select value from jsonb_array_elements(r->'drafts') loop
   enriched:=enriched||jsonb_build_array(item||jsonb_build_object('issues',private.finance_draft_issues((item->>'id')::bigint)));
  end loop;
  return r||jsonb_build_object('drafts',enriched,'recent_completed',
   (select coalesce(jsonb_agg(to_jsonb(x) order by x.updated_at desc),'[]') from
    (select id::text,transaction_id::text,fields,state,updated_at from private.agent_drafts
     where actor=ev.actor and state='completed' and updated_at>now()-interval '7 days'
     and not exists(select 1 from private.transactions rt where rt.reverses=agent_drafts.transaction_id)
     order by updated_at desc limit 8)x));
 elsif op='draft_get' then
  r:=public.finance_agent_v4(op,data);
  return jsonb_set(r,'{draft}',r->'draft'||jsonb_build_object('issues',private.finance_draft_issues((r->'draft'->>'id')::bigint)));
 elsif op='draft_distinct_income' then
  if ev.result is not null then raise exception 'event already settled';end if;
  k:=md5(op||data::text);
  select result into r from private.agent_draft_receipts where event_id=ev.id and fingerprint=k;
  if found then return r;end if;
  select * into d from private.agent_drafts where id=(data->>'draft_id')::bigint and actor=ev.actor for update;
  if not found or d.state<>'pending' or d.revision is distinct from (data->>'revision')::integer then raise exception 'draft changed or unavailable';end if;
  issues:=private.finance_draft_issues(d.id);
  if issues->0->>'code' is distinct from 'opening_overlap' or issues->0->>'transaction_id' is distinct from data->>'opening_transaction_id' then raise exception 'opening conflict changed; retrieve latest draft';end if;
  update private.agent_drafts set opening_distinction=jsonb_build_object('transaction_id',data->>'opening_transaction_id','event_id',ev.id,
   'facts',jsonb_build_object('kind',fields->'kind','amount_cop',fields->'amount_cop','account',fields->'account','date',fields->'date')),
   revision=revision+1,updated_at=now() where id=d.id;
  insert into private.pro_audit(actor,event_id,operation,before_value,after_value)
   select ev.actor,ev.id,op,to_jsonb(d),to_jsonb(a) from private.agent_drafts a where a.id=d.id;
  r:=jsonb_build_object('status','draft_saved','ledger_changed',false,'draft',
   (select to_jsonb(a)||jsonb_build_object('id',a.id::text,'issues',private.finance_draft_issues(a.id)) from private.agent_drafts a where a.id=d.id));
  insert into private.agent_draft_receipts values(ev.id,k,r);
  return r;
 elsif op='draft_save' then
  if ev.result is not null then raise exception 'event already settled';end if;
  -- Identity depends on the original request, never on the draft AFTER defaults.
  k:=md5('guided_draft_save'||data::text);
  select result into r from private.agent_draft_receipts where event_id=ev.id and fingerprint=k;
  if found then return r;end if;
  -- Categories are useful but do not justify blocking a clear financial entry.
  -- A neutral, visible category is preferable to inventing a precise one.
  f:=coalesce(data->'fields','{}');
  if data->>'draft_id' is not null then
   select * into d from private.agent_drafts where id=(data->>'draft_id')::bigint and actor=ev.actor;
  end if;
  if coalesce(f->>'kind',d.fields->>'kind') in ('income','expense','refund')
   and coalesce(f->>'category',d.fields->>'category','')='' then
   data:=data||jsonb_build_object('fields',f||jsonb_build_object('category','Por clasificar'));
  end if;
  r:=public.finance_agent_v4(op,data);
  r:=jsonb_set(r,'{draft}',r->'draft'||jsonb_build_object('issues',private.finance_draft_issues((r->'draft'->>'id')::bigint)));
  insert into private.agent_draft_receipts values(ev.id,k,r);
  return r;
 elsif op='drafts_save' then
  items:=data->'items';
  if jsonb_typeof(items) is distinct from 'array' or jsonb_array_length(items) not between 1 and 8 then raise exception 'invalid draft list';end if;
  if exists(select 1 from jsonb_array_elements(items) i where jsonb_typeof(i)<>'object'
    or i- array['item_key','draft_id','revision','fields']<>'{}'::jsonb
    or length(coalesce(i->>'item_key','')) not between 1 and 64
    or ((i->>'draft_id' is null)<>(i->>'revision' is null))) then raise exception 'invalid draft item';end if;
  if (select count(distinct i->>'item_key') from jsonb_array_elements(items)i)<>jsonb_array_length(items) then raise exception 'repeated item key';end if;
  enriched:='[]';
  for item in select value from jsonb_array_elements(items) loop
   r:=public.finance_agent('draft_save',item||jsonb_build_object('id',ev.id));
   enriched:=enriched||jsonb_build_array(r->'draft');
  end loop;
  return jsonb_build_object('status','drafts_saved','ledger_changed',false,'drafts',enriched);
 elsif op='apply' then
  if ev.result is not null then return ev.result;end if;
  if data->'action'->>'type'='batch_post' then
   items:=data->'action'->'items';
   if jsonb_typeof(items) is distinct from 'array' or jsonb_array_length(items) not between 2 and 8 then raise exception 'invalid movement group';end if;
   if (select count(distinct i->>'_draft_id') from jsonb_array_elements(items)i)<>jsonb_array_length(items) then raise exception 'repeated draft';end if;
   -- Check every owner/version before attempting any financial change.
   for item in select value from jsonb_array_elements(items) loop
    select * into d from private.agent_drafts where id=(item->>'_draft_id')::bigint and actor=ev.actor for update;
    if not found or d.state<>'pending' or d.revision is distinct from (item->>'_draft_revision')::integer or item->>'type'<>'post' then raise exception 'draft changed or unavailable';end if;
   end loop;
   begin
    for item in select value from jsonb_array_elements(items) loop
     child:=nextval('private.child_event_seq');
     insert into private.events(id,actor,parent_event_id) values(child,ev.actor,ev.id);
     r:=public.finance_agent('apply',jsonb_build_object('id',child,'action',item));
     if r->>'status'<>'ok' then
      if r->>'status'='duplicate' then failure:='Uno de estos pagos podría estar registrado. No registré ninguno de este grupo; revisemos cuál es un pago adicional.';
      else failure:=coalesce(r->>'message','Falta aclarar uno de los movimientos. No registré ninguno de este grupo.');end if;
      raise exception using errcode='PBF01',message=failure;
     end if;
     receipts:=receipts||jsonb_build_array(r);
     delete from private.outbox where event_id=child;
    end loop;
   exception when sqlstate 'PBF01' then
    -- The subtransaction rolls back ALL child entries, drafts and outbox rows.
    get stacked diagnostics failure=message_text;
    return public.finance_agent_v4('apply',jsonb_build_object('id',ev.id,'action',jsonb_build_object('type','clarify','question',failure)));
   end;
   r:=jsonb_build_object('status','ok','receipts',receipts,'message','Movimientos registrados.');
   perform public.finance_agent_v4('apply',jsonb_build_object('id',ev.id,'action',jsonb_build_object('type','clarify','question',r->>'message')));
   update private.events set action=data->'action',result=r where id=ev.id;
   update private.outbox set result=r,message=r->>'message' where event_id=ev.id;
   return r;
  end if;
  if data->'action'->>'_draft_id' is not null then
   select * into d from private.agent_drafts where id=(data->'action'->>'_draft_id')::bigint and actor=ev.actor for update;
   if not found or d.state<>'pending' or d.revision is distinct from (data->'action'->>'_draft_revision')::integer then raise exception 'draft changed or unavailable';end if;
   issues:=private.finance_draft_issues(d.id);
   if jsonb_array_length(issues)>0 then
    return public.finance_agent_v4('apply',jsonb_build_object('id',ev.id,'action',jsonb_build_object('type','clarify','question',issues->0->>'message')));
   end if;
  end if;
 end if;
 return public.finance_agent_v4(op,data);
end $$;

-- Status checks must see the same transactions as the grouped confirmation.
do $$declare src text;patched text;
begin
 src:=pg_get_functiondef('public.finance_flow(text,jsonb)'::regprocedure);
 patched:=replace(src,'tt.event_id=ee.id or tt.id=(ee.result->>''transaction_id'')::bigint',
  'tt.event_id=ee.id or tt.id=(ee.result->>''transaction_id'')::bigint or tt.event_id in(select ch.id from private.events ch where ch.parent_event_id=ee.id)');
 if src=patched then raise exception 'Missing batch status join patch';end if;src:=patched;
 patched:=replace(src,'tt.id=coalesce((latest.result->>''transaction_id'')::bigint,(latest.result->''transaction''->>''id'')::bigint)',
  'tt.id=coalesce((latest.result->>''transaction_id'')::bigint,(latest.result->''transaction''->>''id'')::bigint) or tt.id in(select (rc->>''transaction_id'')::bigint from jsonb_array_elements(coalesce(latest.result->''receipts'',''[]''))rc)');
 if src=patched then raise exception 'Missing delivered batch status patch';end if;src:=patched;
 patched:=replace(src,'if txid is not null then return jsonb_build_object(''registered'',true,''transaction_id'',txid);end if;',
  'if txid is not null then return jsonb_build_object(''registered'',true,''transaction_id'',txid,''transaction_ids'',coalesce((select jsonb_agg(t.id order by t.id) from private.transactions t join private.events e on e.id=t.event_id where e.parent_event_id=(select parent_event_id from private.events where id=(select event_id from private.transactions where id=txid)) and t.actor=ev.actor and t.reverses is null and not exists(select 1 from private.transactions rt where rt.reverses=t.id)),jsonb_build_array(txid)));end if;');
 if src=patched then raise exception 'Missing grouped status result patch';end if;execute patched;
end $$;
revoke all on function public.finance_agent(text,jsonb) from public,anon,authenticated;
grant execute on function public.finance_agent(text,jsonb) to service_role;

-- Natural follow-ups belong to the most recently active conversation unless an
-- explicit Telegram reply identifies another one. Retain other threads as data.
do $$declare src text;patched text;
begin
 src:=pg_get_functiondef('public.finance_pro(text,jsonb)'::regprocedure);
 patched:=replace(src,'if (select count(*) from private.conversations where actor=actor_v and state=''open'' and expires_at>now())>1 then return jsonb_build_object(''ambiguous'',true);end if;','');
 if src=patched then raise exception 'Missing conversation routing patch';end if;src:=patched;
 patched:=replace(src,'select * into c from private.conversations where actor=actor_v and state=''open'' and expires_at>now() order by created_at desc limit 1;',
  'select cc.* into c from private.conversations cc where actor=actor_v and state=''open'' and expires_at>now() order by coalesce((select max(ct.created_at) from private.conversation_turns ct where ct.session_id=cc.id),cc.created_at) desc,cc.id desc limit 1;');
 if src=patched then raise exception 'Missing active conversation patch';end if;src:=patched;
 patched:=replace(src,'jsonb_build_object(''session'',c.id,''mode'',c.mode,''turns'',',
  'jsonb_build_object(''session'',c.id,''mode'',c.mode,''other_sessions'',(select coalesce(jsonb_agg(to_jsonb(s)),''[]'') from (select cc.id::text session,(select coalesce(jsonb_agg(to_jsonb(ct) order by ct.created_at),''[]'') from (select text,answer,created_at from private.conversation_turns where session_id=cc.id order by created_at desc limit 4)ct) turns from private.conversations cc where cc.actor=actor_v and cc.id<>c.id and cc.state=''open'' and cc.expires_at>now() order by cc.created_at desc limit 4)s),''turns'',');
 if src=patched then raise exception 'Missing conversation candidates patch';end if;execute patched;
end $$;
