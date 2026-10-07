-- External parties are descriptive facts, never household principals.
alter table private.transactions add column counterparty text
 check(counterparty is null or (counterparty=btrim(counterparty) and length(counterparty) between 1 and 120));
alter table private.conversations add column active_draft_ids jsonb not null default '[]'
 check(jsonb_typeof(active_draft_ids)='array' and jsonb_array_length(active_draft_ids)<=20);

do $$declare src text;patched text;
begin
 src:=pg_get_functiondef('public.finance_api(text,jsonb)'::regprocedure);
 patched:=replace(src,'memo,duplicate_key) values','memo,duplicate_key,counterparty) values');
 if src=patched then raise exception 'Missing transaction counterparty column patch';end if;src:=patched;
 patched:=replace(src,'memo_text,signature) returning id into xid;','memo_text,signature,nullif(btrim(a->>''counterparty''),'''')) returning id into xid;');
 if src=patched then raise exception 'Missing transaction counterparty value patch';end if;src:=patched;
 patched:=replace(src,'memo,reverses) values','memo,reverses,counterparty) values');
 if src=patched then raise exception 'Missing reversal counterparty column patch';end if;src:=patched;
 patched:=replace(src,'left(a->>''reason'',240),tx.id) returning id into xid;','left(a->>''reason'',240),tx.id,tx.counterparty) returning id into xid;');
 if src=patched then raise exception 'Missing reversal counterparty value patch';end if;execute patched;

 src:=pg_get_functiondef('public.finance_agent_v3(text,jsonb)'::regprocedure);
 patched:=replace(src,'''category'',''scope'',''memo'']','''category'',''scope'',''memo'',''counterparty'']');
 if src=patched then raise exception 'Missing draft counterparty whitelist patch';end if;src:=patched;
 patched:=replace(src,'''payer'',''date'',''scope'']','''payer'',''date'',''scope'',''counterparty'']');
 if src=patched then raise exception 'Missing immutable draft counterparty validation patch';end if;src:=patched;
 patched:=replace(src,'''memo'',act->>''memo'',''scope'',act->>''scope''))',
  '''memo'',act->>''memo'',''scope'',act->>''scope'')||case when act ? ''counterparty'' then jsonb_build_object(''counterparty'',act->''counterparty'') else ''{}''::jsonb end)');
 if src=patched then raise exception 'Missing receipt counterparty patch';end if;execute patched;

 src:=pg_get_functiondef('public.finance_pro(text,jsonb)'::regprocedure);
 patched:=replace(src,'''account_created'',true,''message''','''account_created'',true,''account_name'',a->>''name'',''message''');
 if src=patched then raise exception 'Missing created account identity patch';end if;src:=patched;
 patched:=replace(src,'''session'',c.id,''mode'',c.mode,','''session'',c.id,''mode'',c.mode,''previous_draft_ids'',c.active_draft_ids,');
 if src=patched then raise exception 'Missing conversation focus read patch';end if;src:=patched;
 patched:=replace(src,'if op=''finish_conversation'' then',$focus$
 if op='finish_conversation' then
  if data ? 'active_draft_ids' then
   if jsonb_typeof(data->'active_draft_ids') is distinct from 'array' or jsonb_array_length(data->'active_draft_ids')>20 then raise exception 'invalid conversation focus';end if;
   if exists(select 1 from jsonb_array_elements(data->'active_draft_ids')x where jsonb_typeof(x)<>'string' or not exists(select 1 from private.agent_drafts d where d.id::text=x#>>'{}' and d.actor=actor_v)) then raise exception 'foreign or invalid conversation focus';end if;
   update private.conversations set active_draft_ids=coalesce((select jsonb_agg(d.id::text order by d.id) from private.agent_drafts d where d.actor=actor_v and d.state='pending' and data->'active_draft_ids' ? d.id::text),'[]')
    where id=(select session_id from private.conversation_turns where event_id=ev.id) and actor=actor_v;
  end if;
 $focus$);
 if src=patched then raise exception 'Missing conversation focus write patch';end if;execute patched;

 src:=pg_get_functiondef('public.finance_movement_search(text,jsonb)'::regprocedure);
 patched:=replace(src,'t.scope,t.payer,','t.scope,t.payer,t.counterparty,');
 if src=patched then raise exception 'Missing search counterparty selection patch';end if;src:=patched;
 patched:=replace(src,'category,scope,payer,amount_cents::text','category,scope,payer,counterparty,amount_cents::text');
 if src=patched then raise exception 'Missing search counterparty response patch';end if;src:=patched;
 patched:=replace(src,'strpos(lower(t.memo),lower(data->>''query''))>0','strpos(lower(t.memo),lower(data->>''query''))>0 or strpos(lower(t.counterparty),lower(data->>''query''))>0');
 if src=patched then raise exception 'Missing search counterparty predicate patch';end if;execute patched;
end $$;

-- Extend the existing agent API; all older operations retain their tested path.
alter function public.finance_agent(text,jsonb) rename to finance_agent_v6;
create function public.finance_agent(op text,data jsonb default '{}') returns jsonb
language plpgsql security invoker set search_path='' as $$
declare ev private.events%rowtype;d private.agent_drafts%rowtype;p private.proposals%rowtype;
 a jsonb;proposal_v jsonb;refs jsonb;ref jsonb;clean jsonb:='[]';r jsonb;child_result jsonb;
 receipts jsonb:='[]';item jsonb;child bigint;missing_v boolean:=false;failure text;field_v text;
begin
 if op='draft_save' then
  if data->'fields' ? 'counterparty' and data->'fields'->'counterparty'<>'null'::jsonb then
   if jsonb_typeof(data->'fields'->'counterparty')<>'string' or length(btrim(data->'fields'->>'counterparty')) not between 1 and 120 then raise exception 'invalid external counterparty';end if;
   data:=jsonb_set(data,'{fields,counterparty}',to_jsonb(btrim(data->'fields'->>'counterparty')));
  end if;
  select * into ev from private.events where id=(data->>'id')::bigint;
  if data->>'draft_id' is not null then select * into d from private.agent_drafts where id=(data->>'draft_id')::bigint and actor=ev.actor;end if;
  if coalesce(data->'fields'->>'kind',d.fields->>'kind')='income'
   and coalesce(data->'fields'->>'payer',d.fields->>'payer') is null then
   data:=data||jsonb_build_object('fields',coalesce(data->'fields','{}')||jsonb_build_object('payer',ev.actor));
  end if;
  return public.finance_agent_v6(op,data);
 end if;
 if op<>'apply' then return public.finance_agent_v6(op,data);end if;
 perform 1 from private.household where id=1 for update;
 select * into ev from private.events where id=(data->>'id')::bigint for update;
 if not found then raise exception 'unknown event';end if;
 if ev.result is not null then return ev.result;end if;
 a:=data->'action';
 if a->>'type'='pro' and a->>'command'='stage' and a->'proposal'->>'command'='account'
  and a->'proposal' ? 'linked_drafts' then
  proposal_v:=a->'proposal';refs:=proposal_v->'linked_drafts';
  if jsonb_typeof(refs) is distinct from 'array' or jsonb_array_length(refs) not between 1 and 8 then raise exception 'invalid linked movements';end if;
  if (select count(distinct x->>'draft_id') from jsonb_array_elements(refs)x)<>jsonb_array_length(refs) then raise exception 'repeated linked movement';end if;
  for ref in select value from jsonb_array_elements(refs) loop
   select * into d from private.agent_drafts where id=(ref->>'draft_id')::bigint and actor=ev.actor for update;
   if not found or d.state<>'pending' or d.revision is distinct from (ref->>'revision')::integer then raise exception 'linked draft changed or unavailable';end if;
   if proposal_v->>'name' is distinct from d.fields->>'account' and proposal_v->>'name' is distinct from d.fields->>'other' then raise exception 'unrelated linked movement';end if;
   clean:=clean||jsonb_build_array(jsonb_build_object('draft_id',d.id::text,'revision',d.revision,'fields',d.fields));
  end loop;
  data:=jsonb_set(data,'{action,proposal,linked_drafts}',clean);
  return public.finance_agent_v6(op,data);
 end if;
 if a->>'type'='pro' and a->>'command'='confirm' then
  select * into p from private.proposals where id=(a->>'target')::bigint and actor=ev.actor for update;
  if found and p.state='pending' and p.expires_at>now() and p.action->>'command'='account' and p.action ? 'linked_drafts' then
   refs:=p.action->'linked_drafts';
   -- Revalidate the exact data the user saw before creating anything.
   for ref in select value from jsonb_array_elements(refs) loop
    select * into d from private.agent_drafts where id=(ref->>'draft_id')::bigint and actor=ev.actor for update;
    if not found or d.state<>'pending' or d.revision is distinct from (ref->>'revision')::integer or d.fields is distinct from ref->'fields' then
     return public.finance_agent_v6('apply',jsonb_build_object('id',ev.id,'action',jsonb_build_object('type','clarify','question','Los datos de un movimiento cambiaron desde la propuesta. Revisemos una propuesta actualizada antes de crear la cuenta o registrarlo.')));
    end if;
    for field_v in select unnest(array['kind','amount_cop','account','payer','date','scope']) loop
     if coalesce(d.fields->>field_v,'')='' then missing_v:=true;end if;
    end loop;
    if d.fields->>'kind' in ('transfer','borrow','lend','repayment','collection') and coalesce(d.fields->>'other','')='' then missing_v:=true;end if;
   end loop;
   begin
    r:=public.finance_agent_v6(op,data);
    if r->>'status' is distinct from 'ok' or r->>'account_created' is distinct from 'true' then return r;end if;
    if missing_v then
     r:=r||jsonb_build_object('linked_pending',(select jsonb_agg(x->'draft_id') from jsonb_array_elements(refs)x));
    else
     for ref in select value from jsonb_array_elements(refs) loop
      select * into d from private.agent_drafts where id=(ref->>'draft_id')::bigint and actor=ev.actor;
      item:=(d.fields-'amount_cop')||jsonb_build_object('type','post','amount',private.cop_cents(d.fields->>'amount_cop')::text,'_draft_id',d.id::text,'_draft_revision',d.revision);
      child:=nextval('private.child_event_seq');
      insert into private.events(id,actor,parent_event_id,action) values(child,ev.actor,ev.id,item);
      child_result:=public.finance_agent('apply',jsonb_build_object('id',child,'action',item));
      if child_result->>'status' is distinct from 'ok' then
       failure:='No creé la cuenta ni registré sus movimientos: '||coalesce(child_result->>'message','hay un conflicto que debemos revisar.');
       raise exception using errcode='PBF02',message=failure;
      end if;
      receipts:=receipts||jsonb_build_array(child_result);
      delete from private.outbox where event_id=child;
     end loop;
     r:=r||jsonb_build_object('receipts',receipts,'message','Cuenta creada y movimientos registrados.');
    end if;
    update private.events set result=r where id=ev.id;
    update private.outbox set result=r,message=r->>'message' where event_id=ev.id;
    update private.pro_results set result=r where event_id=ev.id;
    update private.proposals set result=r where id=p.id;
    return r;
   exception when sqlstate 'PBF02' then
    get stacked diagnostics failure=message_text;
    return public.finance_agent_v6('apply',jsonb_build_object('id',ev.id,'action',jsonb_build_object('type','clarify','question',failure)));
   end;
  end if;
 end if;
 return public.finance_agent_v6(op,data);
end $$;
revoke all on function public.finance_agent(text,jsonb) from public,anon,authenticated;
grant execute on function public.finance_agent(text,jsonb) to service_role;
