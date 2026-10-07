create schema if not exists extensions;
create extension if not exists vector with schema extensions;
grant usage on schema extensions to service_role;
create view private.memory_sources with (security_invoker=true) as
select 'transaction:'||t.id key,'transaction' kind,t.id::text source_id,t.actor,
 array_remove(array[t.actor,t.payer,t.beneficiary],null) access_ids,t.scope='family' shared,t.date source_date,e.action->>'account' account,
 left(concat_ws(' ',t.memo,t.category,e.action->>'account',e.action->>'other'),1000) content,
 jsonb_build_object('transaction_id',t.id,'state','registered','event_id',t.event_id) reference
from private.transactions t join private.events e on e.id=t.event_id
where t.reverses is null and t.kind<>'opening' and not exists(select 1 from private.transactions rr where rr.reverses=t.id)
union all
select 'conversation:'||ct.event_id,'conversation',ct.event_id::text,c.actor,array[c.actor],false,(ct.created_at at time zone 'America/Bogota')::date,null,
 left(ct.text,1000),jsonb_build_object('event_id',ct.event_id,'state',coalesce(e.result->>'status','pending'),'message_id',e.message_id)
from private.conversation_turns ct join private.conversations c on c.id=ct.session_id join private.events e on e.id=ct.event_id
where ct.created_at>now()-interval '30 days' and length(coalesce(ct.text,''))>3 and e.result is not null
union all
select 'preference:'||p.actor||':'||p.merchant,'preference',p.merchant,p.actor,array[p.actor],false,null,p.account,
 left(concat_ws(' ',p.merchant,p.account,p.category,p.scope),1000),jsonb_build_object('merchant',p.merchant,'state','confirmed')
from private.preferences p;
revoke all on private.memory_sources from public,anon,authenticated;
grant select on private.memory_sources to service_role;
create table private.memory_embeddings(
 key text primary key,source_hash text not null,embedding extensions.vector(384),model text not null default 'gte-small-en-v1',
 attempts integer not null default 0,retry_at timestamptz not null default now(),lease text,lease_until timestamptz,updated_at timestamptz not null default now()
);
alter table private.memory_embeddings enable row level security;
grant all on private.memory_embeddings to service_role;
-- Exact vector scan: this family's bounded corpus does not justify an approximate index yet.
create function public.finance_memory(op text,data jsonb default '{}') returns jsonb language plpgsql security invoker set search_path='' as $$
declare actor_v text;q text;v extensions.vector(384);answer jsonb;
begin
 if op='next' then
  delete from private.memory_embeddings m where not exists(select 1 from private.memory_sources s where s.key=m.key);
  insert into private.memory_embeddings(key,source_hash)
   select s.key,md5(s.content) from private.memory_sources s
   on conflict(key) do update set source_hash=excluded.source_hash,embedding=null,attempts=0,retry_at=now(),lease=null,lease_until=null,updated_at=now()
   where memory_embeddings.source_hash<>excluded.source_hash;
  with claimed as (
   update private.memory_embeddings set attempts=attempts+1,lease=gen_random_uuid()::text,lease_until=now()+interval '3 minutes'
   where key in (select key from private.memory_embeddings where embedding is null and attempts<5 and retry_at<=now() and (lease_until is null or lease_until<now()) order by updated_at,key for update skip locked limit 2)
   returning *
  ) select coalesce(jsonb_agg(jsonb_build_object('key',c.key,'hash',c.source_hash,'lease',c.lease,'text',s.content)),'[]') into answer from claimed c join private.memory_sources s on s.key=c.key;
  return answer;
 elsif op='store' then
  v:=(data->>'embedding')::extensions.vector(384);
  if v is null or extensions.vector_norm(v)<0.9 or extensions.vector_norm(v)>1.1 then raise exception 'invalid embedding norm';end if;
  update private.memory_embeddings m set embedding=v,lease=null,lease_until=null,updated_at=now()
   where m.key=data->>'key' and m.source_hash=data->>'hash' and m.lease=data->>'lease' and m.lease_until>now()
   and exists(select 1 from private.memory_sources s where s.key=m.key and md5(s.content)=m.source_hash);
  return jsonb_build_object('stored',found);
 elsif op='fail' then
  update private.memory_embeddings set lease=null,lease_until=null,retry_at=now()+interval '10 minutes' where key=data->>'key' and lease=data->>'lease';
  return '{}';
 elsif op='status' then
  return jsonb_build_object('sources',(select count(*) from private.memory_sources),'indexed',(select count(*) from private.memory_embeddings m join private.memory_sources s on s.key=m.key and md5(s.content)=m.source_hash where m.embedding is not null),'failed',(select count(*) from private.memory_embeddings where embedding is null and attempts>=5));
 elsif op<>'search' then raise exception 'unknown memory operation';end if;
 select actor into actor_v from private.events where id=(data->>'id')::bigint;
 if actor_v is null then raise exception 'unknown event';end if;
 q:=trim(coalesce(data->>'query',''));
 if length(q) not between 2 and 300 then raise exception 'invalid query';end if;
 if data->'embedding' is not null and data->'embedding'<>'null'::jsonb then
  v:=(data->>'embedding')::extensions.vector(384);
  if v is null or extensions.vector_norm(v)<0.9 or extensions.vector_norm(v)>1.1 then raise exception 'invalid embedding norm';end if;
 end if;
 with eligible as (
  select s.*,m.embedding,1-(m.embedding operator(extensions.<=>) v) similarity,
   to_tsvector('spanish'::regconfig,s.content) document,websearch_to_tsquery('spanish'::regconfig,q) query
  from private.memory_sources s left join private.memory_embeddings m on m.key=s.key and m.source_hash=md5(s.content) and m.model='gte-small-en-v1'
  where (s.shared or actor_v=any(s.access_ids))
   and (coalesce(data->>'kind','all')='all' or s.kind=data->>'kind')
   and (data->>'from' is null or s.source_date>=(data->>'from')::date)
   and (data->>'to' is null or s.source_date<=(data->>'to')::date)
   and (data->>'account' is null or s.account=data->>'account')
 ), lexical as (
  select key,row_number() over(order by ts_rank(document,query) desc,key) rank from eligible where document@@query order by ts_rank(document,query) desc,key limit 20
 ), semantic as (
  select key,row_number() over(order by similarity desc,key) rank from eligible where v is not null and embedding is not null and similarity>=0.72 order by similarity desc,key limit 20
 ), fused as (
  select e.*,coalesce(1.0/(60+l.rank),0)+coalesce(1.0/(60+s.rank),0) score,l.rank is not null lexical_match,s.rank is not null semantic_match
  from eligible e left join lexical l on l.key=e.key left join semantic s on s.key=e.key where l.key is not null or s.key is not null
 ) select jsonb_build_object('mode',case when v is null then 'text_only' else 'hybrid' end,'candidate_only',true,'matches',coalesce(jsonb_agg(x),'[]')) into answer
 from (select kind,source_id,source_date,content,reference,lexical_match,semantic_match,score from fused order by score desc,source_date desc nulls last,key limit 8)x;
 return answer;
end $$;
revoke all on function public.finance_memory(text,jsonb) from public,anon,authenticated;
grant execute on function public.finance_memory(text,jsonb) to service_role;
