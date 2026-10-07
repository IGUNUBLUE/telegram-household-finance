-- The family ledger is shared; month-end balance verification belongs to each
-- account holder. Filtering here also restricts check and close_finish.
do $$declare src text;patched text;
begin
 src:=pg_get_functiondef('public.finance_routines(text,jsonb)'::regprocedure);
 patched:=replace(src,'where not ac.internal group by ac.id)x;',
  'where not ac.internal and ac.owner=ev.actor group by ac.id)x;');
 if src=patched then raise exception 'Missing monthly account ownership patch';end if;src:=patched;
 patched:=replace(src,'''name'',x.name,''kind'',x.kind,''balance_known''',
  '''name'',x.name,''kind'',x.kind,''owner'',x.owner,''owner_name'',(select name from private.members where id=x.owner),''balance_known''');
 if src=patched then raise exception 'Missing review owner metadata patch';end if;src:=patched;
 patched:=replace(src,'from (select ac.name,ac.kind,','from (select ac.name,ac.kind,ac.owner,');
 if src=patched then raise exception 'Missing owner projection patch';end if;src:=patched;
 patched:=replace(src,'if r is null then raise exception ''unknown account'';end if;',
  'if r is null then raise exception ''Solo el titular puede verificar el saldo de esa cuenta en su cierre mensual'';end if;');
 if src=patched then raise exception 'Missing account check guard patch';end if;src:=patched;
 patched:=replace(src,'jsonb_build_object(''month'',m,''through'',end_d,''report'',report_v,',
  'jsonb_build_object(''month'',m,''through'',end_d,''review_actor'',ev.actor,''account_scope'',''owned'',''report'',report_v,');
 if src=patched then raise exception 'Missing review scope metadata patch';end if;
 execute patched;
end $$;
