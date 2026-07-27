-- =============================================================================
-- 20260727100000_status_backbone.sql  (v2 — post design review 2026-07-27)
-- Order-status overhaul: event spine + canonical drawer lifecycle + derived
-- order state + customer projection.
-- Roadmap + review resolutions: claude.ai project doc
--   claude/order-status-roadmap-2026-07-27.md
--
-- Conceptual model (review-approved):
--   status_event (audit source of truth)
--     -> drawer.stage  (lifecycle progress ONLY — no exceptions mixed in)
--     -> drawer.state  (blocker axis: active | on_hold | rework | cancelled)
--     -> order.computed_status (pure function of drawers; may move BOTH ways,
--        every change evented kind='recompute')
--     -> order.manual_status/... (explicit, reasoned, clearable override)
--     -> order.state   (active | on_hold | cancelled)
--     -> order.delivery_scheduled_at (operational metadata, NOT a stage)
--     -> customer_step projection (tracker) derived from all of the above.
--   Effective order status = coalesce(manual_status, computed_status).
--
-- IMMUTABILITY, PRECISELY: triggers below reject UPDATE/DELETE/TRUNCATE on
-- status_event for every role that goes through SQL, including service_role.
-- PostgreSQL cannot prevent the table OWNER or a superuser from dropping or
-- disabling those triggers; this is application-path immutability + audit,
-- not a cryptographic guarantee. Schema changes are migration-reviewed.
--
-- Legacy compatibility: drawer.status (drawer_status enum) is untouched and
-- mirrored where a mapping exists. The bridge accepts legacy ADVANCES only;
-- legacy regressions (e.g. tidyCAM accidentally re-writing an old status) are
-- ignored — corrections must go through set_drawer_stage(p_correction).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. status_def — display/projection config. `code` is an IMMUTABLE identifier:
--    labels & customer_step may be updated freely; adding/retiring codes or
--    changing workflow semantics happens only via reviewed migrations.
-- -----------------------------------------------------------------------------
create table public.status_def (
  domain        text not null check (domain in ('order','drawer')),
  code          text not null,
  label         text not null,
  customer_step int  check (customer_step between 1 and 7),
  sort_order    int  not null,
  is_terminal   boolean not null default false,
  manual_only   boolean not null default false,  -- never produced by recompute
  is_active     boolean not null default true,
  primary key (domain, code),
  unique (domain, sort_order)
);

alter table public.status_def enable row level security;
create policy status_def_read on public.status_def
  for select to authenticated using (true);

insert into public.status_def (domain, code, label, customer_step, sort_order, is_terminal, manual_only) values
  -- drawer lifecycle (progress only — hold/rework/cancel live on drawer.state)
  ('drawer','backlog',           'Backlog',                    1,  10, false, false),
  ('drawer','scanned',           'Scanned',                    2,  20, false, false),
  ('drawer','design_queue',      'In design queue',            3,  30, false, false),
  ('drawer','designed',          'Design complete',            3,  40, false, false),
  ('drawer','qc_passed',         'QC passed',                  3,  50, false, false),
  ('drawer','awaiting_approval', 'Awaiting customer approval', 4,  60, false, false),
  ('drawer','approved',          'Customer approved',          5,  70, false, false),
  ('drawer','in_production',     'In production',              5,  80, false, false),
  ('drawer','cut',               'Cut',                        5,  90, false, false),
  ('drawer','ready',             'Ready for delivery',         6, 100, false, false),
  ('drawer','delivered',         'Delivered',                  7, 110, true,  false),
  -- order computed positions (hold/cancel live on order.state; scheduling is metadata)
  ('order','received',          'Order received',              1,  10, false, false),
  ('order','scanning',          'Scanning & measurement',      2,  20, false, false),
  ('order','design',            'Design in progress',          3,  30, false, false),
  ('order','awaiting_approval', 'Awaiting customer approval',  4,  40, false, false),
  ('order','approved',          'Approved — production queue', 5,  50, false, false),
  ('order','production',        'In production',               5,  60, false, false),
  ('order','ready',             'Ready for delivery',          6,  70, false, false),
  ('order','delivered',         'Delivered & installed',       7,  80, false, false),
  ('order','closed',            'Closed',                      7,  90, true,  true );

-- -----------------------------------------------------------------------------
-- 2. status_transition — the legal drawer workflow, including legitimate loops.
--    kind 'advance' = forward work; kind 'return' = sanctioned workflow loop
--    (e.g. approval rework). Anything else requires an admin CORRECTION
--    (explicit flag + reason in set_drawer_stage). Order-domain transitions are
--    not table-driven: computed_status is a pure derivation (kind 'recompute')
--    and manual overrides are their own explicit mechanism.
-- -----------------------------------------------------------------------------
create table public.status_transition (
  domain    text not null check (domain = 'drawer'),
  from_code text not null,
  to_code   text not null,
  kind      text not null check (kind in ('advance','return')),
  primary key (domain, from_code, to_code),
  foreign key (domain, from_code) references public.status_def (domain, code),
  foreign key (domain, to_code)   references public.status_def (domain, code)
);

alter table public.status_transition enable row level security;
create policy status_transition_read on public.status_transition
  for select to authenticated using (true);

insert into public.status_transition (domain, from_code, to_code, kind) values
  ('drawer','backlog','scanned','advance'),
  ('drawer','scanned','design_queue','advance'),
  ('drawer','design_queue','designed','advance'),
  ('drawer','designed','qc_passed','advance'),
  ('drawer','designed','awaiting_approval','advance'),      -- QC optional
  ('drawer','qc_passed','awaiting_approval','advance'),
  ('drawer','qc_passed','approved','advance'),              -- offline/verbal approval
  ('drawer','awaiting_approval','approved','advance'),
  ('drawer','approved','in_production','advance'),
  ('drawer','in_production','cut','advance'),
  ('drawer','in_production','ready','advance'),             -- cut-marking optional
  ('drawer','cut','ready','advance'),
  ('drawer','ready','delivered','advance'),
  -- sanctioned loops / returns
  ('drawer','scanned','backlog','return'),
  ('drawer','designed','design_queue','return'),
  ('drawer','qc_passed','designed','return'),
  ('drawer','awaiting_approval','designed','return'),       -- changes requested
  ('drawer','awaiting_approval','design_queue','return'),
  ('drawer','approved','awaiting_approval','return');       -- re-approval after change
  -- NOTE: delivered has no table transitions — reopening a delivered drawer is
  -- an admin correction (delivered -> ready/in_production/designed, reasoned).

-- -----------------------------------------------------------------------------
-- 3. status_event — append-only spine
-- -----------------------------------------------------------------------------
create table public.status_event (
  id              uuid primary key default gen_random_uuid(),
  order_id        uuid references public."order"(id) on delete cascade,
  drawer_id       uuid references public.drawer(id) on delete cascade,
  domain          text not null check (domain in ('order','drawer')),
  field           text not null check (field in ('stage','state','override','schedule')),
  kind            text not null check (kind in ('advance','return','correction','recompute','bridge','backfill','system')),
  from_status     text,
  to_status       text,
  actor           uuid,
  actor_name      text,
  actor_role      text,
  source          text not null default 'portal'
                  check (source in ('tidycam','tidycad','portal','system','bridge','backfill')),
  note            text,
  payload         jsonb,
  idempotency_key text,
  created_at      timestamptz not null default now(),   -- always server-generated
  check (order_id is not null or drawer_id is not null),
  check (domain <> 'drawer' or drawer_id is not null)
);

create index status_event_order_idx  on public.status_event (order_id, created_at);
create index status_event_drawer_idx on public.status_event (drawer_id, created_at);
create index status_event_status_idx on public.status_event (domain, field, to_status);
create unique index status_event_idem_idx on public.status_event (idempotency_key)
  where idempotency_key is not null;

alter table public.status_event enable row level security;
create policy status_event_staff_read on public.status_event
  for select to authenticated using (public.is_staff());
-- No INSERT/UPDATE/DELETE policies: the only write path is record_status_event().

create or replace function public.status_event_immutable()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  raise exception 'status_event is append-only (% blocked)', tg_op;
end $$;

create trigger status_event_no_update before update on public.status_event
  for each row execute function public.status_event_immutable();
create trigger status_event_no_delete before delete on public.status_event
  for each row execute function public.status_event_immutable();
create trigger status_event_no_truncate before truncate on public.status_event
  for each statement execute function public.status_event_immutable();

-- Realtime: status_event + "order" ("drawer" is already published)
do $$
begin
  if not exists (select 1 from pg_publication_tables
                 where pubname='supabase_realtime' and schemaname='public' and tablename='status_event') then
    alter publication supabase_realtime add table public.status_event;
  end if;
  if not exists (select 1 from pg_publication_tables
                 where pubname='supabase_realtime' and schemaname='public' and tablename='order') then
    alter publication supabase_realtime add table public."order";
  end if;
end $$;

-- -----------------------------------------------------------------------------
-- 4. Materialized current-state columns (nullable now; constrained in §10)
-- -----------------------------------------------------------------------------
alter table public.drawer
  add column stage            text,
  add column stage_changed_at timestamptz,
  add column state            text not null default 'active'
             check (state in ('active','on_hold','rework','cancelled')),
  add column state_changed_at timestamptz,
  add column state_reason     text;

alter table public."order"
  add column computed_status            text,
  add column computed_status_changed_at timestamptz,
  add column manual_status              text,
  add column manual_status_reason       text,
  add column manual_status_by           uuid,
  add column manual_status_at           timestamptz,
  add column state                      text not null default 'active'
             check (state in ('active','on_hold','cancelled')),
  add column state_changed_at           timestamptz,
  add column state_reason               text,
  add column delivery_scheduled_at      timestamptz;

comment on column public."order".computed_status is
  'Pure derivation from drawer stages (recompute_order_status). Effective status = coalesce(manual_status, computed_status).';
comment on column public."order".delivery_scheduled_at is
  'Operational metadata — scheduling is NOT a lifecycle stage. Customer step 6 renders "Ready — delivery scheduled" when set.';

-- -----------------------------------------------------------------------------
-- 5. Helpers
-- -----------------------------------------------------------------------------
create or replace function public.map_legacy_drawer_status(p public.drawer_status)
returns text language sql immutable set search_path = public as $$
  select case p
    when 'backlogged_by_admin'     then 'backlog'
    when 'created_by_user'         then 'scanned'
    when 'received_by_tidydesk'    then 'design_queue'
    when 'processed_by_tidydesk'   then 'designed'
    when 'approved_by_qualityctrl' then 'qc_passed'
    when 'received_by_fabricator'  then 'in_production'
  end;
$$;

create or replace function public.map_stage_to_legacy(p_stage text)
returns public.drawer_status language sql immutable set search_path = public as $$
  select case p_stage
    when 'backlog'       then 'backlogged_by_admin'::public.drawer_status
    when 'scanned'       then 'created_by_user'::public.drawer_status
    when 'design_queue'  then 'received_by_tidydesk'::public.drawer_status
    when 'designed'      then 'processed_by_tidydesk'::public.drawer_status
    when 'qc_passed'     then 'approved_by_qualityctrl'::public.drawer_status
    when 'in_production' then 'received_by_fabricator'::public.drawer_status
    else null
  end;
$$;

create or replace function public.status_sort(p_domain text, p_code text)
returns int language sql stable set search_path = public as $$
  select sort_order from public.status_def where domain = p_domain and code = p_code;
$$;

-- Single sanctioned writer for status_event.
-- Hardened attribution: actor, actor_name, actor_role and created_at are ALWAYS
-- derived server-side; when drawer_id is given, order_id is ALWAYS derived from
-- the drawer row (callers cannot attach events to a foreign order). p_source is
-- caller-declared but only reachable from is_staff()-gated RPCs / triggers, so a
-- customer can never emit staff/tidycam/tidycad-attributed events.
create or replace function public.record_status_event(
  p_domain text, p_field text, p_kind text,
  p_order_id uuid, p_drawer_id uuid,
  p_from text, p_to text, p_source text,
  p_note text default null, p_payload jsonb default null,
  p_idempotency_key text default null
) returns void language plpgsql security definer set search_path = public as $$
declare
  v_order_id uuid := p_order_id;
begin
  if p_drawer_id is not null then
    select order_id into v_order_id from public.drawer where id = p_drawer_id;
  end if;
  if p_field = 'stage' and p_to is not null then
    if not exists (select 1 from public.status_def where domain = p_domain and code = p_to) then
      raise exception 'unknown % status code: %', p_domain, p_to;
    end if;
  end if;
  insert into public.status_event
    (order_id, drawer_id, domain, field, kind, from_status, to_status,
     actor, actor_name, actor_role, source, note, payload, idempotency_key)
  values (
    v_order_id, p_drawer_id, p_domain, p_field, p_kind, p_from, p_to,
    auth.uid(),
    nullif(auth.jwt() ->> 'email', ''),
    case when public.is_admin() then 'admin'
         when public.is_staff() then 'staff'
         when auth.uid() is not null then 'customer'
         else 'system' end,
    p_source, p_note, p_payload, p_idempotency_key
  );
end $$;

-- -----------------------------------------------------------------------------
-- 6. recompute_order_status — DETERMINISTIC derivation (review point 4).
--
-- Definitions: active drawers = state <> 'cancelled'. rank = status_def.sort_order.
-- Rule, evaluated top-down:
--   R0 no active drawers                          -> 'received'
--   R1 all active delivered                       -> 'delivered'
--   R2 all active rank >= ready(100)              -> 'ready'
--   R3 any active rank >= in_production(80)       -> 'production'
--   R4 ALL active rank >= approved(70)             -> 'approved'
--   R5 any active CURRENTLY at awaiting_approval   -> 'awaiting_approval'
--   R6 any active rank >= design_queue(30)         -> 'design'
--   R7 any active rank >= scanned(20)              -> 'scanning'
--   R8 otherwise (all backlog)                     -> 'received'
-- Semantics (finalized after 2026-07-27 second review): bands asserting a
-- WHOLE-ORDER fact (delivered, ready, approved) require ALL active drawers;
-- 'production' is any-entered because manufacturing has factually begun;
-- 'awaiting_approval' requires a drawer currently awaiting the customer.
-- This prevents approved/approved/designed from overstating as step 5.
-- Truth table (review's cases):
--   approved/approved/designed            -> design     (R6 — not overstated)
--   production/production/awaiting_appr.  -> production (R3; blocker surfaced separately)
--   delivered/delivered/designed+rework   -> production (R3 via delivered ranks; blocker=rework)
--   delivered/delivered/CANCELLED         -> delivered  (R1; cancelled excluded)
--   zero drawers                          -> received   (R0)
--   delivered order + new scanned drawer  -> production (R1 fails; legitimate
--     computed regression, evented kind='recompute')
-- computed_status may move both directions; every change is evented. Manual
-- overrides and order.state are NOT touched here (separate axes).
-- -----------------------------------------------------------------------------
create or replace function public.recompute_order_status(p_order_id uuid, p_source text default 'system', p_kind text default 'recompute')
returns void language plpgsql security definer set search_path = public as $$
declare
  v_cur text; v_new text;
  v_n int; v_min int; v_max int; v_n_delivered int; v_n_awaiting int;
begin
  select computed_status into v_cur from public."order" where id = p_order_id;
  if not found then return; end if;

  select count(*),
         min(public.status_sort('drawer', d.stage)),
         max(public.status_sort('drawer', d.stage)),
         count(*) filter (where d.stage = 'delivered'),
         count(*) filter (where d.stage = 'awaiting_approval')
    into v_n, v_min, v_max, v_n_delivered, v_n_awaiting
    from public.drawer d
   where d.order_id = p_order_id and d.state <> 'cancelled';

  v_new := case
    when v_n = 0                 then 'received'
    when v_n_delivered = v_n     then 'delivered'
    when v_min >= 100            then 'ready'
    when v_max >= 80             then 'production'
    when v_min >= 70             then 'approved'
    when v_n_awaiting > 0        then 'awaiting_approval'
    when v_max >= 30             then 'design'
    when v_max >= 20             then 'scanning'
    else 'received'
  end;

  if v_new is distinct from v_cur then
    update public."order"
       set computed_status = v_new, computed_status_changed_at = now()
     where id = p_order_id;
    perform public.record_status_event('order','stage', p_kind, p_order_id, null, v_cur, v_new, p_source);
  end if;
end $$;

-- -----------------------------------------------------------------------------
-- 7. Backfill (runs BEFORE triggers exist -> no double-firing).
--    Provenance (review point 10): every backfilled event carries
--    payload.inferred + payload.basis so analytics can separate measured
--    history from reconstruction.
-- -----------------------------------------------------------------------------
-- 7a. Seed drawer.stage from the legacy enum; state defaults to 'active'
update public.drawer
   set stage = coalesce(public.map_legacy_drawer_status(status), 'scanned'),
       stage_changed_at = created_at
 where stage is null;

-- 7b. Preview sent & approval pending -> awaiting_approval
update public.drawer d
   set stage = 'awaiting_approval'
 where d.design_preview_url is not null
   and d.customer_approval_status = 'pending'
   and public.status_sort('drawer', d.stage) < 60;

-- 7c. Customer approved -> approved (approved_at is a MEASURED timestamp)
update public.drawer d
   set stage = 'approved',
       stage_changed_at = coalesce(d.approved_at, d.stage_changed_at)
 where d.customer_approval_status = 'approved'
   and public.status_sort('drawer', d.stage) < 70;

-- 7d. changes_requested -> rework STATE (stage untouched — separate axes)
update public.drawer d
   set state = 'rework', state_changed_at = now(), state_reason = 'backfill: customer requested changes'
 where d.customer_approval_status = 'changes_requested';

-- 7e. Delivered per drawer_event history (measured timestamps)
update public.drawer d
   set stage = 'delivered', stage_changed_at = ev.ts
  from (select drawer_id, max(created_at) as ts
          from public.drawer_event where event_type = 'delivered' group by 1) ev
 where ev.drawer_id = d.id;

-- 7f. Historical events (direct inserts; created_at explicit is acceptable here
--     and ONLY here — record_status_event never accepts caller timestamps)
insert into public.status_event (order_id, drawer_id, domain, field, kind, from_status, to_status, source, payload, created_at)
select o.id, null, 'order','stage','backfill', null, 'received', 'backfill',
       jsonb_build_object('inferred', true, 'basis', 'order.created_at'), o.created_at
  from public."order" o;

insert into public.status_event (order_id, drawer_id, domain, field, kind, from_status, to_status, source, payload, created_at)
select d.order_id, d.id, 'drawer','stage','backfill', null, 'scanned', 'backfill',
       jsonb_build_object('inferred', true, 'basis', 'drawer.created_at'), d.created_at
  from public.drawer d;

insert into public.status_event (order_id, drawer_id, domain, field, kind, from_status, to_status, source, note, payload, created_at)
select d.order_id, d.id, 'drawer','stage','backfill', 'awaiting_approval', 'approved', 'backfill',
       'customer approval', jsonb_build_object('inferred', false, 'basis', 'drawer.approved_at'), d.approved_at
  from public.drawer d
 where d.customer_approval_status = 'approved' and d.approved_at is not null;

insert into public.status_event (order_id, drawer_id, domain, field, kind, from_status, to_status, source, note, payload, created_at)
select d.order_id, e.drawer_id, 'drawer',
       case e.event_type when 'changes_requested' then 'state' else 'stage' end,
       'backfill', null,
       case e.event_type when 'design_uploaded' then 'awaiting_approval'
                         when 'changes_requested' then 'rework'
                         when 'delivered' then 'delivered' end,
       'backfill', 'from drawer_event: ' || e.event_type,
       jsonb_build_object('inferred', false, 'basis', 'drawer_event.created_at', 'drawer_event_id', e.id),
       e.created_at
  from public.drawer_event e
  join public.drawer d on d.id = e.drawer_id
 where e.event_type in ('design_uploaded','changes_requested','delivered');

-- 7g. Derive every order's computed_status
do $$
declare r record;
begin
  for r in select id from public."order" loop
    perform public.recompute_order_status(r.id, 'backfill', 'backfill');
  end loop;
end $$;

update public."order"
   set computed_status = 'received', computed_status_changed_at = created_at
 where computed_status is null;

-- -----------------------------------------------------------------------------
-- 8. Triggers — bridge + maintenance (created AFTER backfill)
-- -----------------------------------------------------------------------------
create or replace function public.drawer_stage_bridge()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_mapped text;
  v_cur_sort int;
begin
  if tg_op = 'INSERT' then
    new.stage := coalesce(new.stage, public.map_legacy_drawer_status(new.status), 'scanned');
    if not exists (select 1 from public.status_def where domain='drawer' and code=new.stage) then
      raise exception 'unknown drawer stage: %', new.stage;
    end if;
    new.stage_changed_at := coalesce(new.stage_changed_at, now());
    new.state := coalesce(new.state, 'active');
    return new;
  end if;

  -- DB-enforced code validity for ANY write path (review point 11)
  if new.stage is distinct from old.stage then
    if not exists (select 1 from public.status_def where domain='drawer' and code=new.stage) then
      raise exception 'unknown drawer stage: %', new.stage;
    end if;
    new.stage_changed_at := now();   -- explicit setter (RPC) records its own event
  end if;
  if new.state is distinct from old.state then
    new.state_changed_at := now();
  end if;

  -- Legacy enum write with stage untouched by the writer -> bridge.
  -- ADVANCES only: legacy regressions are ignored (accidental-regression guard);
  -- real corrections go through set_drawer_stage(p_correction => true).
  if new.status is distinct from old.status and new.stage is not distinct from old.stage then
    v_cur_sort := coalesce(public.status_sort('drawer', old.stage), 0);
    v_mapped := public.map_legacy_drawer_status(new.status);
    if v_mapped is not null and coalesce(public.status_sort('drawer', v_mapped), 0) > v_cur_sort then
      new.stage := v_mapped;
      new.stage_changed_at := now();
      perform public.record_status_event('drawer','stage','bridge', new.order_id, new.id,
        old.stage, v_mapped, 'bridge', 'legacy drawer_status write: ' || new.status::text);
    end if;
  end if;

  -- Approval mechanic -> stage/state (separate axes, review point 1)
  if new.customer_approval_status is distinct from old.customer_approval_status then
    if new.customer_approval_status = 'approved'
       and coalesce(public.status_sort('drawer', new.stage), 0) < 70 then
      perform public.record_status_event('drawer','stage','bridge', new.order_id, new.id,
        new.stage, 'approved', 'bridge', 'customer approved design');
      new.stage := 'approved'; new.stage_changed_at := now();
      if new.state = 'rework' then
        perform public.record_status_event('drawer','state','bridge', new.order_id, new.id,
          'rework', 'active', 'bridge', 'approval clears rework');
        new.state := 'active'; new.state_changed_at := now(); new.state_reason := null;
      end if;
    elsif new.customer_approval_status = 'changes_requested' and new.state <> 'rework' then
      perform public.record_status_event('drawer','state','bridge', new.order_id, new.id,
        new.state, 'rework', 'bridge', 'customer requested changes');
      new.state := 'rework'; new.state_changed_at := now();
      new.state_reason := 'customer requested changes';
    end if;
  end if;

  -- New/updated design preview while pending -> awaiting_approval (+ clears rework)
  -- new/updated preview while pending OR resolving a change request -> back to customer
  if new.design_preview_url is distinct from old.design_preview_url
     and new.design_preview_url is not null
     and new.customer_approval_status in ('pending','changes_requested') then
    if coalesce(public.status_sort('drawer', new.stage), 0) < 60 then
      perform public.record_status_event('drawer','stage','bridge', new.order_id, new.id,
        new.stage, 'awaiting_approval', 'bridge', 'design preview published');
      new.stage := 'awaiting_approval'; new.stage_changed_at := now();
    end if;
    if new.state = 'rework' then
      perform public.record_status_event('drawer','state','bridge', new.order_id, new.id,
        'rework', 'active', 'bridge', 'revised design published');
      new.state := 'active'; new.state_changed_at := now(); new.state_reason := null;
    end if;
  end if;

  return new;
end $$;

create trigger drawer_stage_bridge_ins before insert on public.drawer
  for each row execute function public.drawer_stage_bridge();
create trigger drawer_stage_bridge_upd before update on public.drawer
  for each row execute function public.drawer_stage_bridge();

create or replace function public.drawer_stage_after()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    perform public.record_status_event('drawer','stage','system', new.order_id, new.id,
      null, new.stage, 'bridge', 'drawer created');
  end if;
  if new.order_id is not null then
    perform public.recompute_order_status(new.order_id);
  end if;
  if tg_op = 'UPDATE' and old.order_id is not null and old.order_id is distinct from new.order_id then
    perform public.recompute_order_status(old.order_id);  -- drawer moved between orders
  end if;
  return null;
end $$;

create trigger drawer_stage_after_ins after insert on public.drawer
  for each row execute function public.drawer_stage_after();
create trigger drawer_stage_after_upd after update of stage, state, order_id on public.drawer
  for each row when (old.stage is distinct from new.stage
                  or old.state is distinct from new.state
                  or old.order_id is distinct from new.order_id)
  execute function public.drawer_stage_after();

create or replace function public.order_status_before_ins()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  new.computed_status := coalesce(new.computed_status, 'received');
  new.computed_status_changed_at := coalesce(new.computed_status_changed_at, now());
  new.state := coalesce(new.state, 'active');
  return new;
end $$;

create or replace function public.order_status_after_ins()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform public.record_status_event('order','stage','system', new.id, null,
    null, new.computed_status, 'bridge', 'order created');
  return null;
end $$;

create trigger order_status_before_ins before insert on public."order"
  for each row execute function public.order_status_before_ins();
create trigger order_status_after_ins after insert on public."order"
  for each row execute function public.order_status_after_ins();

-- -----------------------------------------------------------------------------
-- 9. RPCs
-- -----------------------------------------------------------------------------
-- Drawer lifecycle transition. Concurrency + idempotency (review point 8):
--  * row locked FOR UPDATE for the duration of the transition
--  * p_expected_stage: optimistic concurrency — rejects if stale (errcode 40001)
--  * p_idempotency_key: safe retries — a key already recorded returns silently
-- Transition legality (review points 2+3): must exist in status_transition
-- (kind advance|return) OR be an admin correction (p_correction + reason).
create or replace function public.set_drawer_stage(
  p_drawer_id uuid, p_stage text,
  p_expected_stage text default null,
  p_note text default null,
  p_source text default 'portal',
  p_payload jsonb default null,
  p_idempotency_key text default null,
  p_correction boolean default false
) returns void language plpgsql security definer set search_path = public as $$
declare
  v_old text; v_order uuid; v_kind text; v_legacy public.drawer_status;
begin
  if not public.is_staff() then
    raise exception 'staff role required' using errcode = '42501';
  end if;
  if not exists (select 1 from public.status_def where domain='drawer' and code=p_stage and is_active) then
    raise exception 'unknown drawer stage: %', p_stage;
  end if;
  if p_source not in ('tidycam','tidycad','portal') then
    raise exception 'invalid source: %', p_source;
  end if;

  if p_idempotency_key is not null and exists (
       select 1 from public.status_event where idempotency_key = p_idempotency_key) then
    return;  -- already applied; safe retry
  end if;

  select stage, order_id into v_old, v_order
    from public.drawer where id = p_drawer_id for update;
  if not found then raise exception 'drawer not found'; end if;

  if p_expected_stage is not null and v_old is distinct from p_expected_stage then
    raise exception 'stale transition: drawer is %, caller expected %', v_old, p_expected_stage
      using errcode = '40001';
  end if;
  if v_old = p_stage then return; end if;

  if p_correction then
    if not public.is_admin() then
      raise exception 'corrections require admin' using errcode = '42501';
    end if;
    if p_note is null or btrim(p_note) = '' then
      raise exception 'corrections require a reason note';
    end if;
    v_kind := 'correction';
  else
    select kind into v_kind from public.status_transition
     where domain='drawer' and from_code = v_old and to_code = p_stage;
    if not found then
      raise exception 'illegal transition % -> % (use a sanctioned transition or an admin correction)', v_old, p_stage;
    end if;
  end if;

  v_legacy := public.map_stage_to_legacy(p_stage);
  update public.drawer
     set stage = p_stage,
         status = coalesce(v_legacy, status)   -- mirror legacy during transition era
   where id = p_drawer_id;

  perform public.record_status_event('drawer','stage', v_kind, v_order, p_drawer_id,
    v_old, p_stage, p_source, p_note, p_payload, p_idempotency_key);
  -- order recompute runs via drawer_stage_after_upd
end $$;

-- Drawer blocker axis
create or replace function public.set_drawer_state(
  p_drawer_id uuid, p_state text,
  p_reason text default null,
  p_source text default 'portal',
  p_idempotency_key text default null
) returns void language plpgsql security definer set search_path = public as $$
declare v_old text; v_order uuid;
begin
  if not public.is_staff() then
    raise exception 'staff role required' using errcode = '42501';
  end if;
  if p_state not in ('active','on_hold','rework','cancelled') then
    raise exception 'unknown drawer state: %', p_state;
  end if;
  if p_idempotency_key is not null and exists (
       select 1 from public.status_event where idempotency_key = p_idempotency_key) then
    return;
  end if;
  select state, order_id into v_old, v_order from public.drawer where id = p_drawer_id for update;
  if not found then raise exception 'drawer not found'; end if;
  if v_old = p_state then return; end if;
  if p_state <> 'active' and (p_reason is null or btrim(p_reason) = '') then
    raise exception 'a reason is required for %', p_state;
  end if;

  update public.drawer
     set state = p_state,
         state_reason = case when p_state = 'active' then null else p_reason end
   where id = p_drawer_id;
  perform public.record_status_event('drawer','state','system', v_order, p_drawer_id,
    v_old, p_state, p_source, p_reason, null, p_idempotency_key);
end $$;

-- Order blocker axis (hold / cancel; cancellation retains ALL history)
create or replace function public.set_order_state(
  p_order_id uuid, p_state text, p_reason text default null, p_source text default 'portal'
) returns void language plpgsql security definer set search_path = public as $$
declare v_old text;
begin
  if not public.is_staff() then
    raise exception 'staff role required' using errcode = '42501';
  end if;
  if p_state not in ('active','on_hold','cancelled') then
    raise exception 'unknown order state: %', p_state;
  end if;
  select state into v_old from public."order" where id = p_order_id for update;
  if not found then raise exception 'order not found'; end if;
  if v_old = p_state then return; end if;
  if p_state <> 'active' and (p_reason is null or btrim(p_reason) = '') then
    raise exception 'a reason is required for %', p_state;
  end if;
  update public."order"
     set state = p_state, state_changed_at = now(),
         state_reason = case when p_state = 'active' then null else p_reason end
   where id = p_order_id;
  perform public.record_status_event('order','state','system', p_order_id, null, v_old, p_state, p_source, p_reason);
end $$;

-- Manual override with explicit lifecycle (review point 6): set with reason,
-- visible alongside computed_status, cleared explicitly (recompute continues
-- underneath the whole time and re-surfaces on clear).
create or replace function public.set_order_override(
  p_order_id uuid, p_status text, p_reason text default null
) returns void language plpgsql security definer set search_path = public as $$
declare v_old text;
begin
  if not public.is_staff() then
    raise exception 'staff role required' using errcode = '42501';
  end if;
  select manual_status into v_old from public."order" where id = p_order_id for update;
  if not found then raise exception 'order not found'; end if;

  if p_status is null then  -- clear/release the override
    update public."order"
       set manual_status = null, manual_status_reason = null,
           manual_status_by = null, manual_status_at = null
     where id = p_order_id;
    perform public.record_status_event('order','override','system', p_order_id, null,
      v_old, null, 'portal', coalesce(p_reason, 'override cleared'));
    perform public.recompute_order_status(p_order_id);
    return;
  end if;

  if not exists (select 1 from public.status_def where domain='order' and code=p_status and is_active) then
    raise exception 'unknown order status: %', p_status;
  end if;
  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'overrides require a reason';
  end if;
  update public."order"
     set manual_status = p_status, manual_status_reason = p_reason,
         manual_status_by = auth.uid(), manual_status_at = now()
   where id = p_order_id;
  perform public.record_status_event('order','override','system', p_order_id, null,
    v_old, p_status, 'portal', p_reason);
end $$;

-- Scheduling is metadata, not lifecycle (review point 7)
create or replace function public.set_delivery_schedule(
  p_order_id uuid, p_when timestamptz, p_note text default null
) returns void language plpgsql security definer set search_path = public as $$
declare v_old timestamptz;
begin
  if not public.is_staff() then
    raise exception 'staff role required' using errcode = '42501';
  end if;
  select delivery_scheduled_at into v_old from public."order" where id = p_order_id for update;
  if not found then raise exception 'order not found'; end if;
  update public."order" set delivery_scheduled_at = p_when where id = p_order_id;
  perform public.record_status_event('order','schedule','system', p_order_id, null,
    v_old::text, p_when::text, 'portal', p_note);
end $$;

-- Customer-scoped pizza tracker (partial-order aware, review point 5).
-- Anti-enumeration: unauthorized and nonexistent orders raise the SAME error.
create or replace function public.get_order_tracker(p_order_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_ok boolean;
  v_order record;
  v_effective text;
  v_current_step int;
  v_steps jsonb;
  v_blockers jsonb;
  v_completion jsonb;
begin
  v_ok := public.is_staff();
  if not v_ok then
    select exists (
      select 1
        from public."order" o
        join public.customer c on c.auth_user_id = (select auth.uid())
       where o.id = p_order_id
         and (o.customer_id = c.id
           or (c.organization_id is not null and o.organization_id = c.organization_id)
           or (c.organization_id is not null and o.customer_id in (
                 select c2.id from public.customer c2 where c2.organization_id = c.organization_id)))
    ) into v_ok;
  end if;

  select o.id, o.project_name, o.computed_status, o.manual_status, o.state, o.state_changed_at,
         o.delivery_scheduled_at, o.created_at
    into v_order from public."order" o where o.id = p_order_id;

  if not v_ok or not found then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  v_effective := coalesce(v_order.manual_status, v_order.computed_status);
  select customer_step into v_current_step
    from public.status_def where domain='order' and code = v_effective;

  select jsonb_build_object(
           'awaiting_approval', count(*) filter (where d.stage = 'awaiting_approval' and d.state = 'active'),
           'rework',            count(*) filter (where d.state = 'rework'),
           'on_hold',           count(*) filter (where d.state = 'on_hold'))
    into v_blockers
    from public.drawer d where d.order_id = p_order_id and d.state <> 'cancelled';

  select jsonb_build_object(
           'delivered', count(*) filter (where d.stage = 'delivered'),
           'total',     count(*))
    into v_completion
    from public.drawer d where d.order_id = p_order_id and d.state <> 'cancelled';

  with step_names(step, label) as (values
    (1,'Order received'), (2,'Scanned & measured'), (3,'Design in progress'),
    (4,'Awaiting your approval'), (5,'In production'),
    (6,'Ready for delivery'), (7,'Delivered & installed')),
  entered as (
    select sd.customer_step as step, min(se.created_at) as entered_at,
           bool_and(coalesce((se.payload->>'inferred')::boolean, false)) as inferred
      from public.status_event se
      join public.status_def sd on sd.domain = se.domain and sd.code = se.to_status
     where se.field = 'stage'
       and (se.order_id = p_order_id
            or se.drawer_id in (select id from public.drawer where order_id = p_order_id))
       and sd.customer_step is not null
     group by 1)
  select jsonb_agg(jsonb_build_object(
           'step', n.step, 'label', n.label,
           'state', case when n.step <  coalesce(v_current_step,1) then 'done'
                         when n.step =  coalesce(v_current_step,1) then
                           case when n.step = 7 then 'done' else 'current' end
                         else 'todo' end,
           'entered_at', case when n.step = 1 then coalesce(e.entered_at, v_order.created_at)
                              when n.step <= coalesce(v_current_step,1) then e.entered_at
                              else null end,
           'inferred', coalesce(e.inferred, false)
         ) order by n.step)
    into v_steps
    from step_names n left join entered e on e.step = n.step;

  return jsonb_build_object(
    'order_id', v_order.id,
    'project_name', v_order.project_name,
    'status', v_effective,
    'current_step', coalesce(v_current_step, 1),
    'exception', case when v_order.state <> 'active' then jsonb_build_object(
                        'state', v_order.state, 'since', v_order.state_changed_at)
                      else null end,
    'blockers', v_blockers,
    'completion', v_completion,
    'delivery_scheduled_at', v_order.delivery_scheduled_at,
    'steps', v_steps);
end $$;

-- Emilee's work queue (tidyCAD milestone): pipeline position AND blocker axis
create or replace function public.get_work_queue(p_include_done boolean default false)
returns table (
  drawer_id uuid, nickname text, photo_url text,
  stage text, stage_label text, stage_changed_at timestamptz, days_in_stage numeric,
  state text, state_reason text,
  blocked_on text,
  order_id uuid, project_name text, customer_name text,
  order_status text, order_state text
) language plpgsql security definer set search_path = public as $$
begin
  if not public.is_staff() then
    raise exception 'staff role required' using errcode = '42501';
  end if;
  return query
  select d.id, d.nickname, d.photo_url,
         d.stage, sd.label, d.stage_changed_at,
         round((extract(epoch from (now() - coalesce(d.stage_changed_at, d.created_at))) / 86400.0)::numeric, 1),
         d.state, d.state_reason,
         case when d.state = 'cancelled'            then 'none'
              when d.state = 'on_hold'              then 'hold'
              when d.state = 'rework'               then 'us'
              when d.stage = 'awaiting_approval'    then 'customer'
              when sd.is_terminal                   then 'none'
              else 'us' end,
         o.id, o.project_name, o.customer_name,
         coalesce(o.manual_status, o.computed_status), o.state
    from public.drawer d
    join public.status_def sd on sd.domain = 'drawer' and sd.code = d.stage
    left join public."order" o on o.id = d.order_id
   where (p_include_done or (not sd.is_terminal and d.state <> 'cancelled'))
     and coalesce(o.state, 'active') <> 'cancelled'
   order by (d.state = 'rework') desc,           -- rework first: customer is waiting
            coalesce(d.stage_changed_at, d.created_at) asc;
end $$;

-- Status pipeline rollup (NOTE: named get_status_pipeline — get_admin_pipeline() already exists in prod as the admin drawer-list RPC): position, blockers, aging, completion, cycle time
create or replace function public.get_status_pipeline(p_days int default 90)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_counts jsonb; v_aging jsonb; v_queue jsonb; v_cycle jsonb; v_blockers jsonb;
begin
  if not public.is_staff() then
    raise exception 'staff role required' using errcode = '42501';
  end if;

  select coalesce(jsonb_agg(t order by t.sort_order), '[]'::jsonb) into v_counts
    from (select coalesce(o.manual_status, o.computed_status) as status,
                 sd.label, sd.sort_order, sd.customer_step, count(*) as n
            from public."order" o
            join public.status_def sd on sd.domain='order' and sd.code = coalesce(o.manual_status, o.computed_status)
           where o.state = 'active' and not sd.is_terminal
           group by 1,2,3,4) t;

  select jsonb_build_object(
           'drawers_awaiting_customer', (select count(*) from public.drawer d
              join public."order" o on o.id = d.order_id
              where d.stage='awaiting_approval' and d.state='active' and o.state='active'),
           'drawers_rework',  (select count(*) from public.drawer where state='rework'),
           'drawers_on_hold', (select count(*) from public.drawer where state='on_hold'),
           'orders_on_hold',  (select count(*) from public."order" where state='on_hold'),
           'orders_overridden', (select count(*) from public."order" where manual_status is not null))
    into v_blockers;

  select coalesce(jsonb_agg(t order by t.days_in_status desc), '[]'::jsonb) into v_aging
    from (select o.id, o.project_name, o.customer_name,
                 coalesce(o.manual_status, o.computed_status) as status,
                 sd.label,
                 (o.manual_status is not null) as overridden,
                 coalesce(o.manual_status_at, o.computed_status_changed_at) as status_changed_at,
                 round((extract(epoch from (now() - coalesce(o.manual_status_at, o.computed_status_changed_at, o.created_at))) / 86400.0)::numeric, 1) as days_in_status,
                 o.delivery_scheduled_at,
                 (select count(*) from public.drawer d where d.order_id = o.id and d.state <> 'cancelled') as drawer_total,
                 (select count(*) from public.drawer d where d.order_id = o.id and d.stage = 'delivered' and d.state <> 'cancelled') as drawer_delivered,
                 (select count(*) from public.drawer d where d.order_id = o.id and d.stage = 'awaiting_approval' and d.state = 'active') as blocked_on_customer,
                 (select count(*) from public.drawer d where d.order_id = o.id and d.state in ('rework','on_hold')) as blocked_internal
            from public."order" o
            join public.status_def sd on sd.domain='order' and sd.code = coalesce(o.manual_status, o.computed_status)
           where o.state = 'active' and not sd.is_terminal) t;

  select coalesce(jsonb_agg(t order by t.sort_order), '[]'::jsonb) into v_queue
    from (select d.stage, sd.label, sd.sort_order, count(*) as n
            from public.drawer d
            join public.status_def sd on sd.domain='drawer' and sd.code=d.stage
           where not sd.is_terminal and d.state <> 'cancelled'
           group by 1,2,3) t;

  -- Cycle time from MEASURED events only (backfill-inferred excluded)
  select jsonb_build_object(
           'window_days', p_days,
           'completed', count(*),
           'median_days', percentile_cont(0.5) within group (order by t.cycle_days))
    into v_cycle
    from (select extract(epoch from (fin.ts - o.created_at)) / 86400.0 as cycle_days
            from public."order" o
            join (select order_id, min(created_at) as ts
                    from public.status_event
                   where domain='order' and field='stage' and to_status='delivered'
                     and coalesce((payload->>'inferred')::boolean, false) = false
                   group by 1) fin on fin.order_id = o.id
           where fin.ts > now() - make_interval(days => p_days)) t;

  return jsonb_build_object(
    'counts', v_counts, 'blockers', v_blockers, 'aging', v_aging,
    'queue', v_queue, 'cycle', v_cycle);
end $$;

-- -----------------------------------------------------------------------------
-- 10. Constraints
-- -----------------------------------------------------------------------------
alter table public.drawer  alter column stage set not null,  alter column stage set default 'scanned';
alter table public."order" alter column computed_status set not null,
                           alter column computed_status set default 'received';

-- -----------------------------------------------------------------------------
-- 11. Grants — EXECUTE revoked from public/anon everywhere (house posture);
--     internal helpers additionally revoked from authenticated.
-- -----------------------------------------------------------------------------
revoke execute on function public.status_event_immutable()                       from public, anon, authenticated;
revoke execute on function public.record_status_event(text,text,text,uuid,uuid,text,text,text,text,jsonb,text) from public, anon, authenticated;
revoke execute on function public.recompute_order_status(uuid,text,text)         from public, anon, authenticated;
revoke execute on function public.drawer_stage_bridge()                          from public, anon, authenticated;
revoke execute on function public.drawer_stage_after()                           from public, anon, authenticated;
revoke execute on function public.order_status_before_ins()                      from public, anon, authenticated;
revoke execute on function public.order_status_after_ins()                       from public, anon, authenticated;
revoke execute on function public.map_legacy_drawer_status(public.drawer_status) from public, anon;
revoke execute on function public.map_stage_to_legacy(text)                      from public, anon;
revoke execute on function public.status_sort(text,text)                         from public, anon;

revoke execute on function public.set_drawer_stage(uuid,text,text,text,text,jsonb,text,boolean) from public, anon;
revoke execute on function public.set_drawer_state(uuid,text,text,text,text)     from public, anon;
revoke execute on function public.set_order_state(uuid,text,text,text)           from public, anon;
revoke execute on function public.set_order_override(uuid,text,text)             from public, anon;
revoke execute on function public.set_delivery_schedule(uuid,timestamptz,text)   from public, anon;
revoke execute on function public.get_order_tracker(uuid)                        from public, anon;
revoke execute on function public.get_work_queue(boolean)                        from public, anon;
revoke execute on function public.get_status_pipeline(int)                        from public, anon;

grant execute on function public.record_status_event(text,text,text,uuid,uuid,text,text,text,text,jsonb,text) to service_role;
grant execute on function public.recompute_order_status(uuid,text,text)          to service_role;
grant execute on function public.set_drawer_stage(uuid,text,text,text,text,jsonb,text,boolean) to authenticated, service_role;
grant execute on function public.set_drawer_state(uuid,text,text,text,text)      to authenticated, service_role;
grant execute on function public.set_order_state(uuid,text,text,text)            to authenticated, service_role;
grant execute on function public.set_order_override(uuid,text,text)              to authenticated, service_role;
grant execute on function public.set_delivery_schedule(uuid,timestamptz,text)    to authenticated, service_role;
grant execute on function public.get_order_tracker(uuid)                         to authenticated, service_role;
grant execute on function public.get_work_queue(boolean)                         to authenticated, service_role;
grant execute on function public.get_status_pipeline(int)                         to authenticated, service_role;
grant execute on function public.status_sort(text,text)                          to authenticated, service_role;
