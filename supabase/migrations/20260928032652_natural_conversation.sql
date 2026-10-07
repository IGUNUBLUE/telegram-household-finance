create function public.finance_natural(op text,data jsonb default '{}') returns jsonb language plpgsql security invoker set search_path='' as $$
declare ev private.events%rowtype;reply_result jsonb;
begin
 if op<>'context' then raise exception 'unknown operation';end if;
 select * into ev from private.events where id=(data->>'id')::bigint;if not found then raise exception 'unknown event';end if;
 if ev.payload->>'replyTo' is not null then
  select o.result into reply_result from private.outbox o join private.events ee on ee.id=o.event_id where o.telegram_message_id=(ev.payload->>'replyTo')::bigint order by o.id desc limit 1;
 end if;
 return jsonb_build_object(
  'pending_proposals',(select coalesce(jsonb_agg(jsonb_build_object('id',p.id,'action',p.action)),'[]') from private.proposals p where p.actor=ev.actor and p.state='pending' and p.expires_at>now()),
  'reply_result',reply_result,
  'latest_result',(select o.result from private.outbox o join private.events ee on ee.id=o.event_id where ee.actor=ev.actor and o.sent_at is not null order by o.sent_at desc limit 1),
  'goals',(select coalesce(jsonb_agg(jsonb_build_object('id',g.id,'label',g.label,'project',g.project)),'[]') from private.goals g),
  'commitments',(select coalesce(jsonb_agg(jsonb_build_object('id',c.id,'label',c.label,'due',c.due,'project',c.project)),'[]') from private.commitments c where state='open'),
  'statements',(select coalesce(jsonb_agg(x),'[]') from (select b.id,a.name account,b.created_at from private.statement_batches b join private.accounts a on a.id=b.account_id order by b.id desc limit 5) x)
 );
end $$;
revoke all on function public.finance_natural(text,jsonb) from public,anon,authenticated;
grant execute on function public.finance_natural(text,jsonb) to service_role;
