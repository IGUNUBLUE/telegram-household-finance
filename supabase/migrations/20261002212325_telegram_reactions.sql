-- Existing outbox delivery carries a safe reaction target across restarts.
-- Callback message IDs belong to bot messages, so they are never targets.
-- Preserve the existing claims, leases, authorization and ledger unchanged.
alter table private.events add column reaction_message_id bigint;
do $$
declare source text; needle text := '''messageId'',ev.message_id,''threadId'',ev.thread_id';
claim_needle text := 'update private.events set state=''working'',attempts=attempts+1';
begin
 select pg_get_functiondef('public.finance_queue(text,jsonb)'::regprocedure) into source;
 if position(needle in source)=0 or position(claim_needle in source)=0 then raise exception 'Reaction target extension does not match current queue';end if;
 -- Apply can erase payload after committing. Capture provenance at claim time.
 source:=replace(source,claim_needle,claim_needle||',reaction_message_id=case when coalesce(payload->>''callback'','''')='''' then message_id else null end');
 source:=replace(source,needle,needle||',''reactionMessageId'',ev.reaction_message_id');
 execute source;
end $$;
