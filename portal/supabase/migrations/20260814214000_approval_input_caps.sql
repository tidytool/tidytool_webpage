-- What: length caps on submit_drawer_approval inputs — p_name max 120 chars and
--   p_note max 2000 chars (both measured after trim). Everything else is byte-identical
--   to the live definition (verified 2026-08-14: dev and prod pg_get_functiondef md5
--   both 77203ee91df94e6e21b3532b1937062e — the 20260628163738 body plus the
--   customer-email notify block).
-- Why: the RPC is anon-callable by design (capability link on docs/approve/), so anyone
--   holding a drawer link could store unbounded text on the drawer row and the
--   append-only drawer_event log, and pad the Discord/email notifications. Friendly
--   error messages surface directly in the approve page's error line.
-- Rollback: re-apply the prior definition (capture pg_get_functiondef before applying,
--   or remove the two length checks from this file's body and re-run CREATE OR REPLACE).
-- Verification:
--   select public.submit_drawer_approval('<drawer id>', repeat('x', 121));
--   -- expect: ERROR 22001 'Please keep your name under 120 characters.'
--   select public.submit_drawer_approval('<drawer id>', 'QA', 'changes_requested', repeat('x', 2001));
--   -- expect: ERROR 22001 'Please keep your note under 2,000 characters.'
--   Normal-length approve/changes_requested behavior unchanged.

create or replace function public.submit_drawer_approval(
  p_id uuid, p_name text, p_decision text default 'approved', p_note text default null
) returns json
language plpgsql security definer set search_path = public
as $function$
declare
  d public.drawer;
  v_status text;
  v_name text := btrim(coalesce(p_name,''));
  v_note text := nullif(btrim(coalesce(p_note,'')),'');
begin
  if v_name = '' then
    raise exception 'A name is required to sign off.' using errcode = '22000';
  end if;
  if length(v_name) > 120 then
    raise exception 'Please keep your name under 120 characters.' using errcode = '22001';
  end if;
  if v_note is not null and length(v_note) > 2000 then
    raise exception 'Please keep your note under 2,000 characters.' using errcode = '22001';
  end if;
  if p_decision not in ('approved','changes_requested') then
    raise exception 'Invalid decision.' using errcode = '22000';
  end if;

  select * into d from public.drawer where id = p_id for update;
  if not found then
    raise exception 'Drawer not found.' using errcode = 'P0002';
  end if;
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

  insert into public.drawer_event
    (drawer_id, revision, event_type, actor_name, actor_role, note, preview_url, dxf_url)
  values
    (p_id, d.current_revision, p_decision, v_name, 'customer', v_note, d.design_preview_url, d.dxf_url);

  begin
    perform public._notify_discord_approval(p_id, p_decision, v_name, v_note);
  exception when others then
    null;
  end;

  -- Confirmation email to the customer on approval (best-effort)
  if p_decision = 'approved' then
    begin
      perform public._notify_customer_email(p_id, 'approved', v_note, d.current_revision);
    exception when others then
      null;
    end;
  end if;

  return json_build_object('ok', true, 'status', v_status);
end;
$function$;
