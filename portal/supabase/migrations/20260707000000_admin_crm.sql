-- ============================================================================
-- T3.5a — Admin CRM: audit trail + edit/merge/search RPCs
-- Spec: planning/FEATURE-admin-crm.md (v1). All mutations admin-gated and audited.
--
-- WHAT
--   1. admin_audit: append-only log (actor/action/table/row/before/after),
--      immutability triggers, admin-read RLS. The trust anchor for cleanup work.
--   2. Edit RPCs behind strict allowlists:
--        admin_update_order            (order text fields, counts, price-in-cents)
--        admin_update_customer         (name/email/phone)
--        admin_set_customer_organization
--        admin_create_organization / admin_rename_organization
--        admin_update_drawer_nickname  (nickname ONLY - decision 3)
--        admin_merge_customers         (dedupe: repoint orders, move auth link,
--                                       delete loser; full row preserved in audit)
--   3. Query RPCs: get_admin_orders (combinable filters: search/org/email/date),
--      get_admin_order_detail (order + customer + org + drawers w/ media urls),
--      get_admin_audit.
--
-- NOT TOUCHED (allowlist boundary): order.drawer_ids, order.created_by/created_at,
--   drawer.status + design/scan/approval fields, customer.auth_user_id (except the
--   documented merge move), qr_url. NULL params mean "leave unchanged"; pass ''
--   to clear a text field.
--
-- ROLLBACK: drop the RPCs and admin_audit (the audit rows are the only state;
--   export before dropping if any cleanup already happened).
--
-- VERIFY: as non-admin every RPC raises 42501; every mutation writes one
--   admin_audit row; drawer_ids byte-identical before/after admin_update_order.
-- ============================================================================

-- 1) audit trail -------------------------------------------------------------
create table if not exists public.admin_audit (
  id         uuid primary key default gen_random_uuid(),
  actor      uuid not null,
  action     text not null,
  table_name text not null,
  row_id     uuid,
  before     jsonb,
  after      jsonb,
  created_at timestamptz not null default now()
);
comment on table public.admin_audit is
  'Append-only log of admin CRM mutations. Written only via SECURITY DEFINER RPCs; UPDATE/DELETE blocked by trigger; readable by admins.';
create index if not exists admin_audit_row_idx on public.admin_audit (table_name, row_id);
create index if not exists admin_audit_created_idx on public.admin_audit (created_at desc);

alter table public.admin_audit enable row level security;
drop policy if exists admin_audit_select_admin on public.admin_audit;
create policy admin_audit_select_admin on public.admin_audit
  for select to authenticated using (public.is_admin());

create or replace function public.admin_audit_immutable()
returns trigger language plpgsql set search_path = ''
as $$
begin
  raise exception 'admin_audit is append-only; % is not permitted', tg_op
    using errcode = '0A000';
end;
$$;
drop trigger if exists admin_audit_no_update on public.admin_audit;
drop trigger if exists admin_audit_no_delete on public.admin_audit;
create trigger admin_audit_no_update before update on public.admin_audit
  for each row execute function public.admin_audit_immutable();
create trigger admin_audit_no_delete before delete on public.admin_audit
  for each row execute function public.admin_audit_immutable();

-- Internal writer (called only from DEFINER RPCs; not client-callable)
create or replace function public._admin_audit(
  p_action text, p_table text, p_row uuid, p_before jsonb, p_after jsonb
) returns void
language sql security definer set search_path = public
as $$
  insert into public.admin_audit (actor, action, table_name, row_id, before, after)
  values ((select auth.uid()), p_action, p_table, p_row, p_before, p_after);
$$;
revoke execute on function public._admin_audit(text, text, uuid, jsonb, jsonb)
  from public, anon, authenticated;

-- 2) edit RPCs ----------------------------------------------------------------
create or replace function public.admin_update_order(
  p_order_id uuid,
  p_customer_name  text default null,
  p_customer_email text default null,
  p_customer_phone text default null,
  p_project_name   text default null,
  p_location       text default null,
  p_notes          text default null,
  p_drawer_count   bigint default null,
  p_total_price_cents bigint default null
) returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_before public."order"%rowtype;
  v_after  public."order"%rowtype;
  v_email  text := case when p_customer_email is null then null
                        else lower(btrim(p_customer_email)) end;
begin
  if not public.is_admin() then
    raise exception 'Admins only.' using errcode = '42501';
  end if;
  select * into v_before from public."order" where id = p_order_id for update;
  if not found then
    raise exception 'Order not found.' using errcode = 'P0002';
  end if;
  if v_email is not null and v_email <> ''
     and v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    raise exception 'Invalid email.' using errcode = '22000';
  end if;
  if p_drawer_count is not null and p_drawer_count < 0 then
    raise exception 'drawer_count must be >= 0.' using errcode = '22000';
  end if;
  if p_total_price_cents is not null and p_total_price_cents < 0 then
    raise exception 'total_price must be >= 0 (integer cents).' using errcode = '22000';
  end if;

  -- NULL = unchanged; '' = clear. drawer_ids/created_by/created_at untouchable.
  -- Note: if the order is unlinked, the T3 email trigger re-links on email change;
  -- if linked, the explicit link wins (use assign_order_to_customer to move it).
  update public."order" set
    customer_name  = coalesce(p_customer_name,  customer_name),
    customer_email = coalesce(v_email,          customer_email),
    customer_phone = coalesce(p_customer_phone, customer_phone),
    project_name   = coalesce(p_project_name,   project_name),
    location       = coalesce(p_location,       location),
    notes          = coalesce(p_notes,          notes),
    drawer_count   = coalesce(p_drawer_count,   drawer_count),
    total_price    = coalesce(p_total_price_cents, total_price)
  where id = p_order_id
  returning * into v_after;

  perform public._admin_audit('update_order', 'order', p_order_id,
                              to_jsonb(v_before), to_jsonb(v_after));
  return json_build_object('ok', true);
end;
$$;

create or replace function public.admin_update_customer(
  p_customer_id uuid,
  p_name  text default null,
  p_email text default null,
  p_phone text default null
) returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_before public.customer%rowtype;
  v_after  public.customer%rowtype;
  v_email  text := case when p_email is null then null
                        else nullif(lower(btrim(p_email)), '') end;
begin
  if not public.is_admin() then
    raise exception 'Admins only.' using errcode = '42501';
  end if;
  select * into v_before from public.customer where id = p_customer_id for update;
  if not found then
    raise exception 'Customer not found.' using errcode = 'P0002';
  end if;
  if v_email is not null
     and v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    raise exception 'Invalid email.' using errcode = '22000';
  end if;

  update public.customer set
    name  = coalesce(p_name, name),
    email = case when p_email is null then email else v_email end,  -- '' clears to null
    phone = coalesce(p_phone, phone)
  where id = p_customer_id
  returning * into v_after;

  perform public._admin_audit('update_customer', 'customer', p_customer_id,
                              to_jsonb(v_before), to_jsonb(v_after));
  return json_build_object('ok', true);
exception when unique_violation then
  raise exception 'Another customer already has this email.' using errcode = '23505';
end;
$$;

create or replace function public.admin_set_customer_organization(
  p_customer_id uuid, p_organization_id uuid default null
) returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_before public.customer%rowtype;
  v_after  public.customer%rowtype;
begin
  if not public.is_admin() then
    raise exception 'Admins only.' using errcode = '42501';
  end if;
  if p_organization_id is not null
     and not exists (select 1 from public.organization where id = p_organization_id) then
    raise exception 'Organization not found.' using errcode = 'P0002';
  end if;
  select * into v_before from public.customer where id = p_customer_id for update;
  if not found then
    raise exception 'Customer not found.' using errcode = 'P0002';
  end if;
  update public.customer set organization_id = p_organization_id
   where id = p_customer_id returning * into v_after;
  perform public._admin_audit('set_customer_organization', 'customer', p_customer_id,
                              to_jsonb(v_before), to_jsonb(v_after));
  return json_build_object('ok', true);
end;
$$;

create or replace function public.admin_create_organization(p_name text)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare v_id uuid;
begin
  if not public.is_admin() then
    raise exception 'Admins only.' using errcode = '42501';
  end if;
  if btrim(coalesce(p_name,'')) = '' then
    raise exception 'A name is required.' using errcode = '22000';
  end if;
  insert into public.organization (name) values (btrim(p_name)) returning id into v_id;
  perform public._admin_audit('create_organization', 'organization', v_id,
                              null, jsonb_build_object('name', btrim(p_name)));
  return v_id;
end;
$$;

create or replace function public.admin_rename_organization(
  p_organization_id uuid, p_name text
) returns json
language plpgsql security definer set search_path = public
as $$
declare v_old text;
begin
  if not public.is_admin() then
    raise exception 'Admins only.' using errcode = '42501';
  end if;
  if btrim(coalesce(p_name,'')) = '' then
    raise exception 'A name is required.' using errcode = '22000';
  end if;
  select name into v_old from public.organization where id = p_organization_id for update;
  if not found then
    raise exception 'Organization not found.' using errcode = 'P0002';
  end if;
  update public.organization set name = btrim(p_name) where id = p_organization_id;
  perform public._admin_audit('rename_organization', 'organization', p_organization_id,
                              jsonb_build_object('name', v_old),
                              jsonb_build_object('name', btrim(p_name)));
  return json_build_object('ok', true);
end;
$$;

create or replace function public.admin_update_drawer_nickname(
  p_drawer_id uuid, p_nickname text
) returns json
language plpgsql security definer set search_path = public
as $$
declare v_old text;
begin
  if not public.is_admin() then
    raise exception 'Admins only.' using errcode = '42501';
  end if;
  select nickname into v_old from public.drawer where id = p_drawer_id for update;
  if not found then
    raise exception 'Drawer not found.' using errcode = 'P0002';
  end if;
  -- Nickname is the ONLY drawer field the portal may write (decision 3).
  update public.drawer set nickname = nullif(btrim(coalesce(p_nickname,'')), '')
   where id = p_drawer_id;
  perform public._admin_audit('update_drawer_nickname', 'drawer', p_drawer_id,
                              jsonb_build_object('nickname', v_old),
                              jsonb_build_object('nickname', nullif(btrim(coalesce(p_nickname,'')), '')));
  return json_build_object('ok', true);
end;
$$;

create or replace function public.admin_merge_customers(
  p_keep uuid, p_merge uuid
) returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_keep  public.customer%rowtype;
  v_merge public.customer%rowtype;
  v_moved int;
begin
  if not public.is_admin() then
    raise exception 'Admins only.' using errcode = '42501';
  end if;
  if p_keep = p_merge then
    raise exception 'Cannot merge a customer into itself.' using errcode = '22000';
  end if;
  select * into v_keep  from public.customer where id = p_keep  for update;
  if not found then raise exception 'Keep-customer not found.' using errcode = 'P0002'; end if;
  select * into v_merge from public.customer where id = p_merge for update;
  if not found then raise exception 'Merge-customer not found.' using errcode = 'P0002'; end if;
  if v_keep.auth_user_id is not null and v_merge.auth_user_id is not null then
    raise exception 'Both customers have login accounts - resolve manually before merging.'
      using errcode = '22000';
  end if;

  -- Repoint orders AND align their org to the post-merge org (otherwise moved
  -- orders keep the loser's organization_id and stay visible to the old org).
  update public."order"
     set customer_id     = p_keep,
         organization_id = coalesce(v_keep.organization_id, v_merge.organization_id)
   where customer_id = p_merge;
  get diagnostics v_moved = row_count;

  -- Delete FIRST so the unique indexes on lower(email) / auth_user_id don't
  -- block the keeper inheriting them. Loser's full row lives on in the audit log.
  delete from public.customer where id = p_merge;

  update public.customer set
    auth_user_id = coalesce(v_keep.auth_user_id, v_merge.auth_user_id),
    email        = coalesce(v_keep.email,        v_merge.email),
    phone        = coalesce(v_keep.phone,        v_merge.phone),
    organization_id = coalesce(v_keep.organization_id, v_merge.organization_id)
  where id = p_keep;

  perform public._admin_audit('merge_customers', 'customer', p_keep,
    jsonb_build_object('kept', to_jsonb(v_keep), 'merged', to_jsonb(v_merge)),
    jsonb_build_object('orders_moved', v_moved,
                       'merged_customer_deleted', p_merge));
  return json_build_object('ok', true, 'orders_moved', v_moved);
end;
$$;

-- 3) query RPCs -----------------------------------------------------------------
create or replace function public.get_admin_orders(
  p_search text default null,
  p_organization_id uuid default null,
  p_email text default null,
  p_from timestamptz default null,
  p_to   timestamptz default null
) returns table (
  order_id uuid, created_at timestamptz, customer_name text, customer_email text,
  project_name text, location text, notes text, drawer_count bigint,
  total_price bigint, customer_id uuid, organization_id uuid, organization_name text,
  drawer_rows bigint
)
language plpgsql security definer set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'Admins only.' using errcode = '42501';
  end if;
  return query
    select o.id, o.created_at,
           coalesce(c.name,  o.customer_name),
           coalesce(c.email, o.customer_email),
           o.project_name, o.location, o.notes, o.drawer_count, o.total_price,
           o.customer_id, o.organization_id, g.name,
           (select count(*) from public.drawer d where d.order_id = o.id)
      from public."order" o
      left join public.customer c on c.id = o.customer_id
      left join public.organization g on g.id = o.organization_id
     where (p_search is null or btrim(p_search) = ''
            or coalesce(c.name,  o.customer_name, '') ilike '%'||btrim(p_search)||'%'
            or coalesce(c.email, o.customer_email,'') ilike '%'||btrim(p_search)||'%'
            or coalesce(o.project_name,'') ilike '%'||btrim(p_search)||'%'
            or coalesce(o.notes,'') ilike '%'||btrim(p_search)||'%')
       and (p_organization_id is null or o.organization_id = p_organization_id)
       and (p_email is null or btrim(p_email) = ''
            or coalesce(c.email, o.customer_email,'') ilike '%'||btrim(p_email)||'%')
       and (p_from is null or o.created_at >= p_from)
       and (p_to   is null or o.created_at <  p_to)
     order by o.created_at desc;
end;
$$;

create or replace function public.get_admin_order_detail(p_order_id uuid)
returns json
language plpgsql security definer set search_path = public
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
    'drawers', coalesce((
      select json_agg(json_build_object(
        'id', d.id, 'nickname', d.nickname, 'status', d.status,
        'customer_approval_status', d.customer_approval_status,
        'current_revision', d.current_revision,
        'photo_url', d.photo_url, 'point_cloud_url', d.point_cloud_url,
        'design_preview_url', d.design_preview_url, 'dxf_url', d.dxf_url,
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

create or replace function public.get_admin_audit(
  p_limit int default 100, p_table text default null, p_row uuid default null
) returns table (
  id uuid, actor uuid, action text, table_name text, row_id uuid,
  before jsonb, after jsonb, created_at timestamptz
)
language plpgsql security definer set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'Admins only.' using errcode = '42501';
  end if;
  return query
    select a.id, a.actor, a.action, a.table_name, a.row_id, a.before, a.after, a.created_at
      from public.admin_audit a
     where (p_table is null or a.table_name = p_table)
       and (p_row is null or a.row_id = p_row)
     order by a.created_at desc
     limit greatest(1, least(coalesce(p_limit, 100), 500));
end;
$$;

-- 3b) retrofit the audit trail into the T3 mutation RPCs ---------------------------
-- Same bodies as 20260706000000, plus one _admin_audit call each, so every
-- admin mutation in the system lands in one audit spine.
create or replace function public.assign_order_to_customer(
  p_order_id uuid, p_customer_id uuid
) returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_cust   public.customer%rowtype;
  v_before public."order"%rowtype;
  v_after  public."order"%rowtype;
begin
  if not public.is_admin() then
    raise exception 'Admins only.' using errcode = '42501';
  end if;
  select * into v_cust from public.customer where id = p_customer_id;
  if not found then
    raise exception 'Customer not found.' using errcode = 'P0002';
  end if;
  select * into v_before from public."order" where id = p_order_id for update;
  if not found then
    raise exception 'Order not found.' using errcode = 'P0002';
  end if;
  update public."order"
     set customer_id     = v_cust.id,
         organization_id = coalesce(organization_id, v_cust.organization_id)
   where id = p_order_id
   returning * into v_after;
  perform public._admin_audit('assign_order_to_customer', 'order', p_order_id,
                              to_jsonb(v_before), to_jsonb(v_after));
  return json_build_object('ok', true, 'order_id', p_order_id, 'customer_id', v_cust.id);
end;
$$;

create or replace function public.admin_create_customer(
  p_name text, p_email text default null, p_phone text default null
) returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_email text := nullif(lower(btrim(coalesce(p_email, ''))), '');
  v_id uuid;
begin
  if not public.is_admin() then
    raise exception 'Admins only.' using errcode = '42501';
  end if;
  if btrim(coalesce(p_name, '')) = '' then
    raise exception 'A name is required.' using errcode = '22000';
  end if;
  if v_email is not null
     and v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    raise exception 'Invalid email.' using errcode = '22000';
  end if;
  insert into public.customer (name, phone, email)
  values (btrim(p_name), nullif(btrim(coalesce(p_phone,'')), ''), v_email)
  returning id into v_id;
  perform public._admin_audit('create_customer', 'customer', v_id, null,
    jsonb_build_object('name', btrim(p_name), 'email', v_email));
  return v_id;
exception when unique_violation then
  raise exception 'A customer with this email already exists.' using errcode = '23505';
end;
$$;

create or replace function public.mark_drawer_delivered(
  p_drawer_id uuid, p_note text default null
) returns json
language plpgsql security definer set search_path = public
as $$
declare
  d public.drawer%rowtype;
begin
  if not public.is_admin() then
    raise exception 'Admins only.' using errcode = '42501';
  end if;
  select * into d from public.drawer where id = p_drawer_id for update;
  if not found then
    raise exception 'Drawer not found.' using errcode = 'P0002';
  end if;
  insert into public.drawer_event
    (drawer_id, revision, event_type, actor_name, actor_role, note)
  values
    (p_drawer_id, coalesce(d.current_revision, 0), 'delivered', 'TidyTool', 'staff',
     nullif(btrim(coalesce(p_note, '')), ''));
  perform public._admin_audit('mark_drawer_delivered', 'drawer', p_drawer_id, null,
    jsonb_build_object('note', nullif(btrim(coalesce(p_note, '')), '')));
  return json_build_object('ok', true, 'drawer_id', p_drawer_id);
end;
$$;

-- 4) grants -----------------------------------------------------------------------
revoke execute on function public.admin_update_order(uuid,text,text,text,text,text,text,bigint,bigint) from public, anon;
revoke execute on function public.admin_update_customer(uuid,text,text,text)          from public, anon;
revoke execute on function public.admin_set_customer_organization(uuid,uuid)          from public, anon;
revoke execute on function public.admin_create_organization(text)                     from public, anon;
revoke execute on function public.admin_rename_organization(uuid,text)                from public, anon;
revoke execute on function public.admin_update_drawer_nickname(uuid,text)             from public, anon;
revoke execute on function public.admin_merge_customers(uuid,uuid)                    from public, anon;
revoke execute on function public.get_admin_orders(text,uuid,text,timestamptz,timestamptz) from public, anon;
revoke execute on function public.get_admin_order_detail(uuid)                        from public, anon;
revoke execute on function public.get_admin_audit(int,text,uuid)                      from public, anon;
grant execute on function public.admin_update_order(uuid,text,text,text,text,text,text,bigint,bigint) to authenticated;
grant execute on function public.admin_update_customer(uuid,text,text,text)           to authenticated;
grant execute on function public.admin_set_customer_organization(uuid,uuid)           to authenticated;
grant execute on function public.admin_create_organization(text)                      to authenticated;
grant execute on function public.admin_rename_organization(uuid,text)                 to authenticated;
grant execute on function public.admin_update_drawer_nickname(uuid,text)              to authenticated;
grant execute on function public.admin_merge_customers(uuid,uuid)                     to authenticated;
grant execute on function public.get_admin_orders(text,uuid,text,timestamptz,timestamptz) to authenticated;
grant execute on function public.get_admin_order_detail(uuid)                         to authenticated;
grant execute on function public.get_admin_audit(int,text,uuid)                       to authenticated;
