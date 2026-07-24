-- Boxes & drawer quantities (Stage 1 of the boxes plan) — ADDITIVE schema.
--
-- Model: Order > Box > Drawer, and Order > Drawer (tray). A Box is a container of
-- drawers that duplicates as a unit (e.g. "2 blue boxes"). A tray is a drawer that
-- hangs directly off the order (box_id NULL). Copies = quantity model: copies share
-- ONE design record (one drawer row, one QR); the physical count is
--   coalesce(box.quantity,1) * drawer.quantity.
--
-- Backward-compatible: every existing drawer becomes a tray (box_id NULL, quantity 1),
-- so tidyCAM keeps writing drawers unchanged. order.drawer_count / order.drawer_ids are
-- UNTOUCHED and keep meaning "design rows" — physical-copy math lives only in the quote.
--
-- ⚠ HIGH-RISK per CLAUDE.md: production schema change. Sam reviews before apply.
-- Depends on existing prod objects: public."order", public.drawer, is_admin(), is_staff(),
-- _admin_audit(text,text,uuid,jsonb,jsonb), get_admin_order_detail (replaced below).

-- ---------------------------------------------------------------------------
-- 1. box
-- ---------------------------------------------------------------------------
create table public.box (
  id         uuid primary key default gen_random_uuid(),
  order_id   uuid not null references public."order"(id) on delete cascade,
  label      text not null,
  quantity   int  not null default 1 check (quantity > 0),
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid()
);
comment on table public.box is
  'A container of drawers within an order that duplicates as a unit (quantity = physical copies). Drawers with box_id NULL are standalone trays. Portal-only concept; tidyCAM is unaware.';
comment on column public.box.quantity is
  'Physical copies of this whole box. Foam is priced per physical drawer = box.quantity * drawer.quantity; scanning/design is charged once regardless.';

create index box_order_id_idx on public.box (order_id);

alter table public.box enable row level security;
create policy box_select_staff on public.box
  for select to authenticated using (public.is_staff());
-- Writes go exclusively through the SECURITY DEFINER RPCs below (no write policies).

-- ---------------------------------------------------------------------------
-- 2. drawer: additive columns (nullable box_id = tray; quantity default 1)
-- ---------------------------------------------------------------------------
alter table public.drawer
  add column box_id   uuid references public.box(id) on delete set null,
  add column quantity int not null default 1 check (quantity > 0);
comment on column public.drawer.box_id is
  'Parent box, or NULL for a standalone tray on the order. Deleting the box sets this back to NULL (drawer becomes a tray).';
comment on column public.drawer.quantity is
  'Copies of THIS drawer within its parent. Physical count = coalesce(box.quantity,1) * drawer.quantity. Default 1 = one physical drawer (today''s behaviour).';

create index drawer_box_id_idx on public.drawer (box_id);

-- ---------------------------------------------------------------------------
-- 3. Box-management RPCs (admin-guarded, audited). Same posture as admin CRM.
-- ---------------------------------------------------------------------------

create or replace function public.admin_create_box(
  p_order_id uuid,
  p_label    text,
  p_quantity int default 1
)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_box public.box%rowtype;
begin
  if not public.is_admin() then
    raise exception 'Admins only.' using errcode = '42501';
  end if;
  if btrim(coalesce(p_label, '')) = '' then
    raise exception 'A box label is required.' using errcode = '22000';
  end if;
  if coalesce(p_quantity, 1) < 1 then
    raise exception 'Box quantity must be >= 1.' using errcode = '22000';
  end if;
  if not exists (select 1 from public."order" o where o.id = p_order_id) then
    raise exception 'Order not found.' using errcode = 'P0002';
  end if;

  insert into public.box (order_id, label, quantity)
  values (p_order_id, btrim(p_label), coalesce(p_quantity, 1))
  returning * into v_box;

  perform public._admin_audit('create_box', 'box', v_box.id, null, to_jsonb(v_box));
  return v_box.id;
end;
$$;
revoke all on function public.admin_create_box(uuid, text, int) from public, anon;
grant execute on function public.admin_create_box(uuid, text, int) to authenticated, service_role;

create or replace function public.admin_update_box(
  p_box_id   uuid,
  p_label    text default null,
  p_quantity int  default null
)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_before public.box%rowtype;
  v_after  public.box%rowtype;
begin
  if not public.is_admin() then
    raise exception 'Admins only.' using errcode = '42501';
  end if;
  select * into v_before from public.box where id = p_box_id for update;
  if not found then
    raise exception 'Box not found.' using errcode = 'P0002';
  end if;
  if p_label is not null and btrim(p_label) = '' then
    raise exception 'A box label is required.' using errcode = '22000';
  end if;
  if p_quantity is not null and p_quantity < 1 then
    raise exception 'Box quantity must be >= 1.' using errcode = '22000';
  end if;

  update public.box
     set label    = coalesce(nullif(btrim(coalesce(p_label, '')), ''), label),
         quantity = coalesce(p_quantity, quantity)
   where id = p_box_id
   returning * into v_after;

  perform public._admin_audit('update_box', 'box', p_box_id, to_jsonb(v_before), to_jsonb(v_after));
end;
$$;
revoke all on function public.admin_update_box(uuid, text, int) from public, anon;
grant execute on function public.admin_update_box(uuid, text, int) to authenticated, service_role;

create or replace function public.admin_delete_box(p_box_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_before public.box%rowtype;
  v_reparented int;
begin
  if not public.is_admin() then
    raise exception 'Admins only.' using errcode = '42501';
  end if;
  select * into v_before from public.box where id = p_box_id for update;
  if not found then
    raise exception 'Box not found.' using errcode = 'P0002';
  end if;

  -- Drawers become trays (the FK is ON DELETE SET NULL, but do it explicitly so
  -- the count is knowable and the intent is clear).
  update public.drawer set box_id = null where box_id = p_box_id;
  get diagnostics v_reparented = row_count;

  delete from public.box where id = p_box_id;

  perform public._admin_audit('delete_box', 'box', p_box_id,
    to_jsonb(v_before),
    jsonb_build_object('drawers_reparented_to_trays', v_reparented));
end;
$$;
revoke all on function public.admin_delete_box(uuid) from public, anon;
grant execute on function public.admin_delete_box(uuid) to authenticated, service_role;

-- Assign a drawer to a box (same order enforced), or NULL to make it a tray.
create or replace function public.assign_drawer_to_box(
  p_drawer_id uuid,
  p_box_id    uuid
)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_drawer public.drawer%rowtype;
  v_box    public.box%rowtype;
  v_before jsonb;
begin
  if not public.is_admin() then
    raise exception 'Admins only.' using errcode = '42501';
  end if;
  select * into v_drawer from public.drawer where id = p_drawer_id for update;
  if not found then
    raise exception 'Drawer not found.' using errcode = 'P0002';
  end if;

  if p_box_id is not null then
    select * into v_box from public.box where id = p_box_id;
    if not found then
      raise exception 'Box not found.' using errcode = 'P0002';
    end if;
    -- A drawer can only join a box on its OWN order.
    if v_drawer.order_id is distinct from v_box.order_id then
      raise exception 'Drawer and box belong to different orders.' using errcode = '22000';
    end if;
  end if;

  v_before := jsonb_build_object('drawer_id', p_drawer_id, 'box_id', v_drawer.box_id);
  update public.drawer set box_id = p_box_id where id = p_drawer_id;

  perform public._admin_audit('assign_drawer_to_box', 'drawer', p_drawer_id,
    v_before, jsonb_build_object('drawer_id', p_drawer_id, 'box_id', p_box_id));
end;
$$;
revoke all on function public.assign_drawer_to_box(uuid, uuid) from public, anon;
grant execute on function public.assign_drawer_to_box(uuid, uuid) to authenticated, service_role;

create or replace function public.admin_set_drawer_quantity(
  p_drawer_id uuid,
  p_quantity  int
)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_before int;
begin
  if not public.is_admin() then
    raise exception 'Admins only.' using errcode = '42501';
  end if;
  if p_quantity is null or p_quantity < 1 then
    raise exception 'Drawer quantity must be >= 1.' using errcode = '22000';
  end if;
  select quantity into v_before from public.drawer where id = p_drawer_id for update;
  if not found then
    raise exception 'Drawer not found.' using errcode = 'P0002';
  end if;

  update public.drawer set quantity = p_quantity where id = p_drawer_id;

  perform public._admin_audit('set_drawer_quantity', 'drawer', p_drawer_id,
    jsonb_build_object('drawer_id', p_drawer_id, 'quantity', v_before),
    jsonb_build_object('drawer_id', p_drawer_id, 'quantity', p_quantity));
end;
$$;
revoke all on function public.admin_set_drawer_quantity(uuid, int) from public, anon;
grant execute on function public.admin_set_drawer_quantity(uuid, int) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. Extend get_admin_order_detail: add boxes[] + box_id/quantity on each drawer.
--    (Verbatim copy of the live function with the additive fields — nothing removed.)
-- ---------------------------------------------------------------------------
create or replace function public.get_admin_order_detail(p_order_id uuid)
returns json
language plpgsql
security definer
set search_path to 'public'
as $$
declare v json;
begin
  if not public.is_admin() then
    raise exception 'Admins only.' using errcode = '42501';
  end if;
  select json_build_object(
    'order', to_jsonb(o),
    'customer', to_jsonb(c),
    'organization', to_jsonb(g),
    'boxes', coalesce((
      select json_agg(json_build_object(
        'id', b.id, 'label', b.label, 'quantity', b.quantity, 'created_at', b.created_at
      ) order by b.created_at)
      from public.box b where b.order_id = o.id), '[]'::json),
    'drawers', coalesce((
      select json_agg(json_build_object(
        'id', d.id, 'nickname', d.nickname, 'status', d.status,
        'customer_approval_status', d.customer_approval_status,
        'current_revision', d.current_revision,
        'photo_url', d.photo_url, 'point_cloud_url', d.point_cloud_url,
        'design_preview_url', d.design_preview_url, 'dxf_url', d.dxf_url,
        'box_id', d.box_id, 'quantity', d.quantity,
        'created_at', d.created_at
      ) order by d.created_at)
      from public.drawer d where d.order_id = o.id), '[]'::json)
  ) into v
  from public."order" o
  left join public.customer c on c.id = o.customer_id
  left join public.organization g on g.id = o.organization_id
  where o.id = p_order_id;
  if v is null then
    raise exception 'Order not found.' using errcode = 'P0002';
  end if;
  return v;
end;
$$;
