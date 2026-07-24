-- DXF uploads to drawer-assets failed with "new row violates row-level
-- security policy" (403 in the desktop app): storage-api INSERTs the object
-- row WITH a RETURNING clause, and the only SELECT policies on this bucket
-- require object names matching '<uuid>/...'. DXF keys live under
-- 'dxf/<drawer_id>/...', so the freshly inserted row was invisible to the
-- inserting user and Postgres rejected the whole statement — every DXF
-- upload has failed since the 2026-07-03 storage-policy hardening.
--
-- The bucket is already public for reads (public URL downloads bypass RLS),
-- so a bucket-wide authenticated SELECT policy adds no new exposure. It also
-- unblocks upsert re-uploads (ON CONFLICT must read the existing row).
create policy "auth read drawer-assets"
on storage.objects for select
to authenticated
using (bucket_id = 'drawer-assets');
