-- Task 4: add is_staff() guards to SECURITY DEFINER functions callable by
-- `authenticated` that could mutate or read any drawer without authorization.
-- (record_dxf_upload / record_scan_correction / revert_scan_correction are
-- staff-tool endpoints; get_drawer_changelog becomes staff-or-owner.)

CREATE OR REPLACE FUNCTION public.record_dxf_upload(p_drawer_id uuid, p_dxf_url text, p_built_from_revision integer DEFAULT NULL::integer, p_status text DEFAULT 'processed_by_tidydesk'::text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  d public.drawer;
  v_status public.drawer_status;
begin
  if not public.is_staff() then
    raise exception 'record_dxf_upload: staff or admin only' using errcode = '42501';
  end if;
  if p_dxf_url is null or btrim(p_dxf_url) = '' then
    raise exception 'dxf_url is required.';
  end if;
  begin
    v_status := p_status::public.drawer_status;
  exception when invalid_text_representation then
    raise exception 'Invalid drawer status %', p_status;
  end;

  select * into d from public.drawer where id = p_drawer_id for update;
  if not found then
    raise exception 'Drawer not found.' using errcode = 'P0002';
  end if;

  -- p_built_from_revision null -> stamp null (reads as stale, the safe
  -- default for a DXF whose source revision is unknown, e.g. local loads).
  update public.drawer
     set dxf_url      = p_dxf_url,
         dxf_revision = p_built_from_revision,
         status       = v_status
   where id = p_drawer_id;

  return json_build_object(
    'ok', true,
    'current_revision', coalesce(d.current_revision, 0),
    'dxf_stale', p_built_from_revision is null
                 or p_built_from_revision < coalesce(d.current_revision, 0));
end;
$function$;

CREATE OR REPLACE FUNCTION public.record_scan_correction(p_drawer_id uuid, p_calibration_matrix jsonb, p_corrected_dimensions jsonb DEFAULT NULL::jsonb, p_correction_meta jsonb DEFAULT NULL::jsonb, p_note text DEFAULT NULL::text, p_actor text DEFAULT NULL::text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  d public.drawer;
  v_rev int;
  v_dims jsonb;
  v_prior jsonb;
  v_new jsonb;
begin
  if not public.is_staff() then
    raise exception 'record_scan_correction: staff or admin only' using errcode = '42501';
  end if;
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

CREATE OR REPLACE FUNCTION public.revert_scan_correction(p_drawer_id uuid, p_note text DEFAULT NULL::text, p_actor text DEFAULT NULL::text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  d public.drawer;
  e public.drawer_event;
  v_last_type text;
  v_rev int;
  v_dims jsonb;
  v_prior jsonb;
begin
  if not public.is_staff() then
    raise exception 'revert_scan_correction: staff or admin only' using errcode = '42501';
  end if;
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

CREATE OR REPLACE FUNCTION public.get_drawer_changelog(p_drawer_id uuid)
 RETURNS TABLE(event_type text, revision integer, actor_name text, actor_role text, note text, preview_url text, created_at timestamp with time zone)
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select e.event_type, e.revision, e.actor_name, e.actor_role, e.note, e.preview_url, e.created_at
  from public.drawer_event e
  where e.drawer_id = p_drawer_id
    and (
      public.is_staff()
      or exists (
        select 1 from public.drawer d
        where d.id = p_drawer_id
          and d.created_by = (select auth.uid())
      )
    )
  order by e.created_at desc, e.id desc;
$function$;
