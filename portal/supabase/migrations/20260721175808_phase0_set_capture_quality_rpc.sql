-- Phase 0 write-path: single clean call for the portal/app to tag a scan.
-- SECURITY INVOKER => caller's existing drawer UPDATE RLS applies (no escalation);
-- stamps provenance so tagged_at/tagged_by can't be forgotten.
create or replace function public.set_capture_quality(
  p_drawer_id uuid,
  p_quality   public.capture_quality,
  p_note      text default null
) returns public.drawer
language sql
security invoker
set search_path = public
as $$
  update public.drawer
     set capture_quality          = p_quality,
         capture_quality_tagged_at = now(),
         capture_quality_tagged_by = auth.uid(),
         capture_quality_note      = p_note
   where id = p_drawer_id
  returning *;
$$;

revoke execute on function public.set_capture_quality(uuid, public.capture_quality, text) from anon;
grant  execute on function public.set_capture_quality(uuid, public.capture_quality, text) to authenticated;

comment on function public.set_capture_quality(uuid, public.capture_quality, text) is
  'Phase 0 (guided-capture plan §0): staff tag a drawer scan''s capture-quality outcome, auto-stamping tagged_at/tagged_by. SECURITY INVOKER — caller''s drawer UPDATE RLS applies (no privilege escalation).';
