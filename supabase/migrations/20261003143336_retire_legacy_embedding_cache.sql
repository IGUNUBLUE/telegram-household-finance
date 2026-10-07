-- Run only after the E5 worker and its rebuilt index have been verified.
-- Retire derived English vectors; never modify original text or financial records.
do $$
begin
 if exists(select 1 from private.memory_embeddings where model not in ('gte-small-en-v1','multilingual-e5-small-es-q8-v1')) then
  raise exception 'unexpected embedding model';
 end if;
 if exists(
  select 1 from private.memory_sources s left join private.memory_embeddings m
  on m.key=s.key and m.model='multilingual-e5-small-es-q8-v1' and m.source_hash=md5(s.content)
  where m.embedding is null
 ) then raise exception 'E5 index incomplete; English cache preserved';end if;
 delete from private.memory_embeddings where model='gte-small-en-v1';
end $$;
