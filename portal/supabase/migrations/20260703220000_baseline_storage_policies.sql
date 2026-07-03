-- Baseline the pre-existing storage.objects policies into migrations.
--
-- WHAT: recreates the 8 hand-created storage policies (drawer-assets + lidar_scans)
--   exactly as they exist on prod (dumped from pg_policies 2026-07-03).
-- WHY: the 20260628062931 baseline captured only the `public` schema, so fresh
--   Supabase branches come up WITHOUT these policies and are not faithful copies.
--   Applying this to prod is a no-op behavior-wise (drop-and-recreate of identical
--   policies) but records them in the migration history so branches replay them.
-- ROLLBACK: drop the 8 policies by name (they exist on prod regardless of this
--   migration; rolling back only removes them from branch replays, not prod).
-- VERIFY (both prod and branch):
--   select policyname, cmd, roles, qual, with_check from pg_policies
--   where schemaname='storage' order by policyname;  -- 8 rows, identical
--
-- NOTE (known debt, BACKEND-analysis §4.2): the broad "auth upload/update
-- drawer-assets" policies overlap the tighter drawer_assets_* ones. This migration
-- deliberately preserves the redundancy — it is a baseline, not a cleanup. Tightening
-- is a separate, gated change (it can affect tidyCAM uploads).

-- drawer-assets: broad (legacy) policies
drop policy if exists "auth upload drawer-assets" on storage.objects;
create policy "auth upload drawer-assets" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'drawer-assets'::text);

drop policy if exists "auth update drawer-assets" on storage.objects;
create policy "auth update drawer-assets" on storage.objects
  for update to authenticated
  using (bucket_id = 'drawer-assets'::text)
  with check (bucket_id = 'drawer-assets'::text);

-- drawer-assets: path-and-owner-scoped policies
drop policy if exists "drawer_assets_insert" on storage.objects;
create policy "drawer_assets_insert" on storage.objects
  for insert to authenticated
  with check ((bucket_id = 'drawer-assets'::text) and (auth.uid() = owner)
    and (name ~ '^[0-9a-f-]{8}-[0-9a-f-]{4}-[0-9a-f-]{4}-[0-9a-f-]{4}-[0-9a-f-]{12}/.*'::text));

drop policy if exists "drawer_assets_select" on storage.objects;
create policy "drawer_assets_select" on storage.objects
  for select to authenticated
  using ((bucket_id = 'drawer-assets'::text)
    and (name ~ '^[0-9a-f-]{8}-[0-9a-f-]{4}-[0-9a-f-]{4}-[0-9a-f-]{4}-[0-9a-f-]{12}/.*'::text));

drop policy if exists "drawer_assets_update" on storage.objects;
create policy "drawer_assets_update" on storage.objects
  for update to authenticated
  using ((bucket_id = 'drawer-assets'::text) and (auth.uid() = owner)
    and (name ~ '^[0-9a-f-]{8}-[0-9a-f-]{4}-[0-9a-f-]{4}-[0-9a-f-]{4}-[0-9a-f-]{12}/.*'::text))
  with check ((bucket_id = 'drawer-assets'::text) and (auth.uid() = owner)
    and (name ~ '^[0-9a-f-]{8}-[0-9a-f-]{4}-[0-9a-f-]{4}-[0-9a-f-]{4}-[0-9a-f-]{12}/.*'::text));

-- lidar_scans
drop policy if exists "Allow authenticated reads from lidar_scans" on storage.objects;
create policy "Allow authenticated reads from lidar_scans" on storage.objects
  for select to authenticated
  using ((bucket_id = 'lidar_scans'::text) and (owner = auth.uid())
    and (name ~ '^[^/]+/orders/[^/]+/model_[^/]+$'::text));

drop policy if exists "Allow authenticated uploads to lidar_scans" on storage.objects;
create policy "Allow authenticated uploads to lidar_scans" on storage.objects
  for insert to authenticated
  with check ((bucket_id = 'lidar_scans'::text) and (owner = auth.uid())
    and (name ~ '^[^/]+/orders/[^/]+/model_[^/]+$'::text));

drop policy if exists "lidar_scans_update" on storage.objects;
create policy "lidar_scans_update" on storage.objects
  for update to authenticated
  using ((bucket_id = 'lidar_scans'::text) and (owner = auth.uid())
    and (name ~ '^[^/]+/orders/[^/]+/model_[^/]+$'::text))
  with check ((bucket_id = 'lidar_scans'::text) and (owner = auth.uid())
    and (name ~ '^[^/]+/orders/[^/]+/model_[^/]+$'::text));
