-- Quoting engine backend: pricing_config + quote + quote_line_item, staff-only
-- RLS, and guarded RPCs. Pairs with portal/src/lib/pricing/* (the TS engine
-- that actually computes prices — SQL stores and audits, TS prices).
--
-- ⚠ HIGH-RISK per CLAUDE.md: production schema change. Sam reviews before this
--   is applied (or trial it on a disposable Supabase branch first).
--
-- Money convention: INTEGER CENTS everywhere, matching order.total_price.
-- Line items are rounded to the cent by the engine; the quote total is the
-- exact sum of the lines (to the cent), so the line column always reconciles.
--
-- Design notes:
-- * pricing_config holds the engine's whole rate card as one jsonb blob,
--   versioned by row; exactly one row is active (partial unique index). New
--   rates = INSERT a new active row (deactivating the old), so historical
--   quotes keep pointing at the exact config that priced them.
-- * quote is append-mostly: a re-quote is a NEW row, not an UPDATE, so sent
--   numbers are never silently rewritten. Status transitions go through
--   set_quote_status (audited).
-- * Internal cost/margin columns (estimated_cost_cents, gross_*, cost_breakdown)
--   live on quote and MUST NOT be exposed by any future customer-facing RPC.
--   below_target flags jobs under the target margin for review — pricing is
--   never auto-adjusted (fixed $20/sqft for now).

-- ---------------------------------------------------------------------------
-- 1. pricing_config
-- ---------------------------------------------------------------------------
create table public.pricing_config (
  id         uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  label      text not null,
  active     boolean not null default false,
  config     jsonb not null
);
comment on table public.pricing_config is
  'Versioned rate cards for the quoting engine (portal/src/lib/pricing). One active row; quotes FK the row that priced them.';

create unique index pricing_config_one_active on public.pricing_config (active) where active;

alter table public.pricing_config enable row level security;

create policy pricing_config_select_staff on public.pricing_config
  for select to authenticated using (public.is_staff());
create policy pricing_config_insert_admin on public.pricing_config
  for insert to authenticated with check (public.is_admin());
create policy pricing_config_update_admin on public.pricing_config
  for update to authenticated using (public.is_admin()) with check (public.is_admin());
-- no delete policy: retire configs by deactivating, quotes reference them

-- Seed: initial rules (2026-07-24). Mirrors DEFAULT_PRICING_CONFIG in
-- portal/src/lib/pricing/config.ts — keep the two in sync.
insert into public.pricing_config (label, active, config) values (
  'Initial rules 2026-07-24 — $20/sqft, $40 drawer min, $250 order min',
  true,
  '{
    "version": 1,
    "currency": "USD",
    "product": {
      "rate_cents_per_sqft": 2000,
      "thickness_multipliers": { "0.5": 1.0 },
      "default_thickness_in": 0.5,
      "default_thickness_multiplier": 1.0
    },
    "minimums": { "per_drawer_cents": 4000, "per_order_cents": 25000 },
    "services": {
      "measurement_design": { "label": "On-site Measurement & Design", "included": true, "price_cents": 0 },
      "delivery_install":   { "label": "Delivery, Installation & Test Fit", "included": true, "price_cents": 0 }
    },
    "upgrades": {},
    "costs": {
      "mileage_cents_per_round_trip_mile": 70,
      "driving_labor_cents_per_hour": 2000,
      "scanning_labor_cents_per_hour": 2000,
      "install_labor_cents_per_hour": 2000,
      "scanning_minutes_per_sqft": 5,
      "default_trips": 2
    },
    "margin": { "target": 0.6 },
    "rounding": { "line": "cent", "total": "cent" }
  }'::jsonb
);

-- ---------------------------------------------------------------------------
-- 2. quote
-- ---------------------------------------------------------------------------
create table public.quote (
  id                   uuid primary key default gen_random_uuid(),
  created_at           timestamptz not null default now(),
  created_by           uuid default auth.uid(),
  order_id             uuid not null references public."order"(id) on delete cascade,
  config_id            uuid not null references public.pricing_config(id),
  status               text not null default 'draft'
                         check (status in ('draft','sent','accepted','declined','expired','void')),
  -- customer-facing numbers
  subtotal_cents       bigint not null check (subtotal_cents >= 0),
  total_cents          bigint not null check (total_cents >= 0),
  -- INTERNAL — never expose on customer surfaces
  inputs               jsonb not null,   -- {round_trip_miles, drive_hours_per_trip, install_hours, trips, upgrade_keys}
  estimated_cost_cents bigint not null check (estimated_cost_cents >= 0),
  cost_breakdown       jsonb not null,   -- mileage/driving/scanning/install + assumptions
  gross_profit_cents   bigint not null,
  gross_margin         numeric(6,4),     -- null when total is 0
  margin_target        numeric(6,4) not null,
  below_target         boolean generated always as
                         (gross_margin is not null and gross_margin < margin_target) stored,
  warnings             jsonb not null default '[]'::jsonb,
  unpriced_drawers     jsonb not null default '[]'::jsonb,
  notes                text,
  valid_until          date
);
comment on table public.quote is
  'Priced quotes for an order. Append-mostly: re-quotes are new rows. gross_/cost_ columns are internal-only.';
comment on column public.quote.total_cents is
  'Customer-facing total, integer cents. Exact sum of the line items (to the cent).';
comment on column public.quote.below_target is
  'True = gross margin under target. Review flag only — never auto-repriced.';

create index quote_order_id_idx on public.quote (order_id, created_at desc);
create index quote_below_target_idx on public.quote (below_target) where below_target;

alter table public.quote enable row level security;
create policy quote_select_staff on public.quote
  for select to authenticated using (public.is_staff());
-- writes go exclusively through the RPCs below (SECURITY DEFINER); no
-- insert/update/delete policies on purpose.

-- ---------------------------------------------------------------------------
-- 3. quote_line_item
-- ---------------------------------------------------------------------------
create table public.quote_line_item (
  id               uuid primary key default gen_random_uuid(),
  quote_id         uuid not null references public.quote(id) on delete cascade,
  position         int not null,
  kind             text not null check (kind in
                     ('measurement_design','product','upgrade','delivery_install','min_order_adjustment')),
  description      text not null,
  drawer_id        uuid references public.drawer(id) on delete set null,
  qty              numeric,          -- sqft for product lines
  unit             text,
  unit_price_cents bigint,
  amount_cents     bigint not null check (amount_cents >= 0),
  included         boolean not null default false,  -- render "Included" instead of $0.00
  meta             jsonb not null default '{}'::jsonb,
  unique (quote_id, position)
);
comment on table public.quote_line_item is
  'Customer-facing quote lines in presentation order. meta carries normalized dims / minimum details.';

create index quote_line_item_quote_idx on public.quote_line_item (quote_id, position);
create index quote_line_item_drawer_idx on public.quote_line_item (drawer_id);

alter table public.quote_line_item enable row level security;
create policy quote_line_item_select_staff on public.quote_line_item
  for select to authenticated using (public.is_staff());

-- ---------------------------------------------------------------------------
-- 4. save_quote — atomic insert of a computed quote + its lines
-- ---------------------------------------------------------------------------
-- The TS engine computes; this RPC persists. It re-checks the invariants it
-- can (sums, dollar rounding, config existence) so a buggy or malicious client
-- can't store lines that don't add up to their own total.
create or replace function public.save_quote(
  p_order_id  uuid,
  p_config_id uuid,
  p_quote     jsonb,   -- ComputedQuote summary fields
  p_lines     jsonb,   -- ComputedQuote.lines array
  p_notes     text default null,
  p_valid_days int default 30
)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_quote_id  uuid;
  v_line      jsonb;
  v_sum       bigint := 0;
  v_subtotal  bigint := (p_quote->>'subtotal_cents')::bigint;
  v_total     bigint := (p_quote->>'total_cents')::bigint;
begin
  if not public.is_staff() then
    raise exception 'save_quote: staff or admin only';
  end if;
  if not exists (select 1 from public."order" o where o.id = p_order_id) then
    raise exception 'save_quote: order % not found', p_order_id;
  end if;
  if not exists (select 1 from public.pricing_config c where c.id = p_config_id) then
    raise exception 'save_quote: pricing config % not found', p_config_id;
  end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'save_quote: p_lines must be a non-empty array';
  end if;

  -- Integrity: lines must sum to the subtotal, and the total is that exact sum
  -- (total is to the cent — no whole-dollar rounding).
  select coalesce(sum((l->>'amount_cents')::bigint), 0) into v_sum
  from jsonb_array_elements(p_lines) l;
  if v_sum <> v_subtotal then
    raise exception 'save_quote: line sum % ≠ subtotal %', v_sum, v_subtotal;
  end if;
  if v_total <> v_subtotal then
    raise exception 'save_quote: total % must equal the line sum %', v_total, v_subtotal;
  end if;

  insert into public.quote (
    order_id, config_id, subtotal_cents, total_cents,
    inputs, estimated_cost_cents, cost_breakdown,
    gross_profit_cents, gross_margin, margin_target,
    warnings, unpriced_drawers, notes, valid_until
  ) values (
    p_order_id, p_config_id, v_subtotal, v_total,
    coalesce(p_quote->'inputs', '{}'::jsonb),
    (p_quote->>'estimated_cost_cents')::bigint,
    coalesce(p_quote->'cost_breakdown', '{}'::jsonb),
    (p_quote->>'gross_profit_cents')::bigint,
    (p_quote->>'gross_margin')::numeric,
    (p_quote->>'margin_target')::numeric,
    coalesce(p_quote->'warnings', '[]'::jsonb),
    coalesce(p_quote->'unpriced_drawers', '[]'::jsonb),
    p_notes,
    (current_date + make_interval(days => greatest(1, coalesce(p_valid_days, 30))))::date
  ) returning id into v_quote_id;

  for v_line in select * from jsonb_array_elements(p_lines) loop
    insert into public.quote_line_item (
      quote_id, position, kind, description, drawer_id,
      qty, unit, unit_price_cents, amount_cents, included, meta
    ) values (
      v_quote_id,
      (v_line->>'position')::int,
      v_line->>'kind',
      v_line->>'description',
      nullif(v_line->>'drawer_id','')::uuid,
      (v_line->>'qty')::numeric,
      v_line->>'unit',
      (v_line->>'unit_price_cents')::bigint,
      (v_line->>'amount_cents')::bigint,
      coalesce((v_line->>'included')::boolean, false),
      coalesce(v_line->'meta', '{}'::jsonb)
    );
  end loop;

  insert into public.admin_audit (actor, action, table_name, row_id, before, after)
  values (auth.uid(), 'save_quote', 'quote', v_quote_id, null,
          jsonb_build_object('order_id', p_order_id, 'total_cents', v_total,
                             'gross_margin', p_quote->>'gross_margin'));
  return v_quote_id;
end;
$$;
revoke all on function public.save_quote(uuid, uuid, jsonb, jsonb, text, int) from public, anon;
grant execute on function public.save_quote(uuid, uuid, jsonb, jsonb, text, int) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 5. set_quote_status — audited lifecycle transitions
-- ---------------------------------------------------------------------------
-- Accepting a quote copies its total onto order.total_price (the field the
-- rest of the system — and tidyCAM — already reads). That write is why this
-- is an RPC and not a bare UPDATE policy.
create or replace function public.set_quote_status(p_quote_id uuid, p_status text)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_quote public.quote%rowtype;
begin
  if not public.is_staff() then
    raise exception 'set_quote_status: staff or admin only';
  end if;
  if p_status not in ('draft','sent','accepted','declined','expired','void') then
    raise exception 'set_quote_status: invalid status %', p_status;
  end if;
  select * into v_quote from public.quote where id = p_quote_id for update;
  if not found then
    raise exception 'set_quote_status: quote % not found', p_quote_id;
  end if;
  if v_quote.status = p_status then
    return;
  end if;

  update public.quote set status = p_status where id = p_quote_id;

  if p_status = 'accepted' then
    update public."order" set total_price = v_quote.total_cents where id = v_quote.order_id;
  end if;

  insert into public.admin_audit (actor, action, table_name, row_id, before, after)
  values (auth.uid(), 'set_quote_status', 'quote', p_quote_id,
          jsonb_build_object('status', v_quote.status),
          jsonb_build_object('status', p_status,
                             'order_total_price_updated', p_status = 'accepted'));
end;
$$;
revoke all on function public.set_quote_status(uuid, text) from public, anon;
grant execute on function public.set_quote_status(uuid, text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 6. get_quotes_for_order — list for the admin order page
-- ---------------------------------------------------------------------------
create or replace function public.get_quotes_for_order(p_order_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
begin
  if not public.is_staff() then
    raise exception 'get_quotes_for_order: staff or admin only';
  end if;
  return coalesce((
    select jsonb_agg(
      jsonb_build_object(
        'id', q.id,
        'created_at', q.created_at,
        'status', q.status,
        'subtotal_cents', q.subtotal_cents,
        'total_cents', q.total_cents,
        'estimated_cost_cents', q.estimated_cost_cents,
        'gross_profit_cents', q.gross_profit_cents,
        'gross_margin', q.gross_margin,
        'margin_target', q.margin_target,
        'below_target', q.below_target,
        'warnings', q.warnings,
        'unpriced_drawers', q.unpriced_drawers,
        'valid_until', q.valid_until,
        'notes', q.notes,
        'cost_breakdown', q.cost_breakdown,
        'lines', (
          select coalesce(jsonb_agg(jsonb_build_object(
            'position', l.position,
            'kind', l.kind,
            'description', l.description,
            'drawer_id', l.drawer_id,
            'qty', l.qty,
            'unit', l.unit,
            'unit_price_cents', l.unit_price_cents,
            'amount_cents', l.amount_cents,
            'included', l.included,
            'meta', l.meta
          ) order by l.position), '[]'::jsonb)
          from public.quote_line_item l where l.quote_id = q.id
        )
      ) order by q.created_at desc
    )
    from public.quote q where q.order_id = p_order_id
  ), '[]'::jsonb);
end;
$$;
revoke all on function public.get_quotes_for_order(uuid) from public, anon;
grant execute on function public.get_quotes_for_order(uuid) to authenticated, service_role;
