alter table private.events add column turn_until timestamptz,add column turn_token text;
alter table private.outbox add column delivery_token text,add column delivery_attempts int not null default 0,add column retry_at timestamptz not null default now(),add column delivery_part int not null default 0;
create function public.finance_queue(op text,data jsonb default '{}') returns jsonb language plpgsql security invoker set search_path='' as $$
declare ev private.events%rowtype;o private.outbox%rowtype;ok_v boolean;
begin
 if op='claim' then
  perform 1 from private.household where id=1 for update;
  update private.events set state='working',attempts=attempts+1,lease_until=now()+interval '3 minutes',turn_until=now()+interval '3 minutes',turn_token=gen_random_uuid()::text
  where id=(select e.id from private.events e where (e.state='new' or (e.state='working' and e.lease_until<now())) and not exists(select 1 from private.events busy where busy.actor=e.actor and busy.id<>e.id and (busy.turn_until>now() or (busy.state='working' and busy.lease_until>=now()))) order by e.id for update skip locked limit 1) returning * into ev;
  if not found then return '{}';end if;
  return jsonb_build_object('id',ev.id,'actor',ev.actor,'payload',ev.payload,'action',ev.action,'attempts',ev.attempts,'turn_token',ev.turn_token);
 elsif op='finish' then
  update private.events set turn_until=null,turn_token=null where id=(data->>'id')::bigint and turn_token=data->>'token';return jsonb_build_object('ok',found);
 elsif op='outbox' then
  update private.outbox set lease_until=now()+interval '3 minutes',delivery_token=gen_random_uuid()::text,delivery_attempts=delivery_attempts+1
  where id=(select b.id from private.outbox b where b.sent_at is null and b.retry_at<=now() and (b.lease_until is null or b.lease_until<now()) and not exists(select 1 from private.events e where e.id=b.event_id and e.turn_until>now()) order by b.id for update skip locked limit 1) returning * into o;
  if not found then return '{}';end if;
  select * into ev from private.events where id=o.event_id;
  return jsonb_build_object('id',o.id,'token',o.delivery_token,'part',o.delivery_part,'telegram_message_id',o.telegram_message_id,'event_id',o.event_id,'message',o.message,'result',o.result,'messageId',ev.message_id,'threadId',ev.thread_id);
 elsif op='sent' then
  update private.outbox set sent_at=now(),lease_until=null,delivery_token=null,telegram_message_id=coalesce((data->>'telegram_message_id')::bigint,telegram_message_id) where id=(data->>'id')::bigint and delivery_token=data->>'token' and lease_until>now() and sent_at is null;
  return jsonb_build_object('ok',found);
 elsif op='progress' then
  update private.outbox set delivery_part=(data->>'part')::int,telegram_message_id=(data->>'telegram_message_id')::bigint,lease_until=now()+interval '3 minutes' where id=(data->>'id')::bigint and delivery_token=data->>'token' and lease_until>now() and sent_at is null and delivery_part=(data->>'part')::int-1;
  return jsonb_build_object('ok',found);
 elsif op='failed' then
  update private.outbox set retry_at=now()+least(300,15*power(2,least(delivery_attempts-1,5))) * interval '1 second',lease_until=null,delivery_token=null where id=(data->>'id')::bigint and delivery_token=data->>'token' and sent_at is null;
  return jsonb_build_object('ok',found);
 end if;
 raise exception 'unknown queue operation';
end $$;
revoke all on function public.finance_queue(text,jsonb) from public,anon,authenticated;
grant execute on function public.finance_queue(text,jsonb) to service_role;
