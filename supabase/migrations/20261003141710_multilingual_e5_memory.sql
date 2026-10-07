-- Preserve the English cache for rollback; E5 builds an independent Spanish cache.
-- Existing workers default to gte-small; every vector read/write is model-bound.
-- No financial tables, source text, permissions, queue or Flue state are modified.
alter table private.memory_embeddings drop constraint memory_embeddings_pkey;
alter table private.memory_embeddings add primary key (key,model);
create or replace function public.finance_memory(op text,data jsonb default '{}') returns jsonb language plpgsql security invoker set search_path='' as $$
declare actor_v text;q text;v extensions.vector(384);answer jsonb;model_v text:=coalesce(data->>'model','gte-small-en-v1');
begin
 if model_v not in ('gte-small-en-v1','multilingual-e5-small-es-q8-v1') then raise exception 'unsupported embedding model';end if;
 if op='next' then
  delete from private.memory_embeddings m where not exists(select 1 from private.memory_sources s where s.key=m.key);
  insert into private.memory_embeddings(key,source_hash,model)
   select s.key,md5(s.content),model_v from private.memory_sources s
   on conflict(key,model) do update set source_hash=excluded.source_hash,embedding=null,attempts=0,retry_at=now(),lease=null,lease_until=null,updated_at=now()
   where memory_embeddings.source_hash<>excluded.source_hash;
  with claimed as (
   update private.memory_embeddings set attempts=attempts+1,lease=gen_random_uuid()::text,lease_until=now()+interval '3 minutes'
   where model=model_v and key in (select key from private.memory_embeddings where model=model_v and embedding is null and attempts<5 and retry_at<=now() and (lease_until is null or lease_until<now()) order by updated_at,key for update skip locked limit 2)
   returning *
  ) select coalesce(jsonb_agg(jsonb_build_object('key',c.key,'hash',c.source_hash,'lease',c.lease,'text',s.content)),'[]') into answer from claimed c join private.memory_sources s on s.key=c.key;
  return answer;
 elsif op='store' then
  v:=(data->>'embedding')::extensions.vector(384);
  if v is null or extensions.vector_norm(v)<0.9 or extensions.vector_norm(v)>1.1 then raise exception 'invalid embedding norm';end if;
  update private.memory_embeddings m set embedding=v,lease=null,lease_until=null,updated_at=now()
   where m.model=model_v and m.key=data->>'key' and m.source_hash=data->>'hash' and m.lease=data->>'lease' and m.lease_until>now()
   and exists(select 1 from private.memory_sources s where s.key=m.key and md5(s.content)=m.source_hash);
  return jsonb_build_object('stored',found);
 elsif op='fail' then
  update private.memory_embeddings set lease=null,lease_until=null,retry_at=now()+interval '10 minutes' where model=model_v and key=data->>'key' and lease=data->>'lease';
  return '{}';
 elsif op='status' then
  return jsonb_build_object('sources',(select count(*) from private.memory_sources),'indexed',(select count(*) from private.memory_embeddings m join private.memory_sources s on s.key=m.key and md5(s.content)=m.source_hash where m.model=model_v and m.embedding is not null),'failed',(select count(*) from private.memory_embeddings where model=model_v and embedding is null and attempts>=5));
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
  from private.memory_sources s left join private.memory_embeddings m on m.key=s.key and m.source_hash=md5(s.content) and m.model=model_v
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
