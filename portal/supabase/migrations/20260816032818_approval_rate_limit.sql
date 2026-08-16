-- What: per-drawer rate limit on submit_drawer_approval — at most 10 customer
--   submissions (approved / changes_requested drawer_event rows) per drawer per
--   rolling hour. Everything else is byte-identical to the live definition (the
--   20260814214000 body; dev and prod pg_get_functiondef md5 both
--   d0b5e1a3dff54efef9cbc74a2f9e3962, verified 2026-08-15/16 before applying).
-- Why: the RPC is anon-callable (capability link on docs/approve/) and had no
--   throttle — a scripted loop with a leaked drawer link could append
--   drawer_event rows and ping Discord/email until manually stopped
--   (planning/WEBSITE-SAFETY.md, gap 4). The check counts only customer
--   submission events for THIS drawer, so staff activity never trips it and one
--   abused link can't affect other customers; it runs under the drawer row lock,
--   so concurrent submitters can't race past it. Real customers reviewing a
--   design never hit 10 decisions in an hour.
-- Rollback: re-apply the 20260814214000 definition (or remove the rate-limit
--   block from this file's body and re-run CREATE OR REPLACE).
-- Verification (dev):
--   -- 10 changes_requested calls in a loop succeed; the 11th raises:
--   -- ERROR 54000 'Too many submissions for this drawer — please try again in an hour.'
--   -- Staff drawer_event rows (design_uploaded etc.) do not count toward the cap.
--   -- Normal approve/changes_requested behavior otherwise unchanged.

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

  -- Per-drawer rate limit; runs under the row lock taken above.
  if (select count(*) from public.drawer_event
       where drawer_id = p_id
         and actor_role = 'customer'
         and event_type in ('approved','changes_requested')
         and created_at > now() - interval '1 hour') >= 10 then
    raise exception 'Too many submissions for this drawer — please try again in an hour.'
      using errcode = '54000';
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
