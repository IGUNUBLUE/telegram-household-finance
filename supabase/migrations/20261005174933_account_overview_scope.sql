-- Scope account balances BEFORE aggregation; "mine" is tied to the saved event
-- actor, never to model-supplied owner/payer IDs. Legacy overview stays global.
do $$
declare src text;needle text;replacement text;
begin
 src:=pg_get_functiondef('public.finance_family(text,jsonb)'::regprocedure);
 needle:='  cutoff:=(data->>''as_of'')::date;';
 replacement:='  if data ? ''account_scope'' and (data->>''account_scope'' is null or data->>''account_scope'' not in (''mine'',''all'')) then raise exception ''valid account scope required'';end if;
'||needle;
 if strpos(src,needle)=0 then raise exception 'Missing overview date validation';end if;
 src:=replace(src,needle,replacement);
 needle:='where not ac.internal and ac.kind in (''asset'',''liability'',''receivable'')';
 replacement:=needle||'
    and (coalesce(data->>''account_scope'',''all'')=''all'' or ac.owner=ev.actor)';
 if strpos(src,needle)=0 then raise exception 'Missing overview account selection';end if;
 src:=replace(src,needle,replacement);
 needle:='''source'',''ledger'',''as_of'',cutoff,''cash_cents''';
 replacement:='''source'',''ledger'',''as_of'',cutoff,''account_scope'',coalesce(data->>''account_scope'',''all''),''cash_cents''';
 if strpos(src,needle)=0 then raise exception 'Missing overview result';end if;
 execute replace(src,needle,replacement);
end $$;
-- CREATE OR REPLACE retains the existing service-role-only permissions and
-- SECURITY INVOKER/STABLE declaration; assert these again for clarity.
revoke all on function public.finance_family(text,jsonb) from public,anon,authenticated;
grant execute on function public.finance_family(text,jsonb) to service_role;
