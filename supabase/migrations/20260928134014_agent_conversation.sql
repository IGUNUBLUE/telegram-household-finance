-- Preserve useful explanations instead of truncating them to a form-field length.
do $migration$
declare definition text;
begin
 select pg_get_functiondef('public.finance_api(text,jsonb)'::regprocedure) into definition;
 if strpos(definition,'left(a->>''question'',200)')=0 then raise exception 'Unexpected finance_api definition'; end if;
 definition:=replace(definition,'left(a->>''question'',200)','left(a->>''question'',2000)');
 execute replace(definition,'''2 minutes''','''3 minutes''');
 select pg_get_functiondef('public.finance_pro(text,jsonb)'::regprocedure) into definition;
 execute replace(definition,'left(data->>''answer'',500)','left(data->>''answer'',2000)');
end
$migration$;
