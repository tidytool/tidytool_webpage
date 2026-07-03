-- Allow a change request to reopen an approved design; still block duplicate approvals.
create or replace function public.submit_drawer_approval(
  p_id uuid,
  p_name text,
  p_decision text default 'approved',
  p_note text default null
) returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  d public.drawer;
  v_status text;
  v_name text := btrim(coalesce(p_name,''));
  v_note text := nullif(btrim(coalesce(p_note,'')),'');
begin
  if v_name = '' then
    raise exception 'A name is required to sign off.' using errcode = '22000';
  end if;
  if p_decision not in ('approved','changes_requested') then
    raise exception 'Invalid decision.' using errcode = '22000';
  end if;

  select * into d from public.drawer where id = p_id for update;
  if not found then
    raise exception 'Drawer not found.' using errcode = 'P0002';
  end if;

  -- Prevent duplicate approvals, but always allow a change request (even after approval) to reopen.
  if p_decision = 'approved' and d.customer_approval_status = 'approved' then
    raise exception 'This design has already been approved.' using errcode = '23505';
  end if;

  update public.drawer
     set customer_approval_status = p_decision,
         approved_by   = v_name,
         approved_at   = case when p_decision = 'approved' then now() else null end,
         approval_note = v_note
   where id = p_id
   returning customer_approval_status into v_status;

  begin
    perform public._notify_discord_approval(p_id, p_decision, v_name, v_note);
  exception when others then
    null;
  end;

  return json_build_object('ok', true, 'status', v_status);
end;
$$;