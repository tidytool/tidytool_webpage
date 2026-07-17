-- Scan Correction follow-up (2026-07-14): atomic server-side DXF stamping.
-- Replaces tidyCAD's client-side two-step (update dxf_url + dxf_revision):
-- one SECURITY DEFINER statement writes url, status, and revision stamp
-- together, so the client needs no direct UPDATE on revision columns and no
-- read-then-write window exists. Contract: docs/scan-correction-contract.md.

create or replace function public.record_dxf_upload(
  p_drawer_id uuid,
  p_dxf_url text,
  p_built_from_revision integer default null,  -- revision the DXF was generated from (image-load time)
  p_status text default 'processed_by_tidydesk'
) returns json
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  d public.drawer;
  v_status public.drawer_status;
begin
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

revoke all on function public.record_dxf_upload(uuid, text, integer, text) from public;
grant execute on function public.record_dxf_upload(uuid, text, integer, text) to authenticated, service_role;