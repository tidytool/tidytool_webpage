-- What: get_public_drawer_changelog(p_drawer_id) — anon-callable, link-gated read of a
--   drawer's design-approval history, filtered to the customer-facing event types only
--   ('design_uploaded','design_revised','approved','changes_requested').
-- Why: 20260720220850 made get_drawer_changelog staff-or-owner and anon lost EXECUTE,
--   which silently killed the History section on docs/approve/ (the page calls the RPC
--   with the anon key and hides the section on any failure). The approve page's auth
--   model is the unguessable drawer UUID (capability link), the same model as
--   get_drawer_approval. This restores the feature WITHOUT re-granting the internal
--   changelog: scan_corrected / scan_correction_reverted events (20260714040206) carry
--   staff notes and payloads and stay reachable only via the guarded get_drawer_changelog.
-- Rollback: drop function public.get_public_drawer_changelog(uuid);
-- Verification:
--   select has_function_privilege('anon',
--          'public.get_public_drawer_changelog(uuid)', 'execute');  -- expect t
--   set local role anon; select * from public.get_public_drawer_changelog('<drawer id>');
--   -- expect rows; event_type only ever one of the four customer-facing types

create or replace function public.get_public_drawer_changelog(p_drawer_id uuid)
returns table (
  event_type text, revision int, actor_name text, actor_role text,
  note text, preview_url text, created_at timestamptz
)
language sql
security definer
stable
set search_path = public
as $$
  select e.event_type, e.revision, e.actor_name, e.actor_role,
         e.note, e.preview_url, e.created_at
  from public.drawer_event e
  where e.drawer_id = p_drawer_id
    and e.event_type in ('design_uploaded','design_revised','approved','changes_requested')
  order by e.created_at desc, e.id desc;
$$;

revoke all on function public.get_public_drawer_changelog(uuid) from public;
grant execute on function public.get_public_drawer_changelog(uuid) to anon, authenticated;
