alter table private.accounts add column balance_known boolean not null default true;
create or replace function public.finance_pro(op text,data jsonb default '{}') returns jsonb language plpgsql security invoker set search_path='' as $$
declare ev private.events%rowtype;c private.conversations%rowtype;p private.proposals%rowtype;t private.transactions%rowtype;
 a jsonb;r jsonb;before_v jsonb;row_v record;sid bigint;n bigint;child bigint;second_child bigint;aid bigint;batch bigint;line_n int;target_id bigint;
 cash bigint;reserved_v bigint;committed bigint;due_day date;week_day date;cmd text;actor_v text;project_v text;
begin
 if op='weekly' then return private.finance_weekly(now());end if;
 select * into ev from private.events where id=(data->>'id')::bigint;
 if not found then raise exception 'unknown event';end if;actor_v:=ev.actor;
 if op='conversation' then
  perform 1 from private.members where id=actor_v for update;
  select cc.* into c from private.conversations cc join private.conversation_turns ct on ct.session_id=cc.id where ct.event_id=ev.id;
  if not found then
   if coalesce((data->>'force_new')::boolean,false) then
    c.id:=null;
   elsif nullif(ev.payload->>'replyTo','') is not null then
    select cc.* into c from private.conversations cc join private.conversation_turns ct on ct.session_id=cc.id join private.events ee on ee.id=ct.event_id left join private.outbox oo on oo.event_id=ee.id
    where cc.actor=actor_v and cc.state='open' and cc.expires_at>now() and (ee.message_id=(ev.payload->>'replyTo')::bigint or oo.telegram_message_id=(ev.payload->>'replyTo')::bigint) order by ct.created_at desc limit 1;
   else
    if (select count(*) from private.conversations where actor=actor_v and state='open' and expires_at>now())>1 then return jsonb_build_object('ambiguous',true);end if;
    select * into c from private.conversations where actor=actor_v and state='open' and expires_at>now() order by created_at desc limit 1;
   end if;
   if c.id is null then insert into private.conversations(id,actor) values(ev.id,actor_v) returning * into c;end if;
   insert into private.conversation_turns(event_id,session_id,text,photo) values(ev.id,c.id,left(data->>'text',4000),ev.payload->>'photo') on conflict do nothing;
   update private.conversations set expires_at=now()+interval '48 hours' where id=c.id;
  end if;
  return jsonb_build_object('session',c.id,'mode',c.mode,'turns',(select coalesce(jsonb_agg(x order by x.created_at),'[]') from (select text,answer,photo,created_at from private.conversation_turns where session_id=c.id order by created_at desc limit 12) x));
 end if;
 if op='finish_conversation' then
  update private.conversation_turns set answer=left(data->>'answer',500) where event_id=ev.id;
  if coalesce((data->>'close')::boolean,false) and not exists(select 1 from private.transactions tt where tt.id=(ev.result->>'transaction_id')::bigint and tt.kind='opening') then update private.conversations set state='closed' where id=(select session_id from private.conversation_turns where event_id=ev.id) and actor=actor_v;end if;
  if exists(select 1 from private.transactions tt where tt.id=(ev.result->>'transaction_id')::bigint and tt.kind='opening') then update private.conversations set mode='{}' where id=(select session_id from private.conversation_turns where event_id=ev.id);end if;
  return '{}';
 end if;
 if op='mode' then
  update private.conversations set mode=data->'mode' where id=(select session_id from private.conversation_turns where event_id=ev.id) and actor=actor_v;
  return '{}';
 end if;
 if op='context' then
  return jsonb_build_object('actor',actor_v,'preferences',(select coalesce(jsonb_agg(jsonb_build_object('merchant',merchant,'account',account,'category',category,'scope',scope)),'[]') from private.preferences where actor=actor_v),'suggestions',(select coalesce(jsonb_agg(x),'[]') from (select e.action->>'account' account,txr.category,txr.scope,left(txr.memo,80) merchant,count(*) occurrences from private.transactions txr join private.events e on e.id=txr.event_id where txr.actor=actor_v and txr.kind='expense' and txr.memo<>'' and not exists(select 1 from private.transactions rr where rr.reverses=txr.id) group by 1,2,3,4 having count(*)>=2 order by count(*) desc limit 5) x));
 end if;
 if op<>'act' then raise exception 'unknown pro operation';end if;
 perform 1 from private.household where id=1 for update;
 select result into r from private.pro_results where event_id=ev.id;if found then return r;end if;
 a:=data->'action';cmd:=a->>'command';before_v:='{}';
 if cmd='confirm' then
  select * into p from private.proposals where id=(a->>'target')::bigint and actor=actor_v for update;
  if not found or p.expires_at<now() then return jsonb_build_object('status','clarify','message','Esa propuesta ya venció o pertenece a otra persona.');end if;
  if p.state='done' then return jsonb_build_object('status','ok','message','Ya estaba confirmado. No lo registré otra vez.');end if;
  if p.state<>'pending' then return jsonb_build_object('status','clarify','message','Esa propuesta fue cancelada.');end if;
  a:=p.action;cmd:=a->>'command';
 end if;
 project_v:=coalesce(nullif(left(a->>'project',60),''),'hogar');
 if cmd='stage' then
  if a->'proposal'->>'command' in ('stage','confirm','cancel_proposal') then raise exception 'invalid proposal';end if;
  insert into private.proposals(actor,action) values(actor_v,a->'proposal') returning id into sid;
  r:=jsonb_build_object('status','preview','proposal_id',sid,'proposal',a->'proposal','message','Revisa antes de confirmar.');
 elsif cmd='cancel_proposal' then
  update private.proposals set state='cancelled' where id=(a->>'target')::bigint and actor=actor_v and state='pending';
  r:=jsonb_build_object('status','ok','message','Propuesta cancelada.');
 elsif cmd='cancel' then
  update private.conversations set state='closed' where actor=actor_v and state='open';
  update private.proposals set state='cancelled' where actor=actor_v and state='pending';
  r:=jsonb_build_object('status','ok','message','Dejamos ese pendiente. Cuéntame qué sigue.');
 elsif cmd='pending' then
  r:=jsonb_build_object('status','pending_list','items',(select coalesce(jsonb_agg(jsonb_build_object('id',cc.id,'text',(select ct.text from private.conversation_turns ct where ct.session_id=cc.id order by created_at limit 1))),'[]') from private.conversations cc where actor=actor_v and state='open' and expires_at>now()));
 elsif cmd='preference' then
  if not exists(select 1 from private.accounts where name=a->>'account' and not internal) or a->>'scope' not in ('family','personal') or length(coalesce(a->>'merchant','')) not between 1 and 80 or length(coalesce(a->>'category','')) not between 1 and 80 then raise exception 'invalid preference';end if;
  select to_jsonb(pp) into before_v from private.preferences pp where actor=actor_v and merchant=lower(a->>'merchant');
  insert into private.preferences(actor,merchant,account,category,scope) values(actor_v,lower(a->>'merchant'),a->>'account',a->>'category',a->>'scope') on conflict(actor,merchant) do update set account=excluded.account,category=excluded.category,scope=excluded.scope;
  r:=jsonb_build_object('status','ok','message','Preferencia guardada. La usaré como referencia; puedes cambiarla cuando quieras.');
 elsif cmd='forget' then
  delete from private.preferences where actor=actor_v and merchant=lower(a->>'merchant') returning to_jsonb(preferences) into before_v;
  r:=jsonb_build_object('status','ok','message','Preferencia eliminada.');
 elsif cmd='preferences' then
  r:=jsonb_build_object('status','preferences','data',public.finance_pro('context',data));
 elsif cmd='detail' then
  select * into t from private.transactions where id=(a->>'target')::bigint;
  if not found then raise exception 'unknown transaction';end if;
  r:=jsonb_build_object('status','detail','transaction',to_jsonb(t),'entries',(select jsonb_agg(jsonb_build_object('account',ac.name,'delta',e.delta::text)) from private.entries e join private.accounts ac on ac.id=e.account_id where e.transaction_id=t.id),'corrections',(select coalesce(jsonb_agg(jsonb_build_object('id',id,'reason',memo)),'[]') from private.transactions where reverses=t.id));
 elsif cmd in ('correct','undo') then
  select * into t from private.transactions where id=(a->>'target')::bigint and reverses is null;
  if not found or exists(select 1 from private.transactions where reverses=t.id) then return jsonb_build_object('status','clarify','message','Ese movimiento ya cambió. Consulta su detalle antes de corregirlo.');end if;
  select action into before_v from private.events where id=t.event_id;
  if cmd='correct' and (before_v->>'type'<>'post' or a->>'field' not in ('amount','account')) then raise exception 'unsupported correction';end if;
  update private.statement_lines set matched_transaction=null where matched_transaction=t.id;
  child:=nextval('private.child_event_seq');insert into private.events(id,actor) values(child,actor_v);
  r:=public.finance_api('apply',jsonb_build_object('id',child,'action',jsonb_build_object('type','reverse','target',t.id::text,'reason','Corrección solicitada por '||actor_v||' en evento '||ev.id)));
  if cmd='correct' then
   before_v:=before_v-'{confirm_duplicate,pending_event_id}'::text[];
   second_child:=nextval('private.child_event_seq');insert into private.events(id,actor) values(second_child,actor_v);
   r:=public.finance_api('apply',jsonb_build_object('id',second_child,'action',before_v||jsonb_build_object(a->>'field',a->>'value')));
   if r->>'status'<>'ok' then raise exception 'correction conflicts with another movement';end if;
   insert into private.transaction_projects(transaction_id,project) select (r->>'transaction_id')::bigint,project from private.transaction_projects where transaction_id=t.id;
   r:=r||jsonb_build_object('message','Corregido. Conservé el movimiento anterior y su reversión.','original',t.id);
  else r:=r||jsonb_build_object('message','Movimiento deshecho. El historial conserva la reversión.');end if;
  delete from private.outbox where event_id in (child,second_child);
 elsif cmd='account' then
  child:=nextval('private.child_event_seq');insert into private.events(id,actor) values(child,actor_v);
  r:=public.finance_api('apply',jsonb_build_object('id',child,'action',(a-'command')||jsonb_build_object('type','account','owner',coalesce(a->>'owner',actor_v))));
  update private.accounts set balance_known=coalesce((a->>'balance_known')::boolean,true) where name=a->>'name';
  r:=r||jsonb_build_object('account_created',true,'message','Cuenta creada. No se registró ningún gasto con este paso.');
  delete from private.outbox where event_id=child;
 elsif cmd='commitment' then
  if length(coalesce(a->>'label','')) not between 1 and 120 then raise exception 'invalid label';end if;
  insert into private.commitments(actor,label,amount,due,project,event_id) values(actor_v,a->>'label',(a->>'amount')::bigint,(a->>'due')::date,project_v,ev.id) returning id into sid;
  r:=jsonb_build_object('status','ok','message','Compromiso reservado. No se ha registrado ningún pago.','commitment_id',sid);
 elsif cmd='complete_commitment' then
  update private.commitments set state='done' where id=(a->>'target')::bigint and state='open' returning to_jsonb(commitments) into before_v;
  r:=jsonb_build_object('status','ok','message','Compromiso cerrado. Si ya pagaste, registra el movimiento para actualizar el saldo.');
 elsif cmd='goal' then
  if length(coalesce(a->>'label','')) not between 1 and 120 then raise exception 'invalid label';end if;
  insert into private.goals(actor,label,target,reserved,project,event_id) values(actor_v,a->>'label',(a->>'amount')::bigint,(a->>'reserved')::bigint,project_v,ev.id) returning id into sid;
  r:=jsonb_build_object('status','ok','message','Meta guardada. La reserva es para planificación; no mueve dinero.','goal_id',sid);
 elsif cmd='reserve' then
  select to_jsonb(g) into before_v from private.goals g where id=(a->>'target')::bigint;
  update private.goals set reserved=(a->>'amount')::bigint where id=(a->>'target')::bigint;
  r:=jsonb_build_object('status','ok','message','Reserva de la meta actualizada.');
 elsif cmd='planning' then
  due_day:=(a->>'to')::date;if due_day is null then raise exception 'date required';end if;
  select coalesce(sum(e.delta),0) into cash from private.entries e join private.accounts ac on ac.id=e.account_id where ac.kind='asset';
  select coalesce(sum(reserved),0) into reserved_v from private.goals;
  select coalesce(sum(amount),0) into committed from private.commitments where state='open' and due<=due_day;
  r:=jsonb_build_object('status','planning','planning',jsonb_build_object('cash',cash::text,'reserved',reserved_v::text,'committed',committed::text,'available',(cash-reserved_v-committed)::text,'to',due_day,'commitments',(select coalesce(jsonb_agg(jsonb_build_object('id',id,'label',label,'amount',amount::text,'due',due,'project',project)),'[]') from private.commitments where state='open'),'goals',(select coalesce(jsonb_agg(jsonb_build_object('id',id,'label',label,'target',target::text,'reserved',reserved::text,'project',project)),'[]') from private.goals),'unknown_accounts',(select coalesce(jsonb_agg(name),'[]') from private.accounts where not internal and not balance_known),'debt',(select coalesce(-sum(e.delta),0)::text from private.entries e join private.accounts ac on ac.id=e.account_id where ac.kind='liability')));
 elsif cmd='project' then
  if not exists(select 1 from private.transactions where id=(a->>'target')::bigint) then raise exception 'unknown transaction';end if;
  select to_jsonb(tp) into before_v from private.transaction_projects tp where transaction_id=(a->>'target')::bigint;
  insert into private.transaction_projects(transaction_id,project) values((a->>'target')::bigint,project_v) on conflict(transaction_id) do update set project=excluded.project;
  r:=jsonb_build_object('status','ok','message','Movimiento asociado a '||project_v||'.');
 elsif cmd='projects' then
  r:=jsonb_build_object('status','projects','items',(select coalesce(jsonb_agg(x),'[]') from (select coalesce(tp.project,'sin asignar') project,coalesce(sum(e.delta) filter(where ac.kind='expense'),0)::text expense,coalesce(-sum(e.delta) filter(where ac.kind='income'),0)::text income from private.transactions tt join private.entries e on e.transaction_id=tt.id join private.accounts ac on ac.id=e.account_id left join private.transaction_projects tp on tp.transaction_id=coalesce(tt.reverses,tt.id) where tt.date between (a->>'from')::date and (a->>'to')::date group by 1) x));
 elsif cmd='summary' then
  update private.summary_settings set enabled=(a->>'enabled')::boolean where id=1;
  r:=jsonb_build_object('status','ok','message',case when (a->>'enabled')::boolean then 'Resumen semanal activado: lunes a las 8:00 a. m., hora de Colombia.' else 'Resumen semanal pausado.' end);
 elsif cmd='statement' then
  select id into aid from private.accounts where name=a->>'account' and kind in ('asset','liability') and not internal;
  if aid is null or jsonb_typeof(a->'rows')<>'array' or jsonb_array_length(a->'rows') not between 1 and 200 then raise exception 'invalid statement';end if;
  insert into private.statement_batches(actor,account_id,fingerprint) values(actor_v,aid,md5((a->'rows')::text)) on conflict do nothing returning id into batch;
  if batch is null then r:=jsonb_build_object('status','ok','message','Ese extracto ya estaba importado. No dupliqué sus líneas.');
  else
   line_n:=0;for row_v in select value from jsonb_array_elements(a->'rows') loop
    line_n:=line_n+1;
    if row_v.value->>'delta' !~ '^-?[0-9]{1,15}$' or abs((row_v.value->>'delta')::bigint)>100000000000000 then raise exception 'invalid statement amount';end if;
    insert into private.statement_lines(batch_id,account_id,line_no,date,delta,memo) values(batch,aid,line_n,(row_v.value->>'date')::date,(row_v.value->>'delta')::bigint,left(coalesce(row_v.value->>'memo',''),240));
   end loop;
   r:=jsonb_build_object('status','ok','message','Extracto importado para conciliar. No se crearon ingresos ni gastos.','batch_id',batch);
  end if;
 elsif cmd in ('reconcile','reconciliation_export') then
  select * into row_v from private.statement_batches where id=(a->>'target')::bigint;
  if not found then raise exception 'unknown statement';end if;aid:=row_v.account_id;batch:=row_v.id;
  r:=jsonb_build_object('status','reconcile','batch_id',batch,'rows',(select coalesce(jsonb_agg(jsonb_build_object('id',sl.id,'date',sl.date,'delta',sl.delta::text,'memo',sl.memo,'matched',sl.matched_transaction,'candidates',(select coalesce(jsonb_agg(x),'[]') from (select tt.id,tt.memo from private.transactions tt join private.entries ee on ee.transaction_id=tt.id where ee.account_id=aid and ee.delta=sl.delta and tt.date=sl.date and tt.reverses is null and tt.kind<>'opening' and not exists(select 1 from private.transactions rr where rr.reverses=tt.id) and not exists(select 1 from private.statement_lines ll where ll.matched_transaction=tt.id and ll.account_id=aid) limit 6) x)) order by sl.line_no),'[]') from private.statement_lines sl where sl.batch_id=batch));
  r:=r||jsonb_build_object('ledger_unmatched',(select coalesce(jsonb_agg(x),'[]') from (select tt.id,tt.date,ee.delta::text,tt.memo from private.transactions tt join private.entries ee on ee.transaction_id=tt.id where ee.account_id=aid and tt.kind<>'opening' and tt.reverses is null and tt.date between (select min(date) from private.statement_lines where batch_id=batch) and (select max(date) from private.statement_lines where batch_id=batch) and not exists(select 1 from private.transactions rr where rr.reverses=tt.id) and not exists(select 1 from private.statement_lines ll where ll.matched_transaction=tt.id and ll.account_id=aid)) x));
  if cmd='reconciliation_export' then r:=r||jsonb_build_object('status','reconciliation_export');end if;
 elsif cmd='match' then
  select sl.*,sb.account_id into row_v from private.statement_lines sl join private.statement_batches sb on sb.id=sl.batch_id where sl.id=(a->>'line')::bigint for update of sl;
  if not found or row_v.matched_transaction is not null then raise exception 'line already matched or missing';end if;
  if not exists(select 1 from private.transactions tt join private.entries ee on ee.transaction_id=tt.id where tt.id=(a->>'target')::bigint and tt.reverses is null and tt.kind<>'opening' and tt.date=row_v.date and ee.account_id=row_v.account_id and ee.delta=row_v.delta and not exists(select 1 from private.transactions rr where rr.reverses=tt.id)) then raise exception 'statement mismatch';end if;
  update private.statement_lines set matched_transaction=(a->>'target')::bigint where id=row_v.id;
  r:=jsonb_build_object('status','ok','message','Línea conciliada con el movimiento. No se modificó el libro.');
 else raise exception 'unknown pro command %',cmd;
 end if;
 insert into private.pro_audit(actor,event_id,operation,before_value,after_value) values(actor_v,ev.id,cmd,before_v,a);
 insert into private.pro_results(event_id,result) values(ev.id,r);
 if p.id is not null then update private.proposals set state='done',result=r where id=p.id;end if;
 return r;
end $$;
revoke all on function public.finance_pro(text,jsonb) from public,anon,authenticated;
grant execute on function public.finance_pro(text,jsonb) to service_role;

create or replace function public.finance_api(op text, data jsonb default '{}'::jsonb) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare a jsonb; ev private.events%rowtype; tx private.transactions%rowtype;
  aid bigint; bid bigint; xid bigint; n bigint; principal bigint; interest bigint; amount bigint; delta bigint;
  kind text; owner_id text; scope_id text; cat text; memo_text text; account_kind text; other_kind text;
  acct text; oth text; signature text; date_value date; result_value jsonb; row_value record;
begin
 if op='init' then
   if data->>'group' !~ '^-[0-9]+$' then raise exception 'invalid group'; end if;
   insert into private.household(id,group_id) values(1,data->>'group') on conflict(id) do nothing;
   if (select group_id from private.household where id=1)<>data->>'group' then raise exception 'group already configured'; end if;
   return jsonb_build_object('ok',true);
 end if;
 if op='ingest' then
   if (select group_id from private.household where id=1) is distinct from data->>'group' then raise exception 'wrong group'; end if;
   if data->>'actor' !~ '^[0-9]+$' or length(coalesce(data->>'name',''))=0 then raise exception 'invalid actor'; end if;
   perform 1 from private.household where id=1 for update;
   if not exists(select 1 from private.members where id=data->>'actor') then
     if (select count(*) from private.members)>=2 then raise exception 'only two members'; end if;
     insert into private.members(id,name) values(data->>'actor',left(data->>'name',80));
   end if;
   insert into private.events(id,actor,payload,message_id,thread_id) values((data->>'update_id')::bigint,data->>'actor',coalesce(data->'payload','{}'::jsonb),(data->'payload'->>'messageId')::bigint,(data->'payload'->>'threadId')::bigint) on conflict(id) do nothing;
   return (select jsonb_build_object('id',id,'state',state,'result',result) from private.events where id=(data->>'update_id')::bigint);
 end if;
 if op='claim' then
   perform 1 from private.household where id=1 for update;
   update private.events set state='working', attempts=attempts+1,lease_until=now()+interval '2 minutes'
   where id=(select ee.id from private.events ee where (ee.state='new' or (ee.state='working' and ee.lease_until<now())) and not exists(select 1 from private.events busy where busy.actor=ee.actor and busy.id<>ee.id and busy.state='working' and busy.lease_until>=now()) order by ee.id for update skip locked limit 1)
   returning * into ev;
   if not found then return '{}'::jsonb; end if;
   return jsonb_build_object('id',ev.id,'actor',ev.actor,'payload',ev.payload,'action',ev.action,'attempts',ev.attempts);
 end if;
 if op='pending' then
   return coalesce((select jsonb_build_object('status','pending','action',e.action,'actor',e.actor) from private.events e where e.id=(data->>'id')::bigint and e.state='pending' and e.created_at>now()-interval '48 hours'),jsonb_build_object('status','unknown'));
 end if;
 if op='outbox' then
   with claimed as (
     update private.outbox set lease_until=now()+interval '2 minutes'
     where id in (select id from private.outbox where sent_at is null and (lease_until is null or lease_until<now()) order by id for update skip locked limit 10)
     returning *
   ) select coalesce(jsonb_agg(jsonb_build_object('id',o.id,'event_id',o.event_id,'message',o.message,'result',o.result,'messageId',e.message_id,'threadId',e.thread_id)),'[]'::jsonb) into result_value from claimed o left join private.events e on e.id=o.event_id;
   return result_value;
 end if;
 if op='sent' then
   update private.outbox set sent_at=now(),telegram_message_id=(data->>'telegram_message_id')::bigint where id=(data->>'id')::bigint and sent_at is null;
   return jsonb_build_object('ok',true);
 end if;
 if op='due' then
   perform public.finance_pro('weekly');
   for row_value in select * from private.reminders where due<=(data->>'today')::date and notified_at is null for update skip locked loop
     insert into private.outbox(message,result) values('Recordatorio: '||row_value.label,jsonb_build_object('status','reminder','message','Recordatorio: '||row_value.label));
     update private.reminders set notified_at=now() where id=row_value.id;
   end loop;
   for row_value in
     select b.owner,b.scope,b.category,b.month,b.limit_cents,coalesce(sum(e.delta) filter(where ac.kind='expense'),0) spent
     from private.budgets b left join private.transactions t on t.date>=b.month and t.date<=(data->>'today')::date and t.date<b.month+interval '1 month' and t.scope=b.scope and t.category=b.category
       and (b.scope='family' or t.beneficiary=b.owner)
     left join private.entries e on e.transaction_id=t.id
     left join private.accounts ac on ac.id=e.account_id and ac.kind='expense'
     where b.month=date_trunc('month',(data->>'today')::date)::date
     group by b.owner,b.scope,b.category,b.month,b.limit_cents
   loop
     if row_value.spent>=row_value.limit_cents*0.8 then
       n:=case when row_value.spent>=row_value.limit_cents then 100 else 80 end;
       insert into private.budget_alerts(owner,scope,category,month,threshold) values(row_value.owner,row_value.scope,row_value.category,row_value.month,n) on conflict do nothing;
       if found then insert into private.outbox(message,result) values('Presupuesto '||row_value.category||': '||n||'% usado',jsonb_build_object('status','alert','message','Presupuesto '||row_value.category||': '||n||'% usado'));
       end if;
     end if;
   end loop;
   return (select coalesce(jsonb_agg(jsonb_build_object('id',id,'message',message)),'[]'::jsonb) from private.outbox where sent_at is null and event_id is null);
 end if;
 if op='proposal' then
   update private.events set action=data->'action' where id=(data->>'id')::bigint and state='working' returning * into ev;
   if not found then raise exception 'not claimed'; end if;
   return jsonb_build_object('ok',true);
 end if;
 if op='fail' then
   update private.events set state=case when attempts>=3 then 'failed' else 'new' end,lease_until=null where id=(data->>'id')::bigint and state='working';
   if exists(select 1 from private.events where id=(data->>'id')::bigint and state='failed') then
     insert into private.outbox(event_id,message,result) values((data->>'id')::bigint,'No pude registrar el mensaje #'||(data->>'id')||'. Hay que revisar el dato y enviarlo de nuevo.',jsonb_build_object('status','failed','message','No pude registrar el mensaje #'||(data->>'id')||'. Hay que revisar el dato y enviarlo de nuevo.')) on conflict(event_id) do nothing;
   end if;
   return jsonb_build_object('ok',true);
 end if;
 if op='context' then
   return jsonb_build_object(
    'members',(select coalesce(jsonb_agg(jsonb_build_object('id',m.id,'name',m.name)),'[]'::jsonb) from private.members m),
    'accounts',(select coalesce(jsonb_agg(jsonb_build_object('name',ac.name,'kind',ac.kind,'owner',ac.owner)),'[]'::jsonb) from private.accounts ac where not ac.internal),
    'recent',(select coalesce(jsonb_agg(jsonb_build_object('id',t.id,'date',t.date,'category',t.category,'memo',t.memo,'kind',t.kind)),'[]'::jsonb) from (select * from private.transactions where reverses is null order by id desc limit 12) t));
 end if;
 if op='report' then
   date_value:=coalesce((data->>'from')::date,(now() at time zone 'America/Bogota')::date);
   if (data->>'to')::date<date_value then raise exception 'invalid period'; end if;
   return jsonb_build_object(
    'expense',coalesce((select sum(e.delta) from private.entries e join private.accounts a on a.id=e.account_id join private.transactions t on t.id=e.transaction_id where a.kind='expense' and t.date between date_value and (data->>'to')::date and (data->>'scope'='all' or t.scope=data->>'scope') and (data->>'scope'<>'personal' or nullif(data->>'actor','') is null or t.beneficiary=data->>'actor')),0)::text,
    'income',coalesce((select -sum(e.delta) from private.entries e join private.accounts a on a.id=e.account_id join private.transactions t on t.id=e.transaction_id where a.kind='income' and t.date between date_value and (data->>'to')::date and (data->>'scope'='all' or t.scope=data->>'scope') and (data->>'scope'<>'personal' or nullif(data->>'actor','') is null or t.beneficiary=data->>'actor')),0)::text,
    'balances',(select coalesce(jsonb_agg(jsonb_build_object('name',a.name,'kind',a.kind,'balance_known',a.balance_known,'balance',(case when a.kind='liability' then -coalesce(s.amount,0) else coalesce(s.amount,0) end)::text)),'[]'::jsonb) from private.accounts a left join (select e.account_id,sum(e.delta) amount from private.entries e group by e.account_id) s on s.account_id=a.id where not a.internal),
    'categories',(select coalesce(jsonb_agg(jsonb_build_object('category',c.category,'amount',c.amount::text)),'[]'::jsonb) from (select t.category,sum(e.delta) amount from private.entries e join private.accounts a on a.id=e.account_id join private.transactions t on t.id=e.transaction_id where a.kind='expense' and t.date between date_value and (data->>'to')::date and (data->>'scope'='all' or t.scope=data->>'scope') and (data->>'scope'<>'personal' or nullif(data->>'actor','') is null or t.beneficiary=data->>'actor') group by t.category) c),
    'budgets',(select coalesce(jsonb_agg(jsonb_build_object('category',b.category,'scope',b.scope,'owner',b.owner,'limit',b.limit_cents::text)),'[]'::jsonb) from private.budgets b where b.month=date_trunc('month',date_value)::date));
 end if;
 if op='history' then
   return (select coalesce(jsonb_agg(jsonb_build_object('id',t.id,'date',t.date,'kind',t.kind,'category',t.category,'payer',t.payer,'beneficiary',t.beneficiary,'scope',t.scope,'memo',t.memo,'reverses',t.reverses,'amount',coalesce((select abs(e.delta)::text from private.entries e join private.accounts ac on ac.id=e.account_id where e.transaction_id=t.id and not ac.internal order by e.id limit 1),'0'))),'[]'::jsonb) from (select * from private.transactions order by id desc limit 100) t);
 end if;
 if op='export' then
   return (select coalesce(jsonb_agg(jsonb_build_object('transaction_id',t.id,'date',t.date,'kind',t.kind,'category',t.category,'scope',t.scope,'payer',t.payer,'beneficiary',t.beneficiary,'account',ac.name,'delta',e.delta::text,'memo',t.memo,'reverses',t.reverses) order by t.id,e.id),'[]'::jsonb)
     from private.transactions t join private.entries e on e.transaction_id=t.id join private.accounts ac on ac.id=e.account_id);
 end if;
 if op='apply' then
   perform 1 from private.household where id=1 for update;
   select * into ev from private.events where id=(data->>'id')::bigint for update;
   if not found then raise exception 'missing event'; end if;
   if ev.result is not null then return ev.result; end if;
   a:=data->'action'; if a is null or jsonb_typeof(a)<>'object' then raise exception 'action required'; end if;
   kind:=a->>'type';
   if kind='clarify' then
      result_value:=jsonb_build_object('status','clarify','message',left(a->>'question',200));
      update private.events set result=result_value,state='pending' where id=ev.id;
      insert into private.outbox(event_id,message,result) values(ev.id,result_value->>'message',result_value);
      return result_value;
   end if;
   if kind='pro' then
     result_value:=public.finance_pro('act',jsonb_build_object('id',ev.id,'action',a-'type'));
   elsif kind='export' then
     result_value:=jsonb_build_object('status','export','message','Exportación del libro');
   elsif kind='report' then
     result_value:=jsonb_build_object('status','ok','report',public.finance_api('report',a||jsonb_build_object('actor',ev.actor)));
   elsif kind='history' then
     result_value:=jsonb_build_object('status','ok','history',public.finance_api('history',a));
   elsif kind='budget' then
     scope_id:=a->>'scope';owner_id:=case when scope_id='family' then 'family' else coalesce(a->>'beneficiary',ev.actor) end;
     if scope_id='personal' and not exists(select 1 from private.members where id=owner_id) then raise exception 'unknown beneficiary'; end if;
     cat:=a->>'category';amount:=(a->>'amount')::bigint;
     if amount<=0 or cat is null or length(cat)>80 then raise exception 'invalid budget'; end if;
     date_value:=(a->>'month')::date; if extract(day from date_value)<>1 then raise exception 'month must start on day 1'; end if;
     insert into private.budgets(owner,scope,category,month,limit_cents) values(owner_id,scope_id,cat,date_value,amount) on conflict(owner,scope,category,month) do update set limit_cents=excluded.limit_cents;
     result_value:=jsonb_build_object('status','ok','message','Presupuesto guardado');
   elsif kind='reminder' then
     insert into private.reminders(actor,label,due) values(ev.actor,left(a->>'label',120),(a->>'date')::date);
     result_value:=jsonb_build_object('status','ok','message','Recordatorio guardado');
   elsif kind in ('account','post','reverse') then
     if kind='reverse' then
       select * into tx from private.transactions where id=(a->>'target')::bigint and reverses is null;
       if not found or exists(select 1 from private.transactions where reverses=tx.id) then raise exception 'already reversed or unknown'; end if;
       if nullif(a->>'reason','') is null then raise exception 'reason required'; end if;
       update private.statement_lines set matched_transaction=null where matched_transaction=tx.id;
       insert into private.transactions(event_id,actor,date,kind,category,scope,payer,beneficiary,memo,reverses) values(ev.id,ev.actor,tx.date,'reverse',tx.category,tx.scope,tx.payer,tx.beneficiary,left(a->>'reason',240),tx.id) returning id into xid;
       insert into private.entries(transaction_id,account_id,delta) select xid,e.account_id,-e.delta from private.entries e where e.transaction_id=tx.id;
       result_value:=jsonb_build_object('status','ok','transaction_id',xid,'message','Movimiento corregido con reversión');
     elsif kind='account' then
       amount:=(a->>'amount')::bigint;
       if amount<0 or amount>100000000000000 then raise exception 'invalid opening amount'; end if;
       acct:=a->>'name';account_kind:=a->>'kind';
       if account_kind not in ('asset','liability','receivable') or acct is null or length(acct)<1 or length(acct)>64 then raise exception 'invalid account'; end if;
       if not exists(select 1 from private.members where id=a->>'owner') then raise exception 'unknown owner'; end if;
       insert into private.accounts(name,kind,owner) values(acct,account_kind,a->>'owner') returning id into aid;
       date_value:=(a->>'date')::date;
       insert into private.transactions(event_id,actor,date,kind,scope,payer,memo) values(ev.id,ev.actor,date_value,'opening','family',ev.actor,'saldo inicial') returning id into xid;
       if amount>0 then
         insert into private.accounts(name,kind,internal) values('equity:opening','equity',true) on conflict(name) do nothing;
         select id into bid from private.accounts where name='equity:opening';
         insert into private.entries(transaction_id,account_id,delta) values(xid,aid,case when account_kind='liability' then -amount else amount end),(xid,bid,case when account_kind='liability' then amount else -amount end);
       end if;
       result_value:=jsonb_build_object('status','ok','transaction_id',xid,'message','Cuenta guardada','editable',false);
     else
       amount:=(a->>'amount')::bigint;
       if amount<=0 or amount>100000000000000 then raise exception 'invalid amount'; end if;
       date_value:=(a->>'date')::date;
       if date_value>current_date+interval '1 day' or date_value<date '2000-01-01' then raise exception 'invalid date'; end if;
       scope_id:=a->>'scope';if scope_id not in ('family','personal') then raise exception 'invalid scope'; end if;
       owner_id:=a->>'payer';if not exists(select 1 from private.members where id=owner_id) then raise exception 'unknown payer'; end if;
       if scope_id='personal' and not exists(select 1 from private.members where id=coalesce(a->>'beneficiary',owner_id)) then raise exception 'unknown beneficiary'; end if;
       acct:=a->>'account'; select ac.id,ac.kind into aid,account_kind from private.accounts ac where ac.name=acct and not ac.internal;
       if aid is null then raise exception 'unknown account'; end if;
       oth:=a->>'other'; if oth is not null then select ac.id,ac.kind into bid,other_kind from private.accounts ac where ac.name=oth and not ac.internal; end if;
       cat:=nullif(left(a->>'category',80),'');memo_text:=coalesce(left(a->>'memo',240),'');
       if a->>'kind' not in ('income','expense','transfer','borrow','lend','repayment','collection','refund') then raise exception 'invalid operation'; end if;
       if a->>'kind' in ('income','expense','refund') and cat is null then raise exception 'category required'; end if;
       if a->>'kind' in ('transfer','borrow','lend','repayment','collection') and (bid is null or bid=aid) then raise exception 'other account required'; end if;
       if a->>'kind'='expense' and account_kind not in ('asset','liability') then raise exception 'invalid payment account'; end if;
       if a->>'kind' in ('income','refund','borrow','collection') and account_kind<>'asset' then raise exception 'cash account required'; end if;
       if a->>'kind'='transfer' and (account_kind not in ('asset','liability') or other_kind not in ('asset','liability')) then raise exception 'invalid transfer'; end if;
       if a->>'kind' in ('borrow','repayment') and other_kind<>'liability' then raise exception 'liability required'; end if;
       if a->>'kind' in ('lend','collection') and other_kind<>'receivable' then raise exception 'receivable required'; end if;
       if a->>'kind' in ('lend','repayment') and account_kind<>'asset' then raise exception 'cash required'; end if;
       if coalesce((a->>'confirm_duplicate')::boolean,false) then
         if nullif(a->>'pending_event_id','') is null then raise exception 'pending duplicate required'; end if;
         update private.events set state='done',payload='{}'::jsonb,result=jsonb_build_object('status','confirmed','message','Duplicado confirmado')
           where id=(a->>'pending_event_id')::bigint and state='pending' and actor=ev.actor and created_at>now()-interval '48 hours' and action=a-'{confirm_duplicate,pending_event_id}'::text[];
         if not found then raise exception 'duplicate already confirmed or changed'; end if;
       end if;
       signature:=md5(concat_ws('|',a->>'kind',date_value::text,amount::text,acct,coalesce(oth,''),cat,scope_id,owner_id,coalesce(a->>'beneficiary',owner_id)));
       if not coalesce((a->>'confirm_duplicate')::boolean,false) and exists(select 1 from private.transactions where duplicate_key=signature and reverses is null and not exists(select 1 from private.transactions r where r.reverses=private.transactions.id)) then
         result_value:=jsonb_build_object('status','duplicate','message','Posible duplicado. Responde confirmar al mensaje para registrarlo.');
         update private.events set result=result_value,state='pending',action=a where id=ev.id;
         insert into private.outbox(event_id,message,result) values(ev.id,result_value->>'message',result_value);
         return result_value;
       end if;
       insert into private.transactions(event_id,actor,date,kind,category,scope,payer,beneficiary,memo,duplicate_key) values(ev.id,ev.actor,date_value,a->>'kind',cat,scope_id,owner_id,case when scope_id='personal' then coalesce(a->>'beneficiary',owner_id) else null end,memo_text,signature) returning id into xid;
       if a->>'kind' in ('income','expense','refund') then
          insert into private.accounts(name,kind,internal) values(concat(case when a->>'kind'='income' then 'income' else 'expense' end,':',scope_id,':',case when scope_id='personal' then coalesce(a->>'beneficiary',owner_id) else 'all' end,':',cat),case when a->>'kind'='income' then 'income' else 'expense' end,true) on conflict(name) do nothing;
          select id into bid from private.accounts where name=concat(case when a->>'kind'='income' then 'income' else 'expense' end,':',scope_id,':',case when scope_id='personal' then coalesce(a->>'beneficiary',owner_id) else 'all' end,':',cat);
          if a->>'kind'='income' then delta:=amount; elsif a->>'kind'='refund' then delta:=amount; else delta:=-amount; end if;
          insert into private.entries(transaction_id,account_id,delta) values(xid,aid,delta),(xid,bid,-delta);
       else
          -- Liability has negative signed balance. Transfer into it clears debt.
          if a->>'kind' in ('transfer','repayment','lend') then delta:=-amount; else delta:=amount; end if;
          if a->>'kind'='transfer' and account_kind='liability' then delta:=-amount; end if;
          insert into private.entries(transaction_id,account_id,delta) values(xid,aid,delta),(xid,bid,-delta);
       end if;
       result_value:=jsonb_build_object('status','ok','transaction_id',xid,'message','Movimiento registrado','editable',true);
     end if;
   else raise exception 'unsupported action';
   end if;
   update private.events set result=result_value,state='done',action=a,payload='{}'::jsonb where id=ev.id;
   insert into private.outbox(event_id,message,result) values(ev.id,coalesce(result_value->>'message','Consulta lista'),result_value);
   return result_value;
 end if;
 raise exception 'unknown operation %',op;
end $$;
revoke all on function public.finance_api(text,jsonb) from public,anon,authenticated;
grant execute on function public.finance_api(text,jsonb) to service_role;


create function public.finance_flow(op text,data jsonb default '{}') returns jsonb language plpgsql security invoker set search_path='' as $$
declare ev private.events%rowtype;sid bigint;txid bigint;
begin
 if op not in ('status','resume_account') then raise exception 'unknown operation';end if;
 select * into ev from private.events where id=(data->>'id')::bigint;if not found then raise exception 'unknown event';end if;
 if op='resume_account' then
  if not exists(select 1 from private.transactions tt where tt.id=(ev.result->>'transaction_id')::bigint and tt.kind='opening') then raise exception 'not account creation';end if;
  update private.events set result=result||jsonb_build_object('message',left(data->>'message',500)) where id=ev.id;
  update private.outbox set result=result||jsonb_build_object('message',left(data->>'message',500)),message=left(data->>'message',500) where event_id=ev.id and sent_at is null;
  return jsonb_build_object('ok',true);
 end if;
 select ct.session_id into sid from private.conversation_turns ct where ct.event_id=ev.id;
 select tt.id into txid from private.conversation_turns ct join private.events ee on ee.id=ct.event_id join private.transactions tt on tt.event_id=ee.id or tt.id=(ee.result->>'transaction_id')::bigint where ct.session_id=sid and ee.actor=ev.actor and tt.kind not in ('opening','reverse') and not exists(select 1 from private.transactions rr where rr.reverses=tt.id) order by tt.id desc limit 1;
 if txid is null and (select count(*) from private.conversation_turns where session_id=sid)<=1
 and not exists(select 1 from private.conversation_turns ct join private.events ee on ee.id=ct.event_id join private.transactions tt on tt.id=(ee.result->>'transaction_id')::bigint where ct.session_id=sid and tt.kind='opening') then
  select tt.id into txid from (select oo.result from private.outbox oo join private.events ee on ee.id=oo.event_id where ee.actor=ev.actor and oo.sent_at is not null order by oo.sent_at desc limit 1) latest join private.transactions tt on tt.id=coalesce((latest.result->>'transaction_id')::bigint,(latest.result->'transaction'->>'id')::bigint) where tt.kind not in ('opening','reverse') and not exists(select 1 from private.transactions rr where rr.reverses=tt.id);
  if txid is null then return jsonb_build_object('registered',null,'message','¿Qué movimiento quieres verificar? Responde al mensaje del gasto para que revise ese registro exacto.');end if;
 end if;
 if txid is not null then return jsonb_build_object('registered',true,'transaction_id',txid);end if;
 return jsonb_build_object('registered',false,'message','Todavía no se ha registrado el gasto. Crear la cuenta es un paso separado; seguimos con los datos que faltan.');
end $$;
revoke all on function public.finance_flow(text,jsonb) from public,anon,authenticated;
grant execute on function public.finance_flow(text,jsonb) to service_role;
