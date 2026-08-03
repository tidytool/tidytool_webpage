-- Customer tool labels (spec: planning/customer-label-tool-spec.md)
--
-- Customers name each tool pocket of a design-complete drawer so labels can be
-- filled in before the foam is cut. Pockets are enumerated CLIENT-side from the
-- drawer's DXF (Outline LWPOLYLINEs + CIRCLEs, keyed by DXF entity handle,
-- numbered by the Labels-layer "Object N" text) — the DB stores one row per
-- pocket, keyed (drawer_id, pocket_key).
--
-- Design decisions (locked 2026-08-03):
--   * auto-save drafts; explicit submit stamps labels_submitted_*
--   * no text length limit; N/A checkbox per pocket
--   * lock is COMPUTED: stage at/after in_production ⇒ read-only (no trigger)
--   * attribution by typed name (shared logins), like submit_drawer_approval
--   * internal-only notification to Sam via the notify edge function
--
-- Access model: customers reach their drawers through the same
-- customer.auth_user_id / organization join as get_my_drawers(); staff/admin
-- can always read + align. Table is RLS deny-all; SECURITY DEFINER RPCs only.

-- ---------------------------------------------------------------------------
-- 1. Table + drawer columns
-- ---------------------------------------------------------------------------

create table public.drawer_label (
  id            uuid primary key default gen_random_uuid(),
  drawer_id     uuid not null references public.drawer(id) on delete cascade,
  pocket_key    text not null,           -- DXF entity handle (stable per file)
  pocket_index  int  not null,           -- "Object N" number from the DXF Labels layer
  label_text    text,                    -- free text; null when na
  na            boolean not null default false,
  dxf_revision  int,                     -- drawer.dxf_revision the row was written against
  updated_at    timestamptz not null default now(),
  unique (drawer_id, pocket_key)
);

comment on table public.drawer_label is
  'Customer-entered engraving label per tool pocket. Pockets enumerated client-side from the DXF; deny-all RLS, access via SECURITY DEFINER RPCs only.';

alter table public.drawer_label enable row level security;
revoke all on table public.drawer_label from public, anon, authenticated;

create index drawer_label_drawer_idx on public.drawer_label (drawer_id);

alter table public.drawer
  add column labels_submitted_at timestamptz,
  add column labels_submitted_by text;

-- ---------------------------------------------------------------------------
-- 2. drawer_event gains the labels_submitted type
-- ---------------------------------------------------------------------------

alter table public.drawer_event drop constraint drawer_event_event_type_check;
alter table public.drawer_event add constraint drawer_event_event_type_check
  check (event_type = any (array[
    'design_uploaded', 'design_revised', 'approved', 'changes_requested',
    'delivered', 'scan_corrected', 'scan_correction_reverted',
    'labels_submitted'
  ]::text[]));

-- ---------------------------------------------------------------------------
-- 3. Internal helpers
-- ---------------------------------------------------------------------------

-- Can the calling customer see this drawer? Mirrors the get_my_drawers() join
-- (own orders + whole-organization visibility, decision 2026-06-28).
create or replace function public._customer_can_see_drawer(p_drawer_id uuid)
returns boolean
language sql
security definer
set search_path to 'public'
as $$
  select exists (
    with me as (
      select c.id, c.organization_id
        from public.customer c
       where c.auth_user_id = (select auth.uid())
    )
    select 1
      from public.drawer d
      join public."order" o on o.id = d.order_id
      join me on (
            o.customer_id = me.id
         or (me.organization_id is not null and o.organization_id = me.organization_id)
         or (me.organization_id is not null and o.customer_id in (
               select c2.id from public.customer c2
                where c2.organization_id = me.organization_id))
      )
     where d.id = p_drawer_id
  );
$$;

-- Stage sort_order for a drawer (null when the stage code is unknown).
create or replace function public._drawer_stage_sort(p_stage text)
returns integer
language sql
stable
security definer
set search_path to 'public'
as $$
  select s.sort_order from public.status_def s
   where s.domain = 'drawer' and s.code = p_stage;
$$;

-- Labels lock: frozen at/after in_production, and for cancelled drawers
-- (a cancelled drawer should neither invite edits nor email Sam on submit).
create or replace function public._labels_locked(p_stage text, p_state text)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $$
  select p_state = 'cancelled'
      or coalesce(
           public._drawer_stage_sort(p_stage) >=
             (select sort_order from public.status_def
               where domain = 'drawer' and code = 'in_production'),
           false);
$$;

-- Internal-only "labels submitted" note to Sam via the notify edge function.
-- Best-effort: no vault secret configured -> no-op. The edge function resolves
-- the owner recipient itself (NOTIFY_OWNER / NOTIFY_REPLY_TO env).
create or replace function public._notify_labels_submitted(
  p_drawer_id uuid, p_by text, p_note text)
returns void
language plpgsql
security definer
set search_path to 'public', 'vault'
as $$
declare
  v_secret text;
  v_nick   text;
begin
  select decrypted_secret into v_secret
    from vault.decrypted_secrets
   where name = 'notify_hook_secret'
   limit 1;
  if v_secret is null then
    return;
  end if;

  select d.nickname into v_nick from public.drawer d where d.id = p_drawer_id;
  if v_nick ilike '%[TEST]%' then
    return;
  end if;

  perform net.http_post(
    url := 'https://tkrrvpoupekrjqditupi.supabase.co/functions/v1/notify',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-notify-secret', v_secret
    ),
    body := jsonb_build_object(
      'type', 'labels_submitted',
      'to', '',                      -- resolved to the owner inside the function
      'customer_name', p_by,
      'nickname', v_nick,
      'drawer_id', p_drawer_id::text,
      'note', p_note
    )
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. RPCs
-- ---------------------------------------------------------------------------

-- Everything the /labels/[id] page needs in one call.
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
      'is_staff', v_staff
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

-- Draft auto-save. Replace-all semantics: rows absent from the payload are
-- deleted (handles DXF revisions changing the pocket set). p_rows is a jsonb
-- array of {pocket_key, pocket_index, label_text, na}.
--
-- p_dxf_revision is the revision the CLIENT parsed its pockets from — stored
-- verbatim so a stale open tab autosaving after Sam revises the DXF leaves a
-- visible revision mismatch (the designChanged warning). Stamping the
-- drawer's current revision here would silence exactly that case.
-- p_nickname (optional) lets a rename persist with drafts, not only submit.
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

-- Explicit submit: stamps who/when, optionally renames the drawer, logs a
-- drawer_event, and pings Sam. Rows must already be saved (auto-save) and
-- each must carry text or N/A. Re-submitting before lock is allowed.
-- p_expected_count: the pocket count the CLIENT sees — rejects a submit over
-- a partially-saved or stale row set.
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

  update public.drawer
     set labels_submitted_at = now(),
         labels_submitted_by = v_name,
         nickname = coalesce(v_nick, nickname)
   where id = p_drawer_id;

  v_note := v_named || ' labeled · ' || v_na || ' n/a';

  insert into public.drawer_event
    (drawer_id, revision, event_type, actor_name, actor_role, note)
  values
    (p_drawer_id, d.current_revision, 'labels_submitted', v_name, 'customer', v_note);

  begin
    perform public._notify_labels_submitted(p_drawer_id, v_name, v_note);
  exception when others then
    null;
  end;

  return json_build_object('ok', true, 'labeled', v_named, 'na', v_na);
end;
$$;

-- Staff-only: backfill/adjust the photo alignment quad for legacy drawers
-- (drawers scanned before tidyCAM persisted reference_corners). p_corners is
-- [[x,y]×4], normalized 0–1, TL,TR,BR,BL — same shape tidyCAM writes.
create or replace function public.set_drawer_reference_corners(
  p_drawer_id uuid, p_corners jsonb)
returns json
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  d public.drawer;
  i int;
  v_x numeric;
  v_y numeric;
begin
  if not public.is_staff() then
    raise exception 'set_drawer_reference_corners: staff or admin only' using errcode = '42501';
  end if;
  if p_corners is null or jsonb_typeof(p_corners) <> 'array'
     or jsonb_array_length(p_corners) <> 4 then
    raise exception 'Corners must be an array of four [x,y] pairs.' using errcode = '22000';
  end if;
  for i in 0..3 loop
    if jsonb_typeof(p_corners->i) <> 'array' or jsonb_array_length(p_corners->i) <> 2 then
      raise exception 'Corners must be an array of four [x,y] pairs.' using errcode = '22000';
    end if;
    v_x := (p_corners->i->>0)::numeric;
    v_y := (p_corners->i->>1)::numeric;
    if v_x < 0 or v_x > 1 or v_y < 0 or v_y > 1 then
      raise exception 'Corner coordinates must be normalized 0–1.' using errcode = '22000';
    end if;
  end loop;

  select * into d from public.drawer where id = p_drawer_id for update;
  if not found then
    raise exception 'Drawer not found.' using errcode = 'P0002';
  end if;

  update public.drawer
     set dimensions = (jsonb_set(
           coalesce(dimensions::jsonb, '{}'::jsonb),
           '{reference_corners}', p_corners, true))::json
   where id = p_drawer_id;

  return json_build_object('ok', true);
end;
$$;

-- Dashboard rollup: label status for every drawer the customer can see.
create or replace function public.get_my_label_status()
returns table (
  drawer_id uuid,
  stage_sort integer,
  has_dxf boolean,
  labels_submitted_at timestamptz,
  locked boolean
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
         public._labels_locked(d.stage, d.state)
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

-- ---------------------------------------------------------------------------
-- 5. Grants — authenticated only; internal helpers stay unexposed.
-- ---------------------------------------------------------------------------

revoke all on function public._customer_can_see_drawer(uuid)                        from public, anon, authenticated;
revoke all on function public._drawer_stage_sort(text)                              from public, anon, authenticated;
revoke all on function public._labels_locked(text, text)                            from public, anon, authenticated;
revoke all on function public._notify_labels_submitted(uuid, text, text)            from public, anon, authenticated;

revoke all on function public.get_drawer_labels(uuid)                               from public, anon;
revoke all on function public.save_drawer_labels(uuid, jsonb, integer, text)        from public, anon;
revoke all on function public.submit_drawer_labels(uuid, text, text, integer)       from public, anon;
revoke all on function public.set_drawer_reference_corners(uuid, jsonb)             from public, anon;
revoke all on function public.get_my_label_status()                                 from public, anon;

grant execute on function public.get_drawer_labels(uuid)                            to authenticated;
grant execute on function public.save_drawer_labels(uuid, jsonb, integer, text)     to authenticated;
grant execute on function public.submit_drawer_labels(uuid, text, text, integer)    to authenticated;
grant execute on function public.set_drawer_reference_corners(uuid, jsonb)          to authenticated;
grant execute on function public.get_my_label_status()                              to authenticated;
