-- Allow admins to edit any order's details while ownership stays with the
-- creator. Previously order UPDATE was owner-only, so an admin editing
-- another account's order was silently ignored by RLS (0 rows matched).
-- Ownership itself is protected client-side (tidyCAM never writes
-- created_by on UPDATE) and could later be hardened with a trigger if
-- non-tidyCAM writers appear.
--
-- Applied to dev (gfkrebuioszsxanjdnsx) and prod (tkrrvpoupekrjqditupi)
-- on 2026-08-12.

drop policy if exists order_update_authenticated on public."order";
create policy order_update_authenticated on public."order"
  for update to authenticated
  using (is_admin() or created_by = auth.uid())
  with check (is_admin() or created_by = auth.uid());
