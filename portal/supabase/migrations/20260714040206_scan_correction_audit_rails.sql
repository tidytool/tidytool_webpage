-- Scan Correction sprint (Brief 1, 2026-07-13).
-- Additive-only: new event types, event payload, artifact revision stamps,
-- and SECURITY DEFINER RPCs for non-destructive calibration corrections.
-- Contract: docs/scan-correction-contract.md in the tidyCAD repo.

-- 1) New audit event types for calibration corrections.
alter table public.drawer_event
  drop constraint drawer_event_event_type_check;
alter table public.drawer_event
  add constraint drawer_event_event_type_check
  check (event_type = any (array[
    'design_uploaded'::text,
    'design_revised'::text,
    'approved'::text,
    'changes_requested'::text,
    'delivered'::text,
    'scan_corrected'::text,
    'scan_correction_reverted'::text
  ]));

-- 2) Structured audit payload (prior/new calibration state). Nullable and
--    unused by existing event types, so existing writers/readers are unaffected.
alter table public.drawer_event
  add column if not exists payload jsonb;
comment on column public.drawer_event.payload is
  'Structured event data. For scan_corrected: {prior:{revision,calibration_matrix,width,height,correction}, new:{...}, meta:{corner_points,...}}. For scan_correction_reverted: {reverted_event, restored:{...}}.';

-- 3) Artifact staleness stamps. An artifact is STALE iff its URL is set and
--    its revision column is null or < current_revision. Backfill existing
--    artifacts as fresh (no corrections exist before this migration).
alter table public.drawer
  add column if not exists dxf_revision integer,
  add column if not exists design_preview_revision integer;
comment on column public.drawer.dxf_revision is
  'current_revision at the time dxf_url was generated. Stale iff dxf_url is not null and (dxf_revision is null or dxf_revision < current_revision).';
comment on column public.drawer.design_preview_revision is
  'current_revision at the time design_preview_url was generated. Stale iff design_preview_url is not null and (design_preview_revision is null or design_preview_revision < current_revision).';

update public.drawer set dxf_revision = coalesce(current_revision, 0)
  where dxf_url is not null and dxf_revision is null;
update public.drawer set design_preview_revision = coalesce(current_revision, 0)
  where design_preview_url is not null and design_preview_revision is null;

-- 4) Correction save RPC: merges new calibration into dimensions (never
--    touching photo/point-cloud assets), bumps current_revision, writes the
--    append-only audit event with prior + new state.
create or replace function public.record_scan_correction(
  p_drawer_id uuid,
  p_calibration_matrix jsonb,
  p_corrected_dimensions jsonb default null,  -- optional {width, height} in the record's stored unit
  p_correction_meta jsonb default null,       -- corner_points, orientation, derived dims, thresholds hit
  p_note text default null,
  p_actor text default null
) returns json
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  d public.drawer;
  v_rev int;
  v_dims jsonb;
  v_prior jsonb;
  v_new jsonb;
begin
  select * into d from public.drawer where id = p_drawer_id for update;
  if not found then
    raise exception 'Drawer not found.' using errcode = 'P0002';
  end if;

  if p_calibration_matrix is null
     or jsonb_typeof(p_calibration_matrix) <> 'array'
     or jsonb_array_length(p_calibration_matrix) <> 16 then
    raise exception 'calibration_matrix must be a 16-element (4x4 row-major) array.';
  end if;

  v_rev  := coalesce(d.current_revision, 0) + 1;
  v_dims := coalesce(d.dimensions::jsonb, '{}'::jsonb);

  v_prior := jsonb_build_object(
    'revision',           coalesce(d.current_revision, 0),
    'calibration_matrix', v_dims->'calibration_matrix',
    'width',              v_dims->'width',
    'height',             v_dims->'height',
    'correction',         v_dims->'correction');

  v_dims := v_dims || jsonb_build_object('calibration_matrix', p_calibration_matrix);
  if p_corrected_dimensions is not null and p_corrected_dimensions ? 'width' then
    v_dims := v_dims || jsonb_build_object('width', p_corrected_dimensions->'width');
  end if;
  if p_corrected_dimensions is not null and p_corrected_dimensions ? 'height' then
    v_dims := v_dims || jsonb_build_object('height', p_corrected_dimensions->'height');
  end if;
  v_dims := v_dims || jsonb_build_object('correction',
    coalesce(p_correction_meta, '{}'::jsonb) || jsonb_build_object(
      'revision',     v_rev,
      'corrected_at', now(),
      'corrected_by', coalesce(nullif(btrim(coalesce(p_actor,'')),''), 'TidyCAD')));

  v_new := jsonb_build_object(
    'revision',           v_rev,
    'calibration_matrix', p_calibration_matrix,
    'width',              v_dims->'width',
    'height',             v_dims->'height');

  update public.drawer
     set dimensions       = v_dims::json,
         current_revision = v_rev
   where id = p_drawer_id;

  insert into public.drawer_event
    (drawer_id, revision, event_type, actor_name, actor_role, note, payload)
  values
    (p_drawer_id, v_rev, 'scan_corrected',
     coalesce(nullif(btrim(coalesce(p_actor,'')),''), 'TidyCAD'), 'staff',
     nullif(btrim(coalesce(p_note,'')),''),
     jsonb_build_object('prior', v_prior, 'new', v_new, 'meta', p_correction_meta));

  return json_build_object(
    'ok', true,
    'revision', v_rev,
    'dxf_stale', d.dxf_url is not null,
    'preview_stale', d.design_preview_url is not null);
end;
$function$;

-- 5) One-click revert: restores the prior calibration state from the audit
--    trail as a NEW revision (append-only; nothing is overwritten silently).
create or replace function public.revert_scan_correction(
  p_drawer_id uuid,
  p_note text default null,
  p_actor text default null
) returns json
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  d public.drawer;
  e public.drawer_event;
  v_last_type text;
  v_rev int;
  v_dims jsonb;
  v_prior jsonb;
begin
  select * into d from public.drawer where id = p_drawer_id for update;
  if not found then
    raise exception 'Drawer not found.' using errcode = 'P0002';
  end if;

  select event_type into v_last_type
    from public.drawer_event
   where drawer_id = p_drawer_id
     and event_type in ('scan_corrected','scan_correction_reverted')
   order by created_at desc, id desc
   limit 1;
  if v_last_type is null then
    raise exception 'No scan correction to revert.' using errcode = 'P0002';
  end if;
  if v_last_type = 'scan_correction_reverted' then
    raise exception 'Latest scan correction was already reverted.' using errcode = '55000';
  end if;

  select * into e
    from public.drawer_event
   where drawer_id = p_drawer_id and event_type = 'scan_corrected'
   order by created_at desc, id desc
   limit 1;

  v_prior := e.payload->'prior';
  if v_prior is null then
    raise exception 'Correction event has no recorded prior state; cannot revert.';
  end if;

  v_rev  := coalesce(d.current_revision, 0) + 1;
  v_dims := coalesce(d.dimensions::jsonb, '{}'::jsonb);

  if jsonb_typeof(coalesce(v_prior->'calibration_matrix', 'null'::jsonb)) = 'null' then
    v_dims := v_dims - 'calibration_matrix';
  else
    v_dims := v_dims || jsonb_build_object('calibration_matrix', v_prior->'calibration_matrix');
  end if;
  if v_prior ? 'width'  and jsonb_typeof(v_prior->'width')  <> 'null' then
    v_dims := v_dims || jsonb_build_object('width',  v_prior->'width');
  end if;
  if v_prior ? 'height' and jsonb_typeof(v_prior->'height') <> 'null' then
    v_dims := v_dims || jsonb_build_object('height', v_prior->'height');
  end if;
  if jsonb_typeof(coalesce(v_prior->'correction', 'null'::jsonb)) = 'null' then
    v_dims := v_dims - 'correction';
  else
    v_dims := v_dims || jsonb_build_object('correction', v_prior->'correction');
  end if;

  update public.drawer
     set dimensions       = v_dims::json,
         current_revision = v_rev
   where id = p_drawer_id;

  insert into public.drawer_event
    (drawer_id, revision, event_type, actor_name, actor_role, note, payload)
  values
    (p_drawer_id, v_rev, 'scan_correction_reverted',
     coalesce(nullif(btrim(coalesce(p_actor,'')),''), 'TidyCAD'), 'staff',
     nullif(btrim(coalesce(p_note,'')),''),
     jsonb_build_object('reverted_event', e.id, 'restored', v_prior));

  return json_build_object('ok', true, 'revision', v_rev);
end;
$function$;

-- 6) Stamp artifact revisions on the existing design-upload path so newly
--    generated artifacts are recorded as fresh.
create or replace function public.log_design_revision(p_drawer_id uuid, p_preview_url text, p_dxf_url text default null::text, p_note text default null::text)
 returns json
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  d public.drawer;
  v_rev int;
  v_type text;
begin
  select * into d from public.drawer where id = p_drawer_id for update;
  if not found then
    raise exception 'Drawer not found.' using errcode = 'P0002';
  end if;

  v_rev  := coalesce(d.current_revision, 0) + 1;
  v_type := case when coalesce(d.current_revision,0) = 0 then 'design_uploaded' else 'design_revised' end;

  update public.drawer
     set current_revision        = v_rev,
         design_preview_url       = coalesce(p_preview_url, design_preview_url),
         design_preview_revision  = case when p_preview_url is not null then v_rev else design_preview_revision end,
         dxf_url                  = coalesce(p_dxf_url, dxf_url),
         dxf_revision             = case when p_dxf_url is not null then v_rev else dxf_revision end,
         customer_approval_status = 'pending',
         approved_by = null, approved_at = null, approval_note = null
   where id = p_drawer_id;

  insert into public.drawer_event
    (drawer_id, revision, event_type, actor_name, actor_role, note, preview_url, dxf_url)
  values
    (p_drawer_id, v_rev, v_type, 'TidyTool', 'staff',
     nullif(btrim(coalesce(p_note,'')),''), p_preview_url, coalesce(p_dxf_url, d.dxf_url));

  -- tell the customer their design is ready to review (best-effort)
  begin
    perform public._notify_customer_email(
      p_drawer_id, 'design_ready', nullif(btrim(coalesce(p_note,'')),''), v_rev);
  exception when others then
    null;
  end;

  return json_build_object('ok', true, 'revision', v_rev, 'event', v_type);
end;
$function$;

-- Lock down the new RPCs like the rest of the RPC surface.
revoke all on function public.record_scan_correction(uuid, jsonb, jsonb, jsonb, text, text) from public;
grant execute on function public.record_scan_correction(uuid, jsonb, jsonb, jsonb, text, text) to authenticated, service_role;
revoke all on function public.revert_scan_correction(uuid, text, text) from public;
grant execute on function public.revert_scan_correction(uuid, text, text) to authenticated, service_role;