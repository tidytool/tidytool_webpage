-- ============================================================================
-- Engraved tool labels are a product-tier feature (Sam, 2026-09-29).
--
-- drawer.tier already encodes it (product_tiers, 2026-07-30): essential = cut
-- foam only; professional / premium = engraved tool labels. The portal had no
-- way to know, so every customer saw "Labels needed" and the engraving entry
-- form even when they hadn't bought labels. This migration exposes the tier
-- decision to the customer surfaces and guards the label RPCs.
--
--   1. _labels_included(tier) helper (internal).
--   2. get_drawer_labels: + 'labels_included' in the drawer payload.
--   3. get_my_label_status: + labels_included column (return type changes, so
--      DROP + CREATE; grants re-applied).
--   4. save_drawer_labels / submit_drawer_labels: refuse for customers on an
--      Essential drawer (submit auto-approves, so this is a real state guard).
--      Staff are exempt so they can still enter labels on a customer's behalf.
--
-- No table changes. No data changes: every existing drawer is 'essential'
-- (decision 2026-09-29: no backfill — flip a drawer's tier from the admin
-- order page when a customer buys labels).
-- ROLLBACK: re-run the four function bodies from 20260803120000 /
-- 20260804120000 and drop _labels_included.
-- ============================================================================

create or replace function public._labels_included(p_tier text)
returns boolean
language sql
immutable
as $$
  select coalesce(p_tier, 'essential') in ('professional', 'premium');
$$;
revoke all on function public._labels_included(text) from public, anon, authenticated;

-- 2. get_drawer_labels ------------------------------------------------------
create or replace function public.get_drawer_labels(p_drawer_id uuid)
returns json
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  d public.drawer;
  v_staff boolean := public.is_staff();
begin
  if not v_staff and not public._customer_can_see_drawer(p_drawer_id) then
    raise exception 'Drawer not found.' using errcode = 'P0002';
  end if;

  select * into d from public.drawer where id = p_drawer_id;
  if not found then
    raise exception 'Drawer not found.' using errcode = 'P0002';
  end if;

  return json_build_object(
    'ok', true,
    'drawer', json_build_object(
      'id', d.id,
      'nickname', d.nickname,
      'photo_url', d.photo_url,
      'dxf_url', d.dxf_url,
      'dimensions', d.dimensions,
      'dxf_revision', d.dxf_revision,
      'stage', d.stage,
      'stage_sort', public._drawer_stage_sort(d.stage),
      'labels_submitted_at', d.labels_submitted_at,
      'labels_submitted_by', d.labels_submitted_by,
      'locked', public._labels_locked(d.stage, d.state),
      -- Server-computed so the client carries no stage constants.
      'editable', not public._labels_locked(d.stage, d.state)
                  and coalesce(public._drawer_stage_sort(d.stage), 0) >=
                      (select sort_order from public.status_def
                        where domain = 'drawer' and code = 'designed'),
      'is_staff', v_staff,
      -- Engraved labels are a Professional/Premium tier feature (drawer.tier).
      'labels_included', public._labels_included(d.tier)
    ),
    'labels', coalesce((
      select json_agg(json_build_object(
               'pocket_key', l.pocket_key,
               'pocket_index', l.pocket_index,
               'label_text', l.label_text,
               'na', l.na,
               'dxf_revision', l.dxf_revision
             ) order by l.pocket_index)
        from public.drawer_label l
       where l.drawer_id = p_drawer_id
    ), '[]'::json)
  );
end;
$$;

-- 3. get_my_label_status (return type change) --------------------------------
drop function if exists public.get_my_label_status();
create or replace function public.get_my_label_status()
returns table (
  drawer_id uuid,
  stage_sort integer,
  has_dxf boolean,
  labels_submitted_at timestamptz,
  locked boolean,
  labels_included boolean
)
language sql
security definer
set search_path to 'public'
as $$
  with me as (
    select c.id, c.organization_id
      from public.customer c
     where c.auth_user_id = (select auth.uid())
  )
  select d.id,
         public._drawer_stage_sort(d.stage),
         d.dxf_url is not null and btrim(d.dxf_url) <> '',
         d.labels_submitted_at,
         public._labels_locked(d.stage, d.state),
         public._labels_included(d.tier)
    from public.drawer d
    join public."order" o on o.id = d.order_id
    join me on (
          o.customer_id = me.id
       or (me.organization_id is not null and o.organization_id = me.organization_id)
       or (me.organization_id is not null and o.customer_id in (
             select c2.id from public.customer c2
              where c2.organization_id = me.organization_id))
    );
$$;

revoke all on function public.get_my_label_status() from public, anon;
grant execute on function public.get_my_label_status() to authenticated;

-- 4. label RPC guards ---------------------------------------------------------
create or replace function public.save_drawer_labels(
  p_drawer_id uuid, p_rows jsonb,
  p_dxf_revision integer default null, p_nickname text default null)
returns json
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  d public.drawer;
  v_nick text := nullif(btrim(coalesce(p_nickname, '')), '');
  v_n int;
begin
  if not public.is_staff() and not public._customer_can_see_drawer(p_drawer_id) then
    raise exception 'Drawer not found.' using errcode = 'P0002';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'Invalid rows payload.' using errcode = '22000';
  end if;
  if jsonb_array_length(p_rows) > 200 then
    raise exception 'Too many label rows.' using errcode = '22000';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_rows) r
     where length(coalesce(r->>'label_text', '')) > 500) then
    raise exception 'Label text is limited to 500 characters.' using errcode = '22000';
  end if;
  if length(coalesce(v_nick, '')) > 500 then
    raise exception 'Drawer name is limited to 500 characters.' using errcode = '22000';
  end if;
  -- A duplicated pocket_key would make the upsert fail with "ON CONFLICT
  -- cannot affect row a second time" — reject it as a payload error instead.
  if exists (
    select 1 from jsonb_array_elements(p_rows) r
     where coalesce(btrim(r->>'pocket_key'), '') <> ''
     group by r->>'pocket_key' having count(*) > 1) then
    raise exception 'Duplicate pocket in payload.' using errcode = '22000';
  end if;

  select * into d from public.drawer where id = p_drawer_id for update;
  if not found then
    raise exception 'Drawer not found.' using errcode = 'P0002';
  end if;
  if not public.is_staff() and not public._labels_included(d.tier) then
    raise exception 'Engraved labels are not included on this drawer.' using errcode = '42501';
  end if;
  if public._labels_locked(d.stage, d.state) then
    raise exception 'This drawer is locked — labels can no longer change.' using errcode = '42501';
  end if;
  if coalesce(public._drawer_stage_sort(d.stage), 0) <
     (select sort_order from public.status_def where domain='drawer' and code='designed') then
    raise exception 'Labels open once the design is complete.' using errcode = '42501';
  end if;

  delete from public.drawer_label l
   where l.drawer_id = p_drawer_id
     and l.pocket_key not in (
       select r->>'pocket_key' from jsonb_array_elements(p_rows) r
        where coalesce(btrim(r->>'pocket_key'), '') <> '');

  insert into public.drawer_label
    (drawer_id, pocket_key, pocket_index, label_text, na, dxf_revision, updated_at)
  select p_drawer_id,
         r->>'pocket_key',
         coalesce((r->>'pocket_index')::int, 0),
         nullif(btrim(coalesce(r->>'label_text', '')), ''),
         coalesce((r->>'na')::boolean, false),
         coalesce(p_dxf_revision, d.dxf_revision),
         now()
    from jsonb_array_elements(p_rows) r
   where coalesce(btrim(r->>'pocket_key'), '') <> ''
  on conflict (drawer_id, pocket_key) do update
     set pocket_index = excluded.pocket_index,
         label_text   = excluded.label_text,
         na           = excluded.na,
         dxf_revision = excluded.dxf_revision,
         updated_at   = now();

  if v_nick is not null then
    update public.drawer set nickname = v_nick where id = p_drawer_id;
  end if;

  select count(*) into v_n from public.drawer_label where drawer_id = p_drawer_id;
  return json_build_object('ok', true, 'rows', v_n);
end;
$$;

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
  if not public.is_staff() and not public._labels_included(d.tier) then
    raise exception 'Engraved labels are not included on this drawer.' using errcode = '42501';
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
