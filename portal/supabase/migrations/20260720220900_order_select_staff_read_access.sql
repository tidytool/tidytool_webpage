-- Task 5.1: staff/admin can read all orders (View All Scans).
-- Folded into the existing SELECT policy as one OR'd condition, using the
-- (select auth.uid()) form to avoid the per-row initplan lint.
drop policy if exists "order_select_authenticated" on public."order";
create policy "order_select_authenticated" on public."order"
  for select to authenticated
  using ((select auth.uid()) = created_by or is_staff());
