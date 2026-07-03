create or replace function public.drawer_event_immutable()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'drawer_event is append-only; % is not permitted', tg_op
    using errcode = '0A000';
end;
$$;