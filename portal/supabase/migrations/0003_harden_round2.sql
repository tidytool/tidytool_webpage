-- Security hardening, round 2 (follow-ups from 0002 + advisors, 2026-07-03).
-- STAGED ONLY — do not apply to prod without Sam's sign-off.
--
-- Verified against prod before writing:
--   * is_admin() is referenced only by the "drawers select" / "drawers update"
--     policies, which apply to `authenticated` — so authenticated must KEEP
--     EXECUTE, and revoking from anon/public breaks nothing.
--   * All 60 drawers with an order_id have drawer.created_by = order.created_by,
--     so dropping the loose INSERT policy (step 2) matches all historical data.
--     ⚠ Behavioral tightening: after this, tidyCAM can only attach a drawer to
--     an order the SAME operator created. Confirm that's true of the tidyCAM
--     flow before applying.
--   * "drawer_update_authenticated" is inert: permissive policies OR together,
--     and "drawers update" (is_admin() OR owner) is strictly broader. Dropping
--     the narrow one changes nothing effective and keeps admin update ability.
--   * drawer-assets is a PUBLIC bucket: object downloads go through the public
--     URL and need no SELECT policy. "auth read drawer-assets" only enables any
--     signed-in user (now: any portal customer) to LIST the whole bucket.
--     The path-scoped "drawer_assets_select" remains for uuid-prefixed listing.

-- 1. is_admin(): remove anonymous execution (advisor: anon_security_definer_function_executable)
revoke execute on function public.is_admin() from anon;
revoke execute on function public.is_admin() from public;
grant execute on function public.is_admin() to authenticated;

-- 2. drawer INSERT: drop the loose duplicate; keep drawer_insert_authenticated
--    (owner + order-ownership check).
drop policy if exists "drawers insert" on public.drawer;

-- 3. drawer UPDATE: drop the inert narrow duplicate; keep "drawers update"
--    (is_admin() OR owner).
drop policy if exists "drawer_update_authenticated" on public.drawer;

-- 4. drawer-assets bucket: stop whole-bucket listing by any signed-in user.
drop policy if exists "auth read drawer-assets" on storage.objects;

-- ---------------------------------------------------------------------------
-- Post-apply verification:
--   * advisors: anon is_admin lint gone; public_bucket_allows_listing gone.
--   * as authenticated non-admin: can still SELECT/UPDATE own drawers,
--     cannot UPDATE others'; storage list of bucket root returns only
--     uuid-prefixed paths per drawer_assets_select.
--   * tidyCAM regression: scan → drawer insert with order attach still works.
--   * QR page + portal dashboard + approval flow unaffected (all RPC-based).
