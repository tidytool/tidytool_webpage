-- Staff-callable box management (unblocks the tidyCAM "add box" workflow).
--
-- The box-management RPCs were is_admin()-gated. tidyCAM's scan operators are
-- `staff` (not admin), so they couldn't create/assign boxes at scan time. Relax
-- the guard to is_staff() (which is staff OR admin), so:
--   * the portal admin UI is UNAFFECTED (admins satisfy is_staff), and
--   * tidyCAM staff operators can call the SAME RPCs to write boxes.
-- Signatures are unchanged (plain CREATE OR REPLACE — no overloads, grants kept).
-- Box writes stay RPC-only (no RLS write policy); this just widens who may call.

create or replace function public.admin_create_box(p_order_id uuid, p_label text, p_quantity int default 1)
returns uuid language plpgsql security definer set search_path to 'public' as $$
declare v_box public.box%rowtype;
begin
  if not public.is_staff() then raise exception 'Staff or admins only.' using errcode = '42501'; end if;
  if btrim(coalesce(p_label, '')) = '' then raise exception 'A box label is required.' using errcode = '22000'; end if;
  if coalesce(p_quantity, 1) < 1 then raise exception 'Box quantity must be >= 1.' using errcode = '22000'; end if;
  if not exists (select 1 from public."order" o where o.id = p_order_id) then raise exception 'Order not found.' using errcode = 'P0002'; end if;
  insert into public.box (order_id, label, quantity) values (p_order_id, btrim(p_label), coalesce(p_quantity, 1)) returning * into v_box;
  perform public._admin_audit('create_box', 'box', v_box.id, null, to_jsonb(v_box));
  return v_box.id;
end; $$;

create or replace function public.admin_update_box(p_box_id uuid, p_label text default null, p_quantity int default null)
returns void language plpgsql security definer set search_path to 'public' as $$
declare v_before public.box%rowtype; v_after public.box%rowtype;
begin
  if not public.is_staff() then raise exception 'Staff or admins only.' using errcode = '42501'; end if;
  select * into v_before from public.box where id = p_box_id for update;
  if not found then raise exception 'Box not found.' using errcode = 'P0002'; end if;
  if p_label is not null and btrim(p_label) = '' then raise exception 'A box label is required.' using errcode = '22000'; end if;
  if p_quantity is not null and p_quantity < 1 then raise exception 'Box quantity must be >= 1.' using errcode = '22000'; end if;
  update public.box set label = coalesce(nullif(btrim(coalesce(p_label, '')), ''), label), quantity = coalesce(p_quantity, quantity)
   where id = p_box_id returning * into v_after;
  perform public._admin_audit('update_box', 'box', p_box_id, to_jsonb(v_before), to_jsonb(v_after));
end; $$;

create or replace function public.admin_delete_box(p_box_id uuid)
returns void language plpgsql security definer set search_path to 'public' as $$
declare v_before public.box%rowtype; v_reparented int;
begin
  if not public.is_staff() then raise exception 'Staff or admins only.' using errcode = '42501'; end if;
  select * into v_before from public.box where id = p_box_id for update;
  if not found then raise exception 'Box not found.' using errcode = 'P0002'; end if;
  update public.drawer set box_id = null where box_id = p_box_id;
  get diagnostics v_reparented = row_count;
  delete from public.box where id = p_box_id;
  perform public._admin_audit('delete_box', 'box', p_box_id, to_jsonb(v_before), jsonb_build_object('drawers_reparented_to_trays', v_reparented));
end; $$;

create or replace function public.assign_drawer_to_box(p_drawer_id uuid, p_box_id uuid)
returns void language plpgsql security definer set search_path to 'public' as $$
declare v_drawer public.drawer%rowtype; v_box public.box%rowtype; v_before jsonb;
begin
  if not public.is_staff() then raise exception 'Staff or admins only.' using errcode = '42501'; end if;
  select * into v_drawer from public.drawer where id = p_drawer_id for update;
  if not found then raise exception 'Drawer not found.' using errcode = 'P0002'; end if;
  if p_box_id is not null then
    select * into v_box from public.box where id = p_box_id;
    if not found then raise exception 'Box not found.' using errcode = 'P0002'; end if;
    if v_drawer.order_id is distinct from v_box.order_id then raise exception 'Drawer and box belong to different orders.' using errcode = '22000'; end if;
  end if;
  v_before := jsonb_build_object('drawer_id', p_drawer_id, 'box_id', v_drawer.box_id);
  update public.drawer set box_id = p_box_id where id = p_drawer_id;
  perform public._admin_audit('assign_drawer_to_box', 'drawer', p_drawer_id, v_before, jsonb_build_object('drawer_id', p_drawer_id, 'box_id', p_box_id));
end; $$;

create or replace function public.admin_set_drawer_quantity(p_drawer_id uuid, p_quantity int)
returns void language plpgsql security definer set search_path to 'public' as $$
declare v_before int;
begin
  if not public.is_staff() then raise exception 'Staff or admins only.' using errcode = '42501'; end if;
  if p_quantity is null or p_quantity < 1 then raise exception 'Drawer quantity must be >= 1.' using errcode = '22000'; end if;
  select quantity into v_before from public.drawer where id = p_drawer_id for update;
  if not found then raise exception 'Drawer not found.' using errcode = 'P0002'; end if;
  update public.drawer set quantity = p_quantity where id = p_drawer_id;
  perform public._admin_audit('set_drawer_quantity', 'drawer', p_drawer_id, jsonb_build_object('drawer_id', p_drawer_id, 'quantity', v_before), jsonb_build_object('drawer_id', p_drawer_id, 'quantity', p_quantity));
end; $$;

-- Grants are preserved by CREATE OR REPLACE, but re-assert for clarity.
revoke all on function public.admin_create_box(uuid, text, int)        from public, anon;
revoke all on function public.admin_update_box(uuid, text, int)        from public, anon;
revoke all on function public.admin_delete_box(uuid)                   from public, anon;
revoke all on function public.assign_drawer_to_box(uuid, uuid)         from public, anon;
revoke all on function public.admin_set_drawer_quantity(uuid, int)     from public, anon;
grant execute on function public.admin_create_box(uuid, text, int)     to authenticated, service_role;
grant execute on function public.admin_update_box(uuid, text, int)     to authenticated, service_role;
grant execute on function public.admin_delete_box(uuid)                to authenticated, service_role;
grant execute on function public.assign_drawer_to_box(uuid, uuid)      to authenticated, service_role;
grant execute on function public.admin_set_drawer_quantity(uuid, int)  to authenticated, service_role;
