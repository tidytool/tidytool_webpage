-- Label submission = go-ahead (2026-08-04 portal UX redesign)
--
-- The customer-facing approval step is removed from the portal: submitting
-- tool labels is the customer's confirmation of the design. This migration
-- re-creates submit_drawer_labels so a submit on a drawer whose
-- customer_approval_status is still 'pending' also stamps the approval
-- (approved_by/approved_at, same typed name) and logs an 'approved'
-- drawer_event. The existing status-backbone bridge trigger then advances
-- the drawer's stage exactly as a manual approval would.
--
-- Scope notes:
--   * Only 'pending' auto-approves. 'changes_requested' drawers are in a
--     staff-mediated conversation and keep needing an explicit resolution.
--   * Re-submits on already-approved drawers change nothing approval-wise
--     (matches the old duplicate-approval guard's intent without raising).
--   * The public /approve page and submit_drawer_approval remain untouched
--     as a fallback path; the portal simply no longer links to them.
--   * Signature is unchanged, so existing grants carry over.

create or replace function public.submit_drawer_labels(
  p_drawer_id uuid, p_name text, p_nickname text default null,
  p_expected_count integer default null)
returns json
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  d public.drawer;
  v_name text := btrim(coalesce(p_name, ''));
  v_nick text := nullif(btrim(coalesce(p_nickname, '')), '');
  v_total int;
  v_named int;
  v_na    int;
  v_note  text;
  v_auto_approve boolean;
begin
  if v_name = '' then
    raise exception 'A name is required to submit labels.' using errcode = '22000';
  end if;
  if length(v_name) > 200 or length(coalesce(v_nick, '')) > 500 then
    raise exception 'That name is too long.' using errcode = '22000';
  end if;
  if not public.is_staff() and not public._customer_can_see_drawer(p_drawer_id) then
    raise exception 'Drawer not found.' using errcode = 'P0002';
  end if;

  select * into d from public.drawer where id = p_drawer_id for update;
  if not found then
    raise exception 'Drawer not found.' using errcode = 'P0002';
  end if;
  if public._labels_locked(d.stage, d.state) then
    raise exception 'This drawer is locked — labels can no longer change.' using errcode = '42501';
  end if;

  select count(*),
         count(*) filter (where not na and coalesce(btrim(label_text), '') <> ''),
         count(*) filter (where na)
    into v_total, v_named, v_na
    from public.drawer_label
   where drawer_id = p_drawer_id;

  if v_total = 0 then
    raise exception 'No labels to submit yet.' using errcode = '22000';
  end if;
  if p_expected_count is not null and p_expected_count <> v_total then
    raise exception 'Your labels are out of sync — refresh the page and try again.' using errcode = '22000';
  end if;
  if v_named + v_na < v_total then
    raise exception 'Every pocket needs a label or N/A before submitting.' using errcode = '22000';
  end if;

  v_auto_approve := (d.customer_approval_status = 'pending');

  update public.drawer
     set labels_submitted_at = now(),
         labels_submitted_by = v_name,
         nickname = coalesce(v_nick, nickname),
         customer_approval_status = case when v_auto_approve then 'approved'
                                         else customer_approval_status end,
         approved_by = case when v_auto_approve then v_name else approved_by end,
         approved_at = case when v_auto_approve then now() else approved_at end
   where id = p_drawer_id;

  v_note := v_named || ' labeled · ' || v_na || ' n/a';

  insert into public.drawer_event
    (drawer_id, revision, event_type, actor_name, actor_role, note)
  values
    (p_drawer_id, d.current_revision, 'labels_submitted', v_name, 'customer', v_note);

  if v_auto_approve then
    insert into public.drawer_event
      (drawer_id, revision, event_type, actor_name, actor_role, note)
    values
      (p_drawer_id, d.current_revision, 'approved', v_name, 'customer',
       'Approved via label submission');
  end if;

  begin
    perform public._notify_labels_submitted(p_drawer_id, v_name, v_note);
  exception when others then
    null;
  end;

  return json_build_object('ok', true, 'labeled', v_named, 'na', v_na,
                           'approved', v_auto_approve);
end;
$$;
