-- ============================================================================
-- 0004 — Durable identity: customer/organization model + link-on-login + backfill
-- (ARCHITECTURE.md pillar 1; executive decisions 1, 2, 5, 6)
--
-- WHAT
--   1. New `organization` table (nullable links — solo customers exist).
--   2. Archive-then-purge the 20 stale `customer` rows (all have empty emails,
--      zero match any order — verified 2026-07-03; decision 6).
--   3. Extend `customer` with auth_user_id → auth.users and organization_id.
--   4. `order.customer_id` → customer becomes the real link; customer_email
--      stays as the claim/backfill key, never a FK. order.organization_id added.
--   5. Backfill: distinct clean order.customer_email → customer rows (27 emails,
--      name/phone taken from the most recent order per email); link the 29
--      clean orders; 28 orphaned orders keep customer_id null until the admin
--      mapping tool ships (decision 5).
--   6. Link-on-login: trigger on auth.users (insert + last_sign_in_at update)
--      attaches customer.auth_user_id where lower(email) matches; plus a
--      one-time link for already-existing auth users.
--   7. RLS: customers read own row; org members read their whole org
--      (whole-org visibility, decided 6/28); admin reads all. Default-deny
--      for every other operation (no write policies; service_role bypasses).
--
-- UNTOUCHED (guardrails): drawer_status enum, order.drawer_ids, qr_url,
--   all existing RPCs, tidyCAM write paths (new columns are nullable/additive).
--
-- ROLLBACK
--   - Restore purged rows:  insert into public.customer (id, created_at, name, phone, email)
--       select id, created_at, name, phone, email from public._archive_customer_2026_07_03;
--   - Drop additions: triggers link_customer_on_auth_* on auth.users;
--     functions link_customer_on_auth(), my_organization_id();
--     policies customer_select_self_or_org, organization_select_member;
--     columns order.customer_id, order.organization_id,
--     customer.auth_user_id, customer.organization_id; table organization.
--     (Backfilled customer rows: delete from customer where id not in archive.)
--
-- VERIFICATION (run after apply; expected prod values in brackets)
--   select count(*) from public._archive_customer_2026_07_03;            -- [20]
--   select count(*) from public.customer;                                -- [27]
--   select count(*) from public."order" where customer_id is not null;   -- [29]
--   select count(*) from public."order" where customer_id is null;       -- [28]
--   select count(*) from public.customer where auth_user_id is not null; -- [3]
--   select tgname from pg_trigger where tgrelid = 'auth.users'::regclass
--     and tgname like 'link_customer%';                                  -- [2 rows]
-- ============================================================================

-- 1) organization ------------------------------------------------------------
create table if not exists public.organization (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  created_at timestamptz not null default now()
);
comment on table public.organization is
  'B2B account grouping. customer.organization_id / order.organization_id are nullable — solo customers exist. Whole-org visibility (decision 2026-06-28).';
alter table public.organization enable row level security;

-- 2) archive-then-purge stale customer rows (decision 6) ----------------------
create table if not exists public._archive_customer_2026_07_03 as
  select * from public.customer;
alter table public._archive_customer_2026_07_03 enable row level security;
comment on table public._archive_customer_2026_07_03 is
  'Pre-0004 snapshot of the test/debug customer rows (purged by 0004). No policies on purpose (service-role only). Drop together with drawer_backup_2026_05_02 once retention window passes.';
delete from public.customer;

-- 3) extend customer -----------------------------------------------------------
alter table public.customer
  add column if not exists auth_user_id    uuid references auth.users (id) on delete set null,
  add column if not exists organization_id uuid references public.organization (id);
create unique index if not exists customer_auth_user_id_key
  on public.customer (auth_user_id) where auth_user_id is not null;
create unique index if not exists customer_email_lower_key
  on public.customer (lower(email)) where email is not null;
create index if not exists customer_organization_id_idx
  on public.customer (organization_id);
comment on column public.customer.auth_user_id is
  'Set by link-on-login trigger (or backfill) when an auth user''s email matches. Null until the customer claims their account.';

-- 4) order links ---------------------------------------------------------------
alter table public."order"
  add column if not exists customer_id     uuid references public.customer (id),
  add column if not exists organization_id uuid references public.organization (id);
create index if not exists order_customer_id_idx     on public."order" (customer_id);
create index if not exists order_organization_id_idx on public."order" (organization_id);
comment on column public."order".customer_id is
  'Durable link to customer. customer_email remains the historical claim key; never treat it as a FK. Null = orphaned order awaiting admin mapping (decision 5).';

-- 5) backfill (decision 5: clean rows only; orphans stay null) ------------------
insert into public.customer (name, phone, email)
select distinct on (lower(btrim(o.customer_email)))
       o.customer_name,
       o.customer_phone,
       lower(btrim(o.customer_email))
  from public."order" o
 where btrim(coalesce(o.customer_email, ''))
       ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'
 order by lower(btrim(o.customer_email)), o.created_at desc;

update public."order" o
   set customer_id = c.id
  from public.customer c
 where o.customer_id is null
   and btrim(coalesce(o.customer_email, '')) <> ''
   and lower(btrim(o.customer_email)) = c.email;

-- 6) link-on-login -------------------------------------------------------------
-- One-time link for auth users that already exist:
update public.customer c
   set auth_user_id = u.id
  from auth.users u
 where c.auth_user_id is null
   and c.email is not null
   and u.email is not null
   and lower(u.email) = c.email;

create or replace function public.link_customer_on_auth()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.email is not null then
    update public.customer
       set auth_user_id = new.id
     where auth_user_id is null
       and email is not null
       and lower(email) = lower(new.email);
  end if;
  return new;
end;
$$;
revoke execute on function public.link_customer_on_auth() from public, anon, authenticated;

drop trigger if exists link_customer_on_auth_created on auth.users;
create trigger link_customer_on_auth_created
  after insert on auth.users
  for each row execute function public.link_customer_on_auth();

drop trigger if exists link_customer_on_auth_login on auth.users;
create trigger link_customer_on_auth_login
  after update of last_sign_in_at on auth.users
  for each row execute function public.link_customer_on_auth();

-- 7) RLS -----------------------------------------------------------------------
-- SECURITY DEFINER helper avoids RLS self-recursion on customer.
create or replace function public.my_organization_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select organization_id from public.customer
   where auth_user_id = (select auth.uid())
   limit 1;
$$;
revoke execute on function public.my_organization_id() from public, anon;
grant  execute on function public.my_organization_id() to authenticated;

drop policy if exists customer_select_self_or_org on public.customer;
create policy customer_select_self_or_org on public.customer
  for select to authenticated
  using (
    auth_user_id = (select auth.uid())
    or (organization_id is not null and organization_id = public.my_organization_id())
    or public.is_admin()
  );

drop policy if exists organization_select_member on public.organization;
create policy organization_select_member on public.organization
  for select to authenticated
  using (
    id = public.my_organization_id()
    or public.is_admin()
  );
-- No insert/update/delete policies anywhere above: default-deny by design.
