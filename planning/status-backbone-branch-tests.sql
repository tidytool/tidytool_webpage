-- =============================================================================
-- status-backbone-branch-tests.sql
-- Deterministic DB tests for 20260727100000_status_backbone.sql.
-- RESULT 2026-07-27: ALL PASSED (T0-T18) on branch status-backbone-test.
-- NOTE: drawer.id has NO default in prod (tidyCAM generates ids) — fixtures pass explicit ids.
-- RUN ON A DISPOSABLE SUPABASE BRANCH (never prod): creates fake auth users,
-- orders and drawers; run whole file in one session; everything is asserted —
-- the script RAISES on the first failure and prints 'ALL TESTS PASSED' at end.
-- Covers (per 2026-07-27 design review): transition rules, corrections,
-- optimistic concurrency, idempotent retries, bridge advance/regression-guard,
-- approval loop (state axis), recompute truth table incl. partial cancellation
-- & late-added drawers, override lifecycle, zero-drawer orders, customer
-- isolation/anti-enumeration, event immutability.
-- =============================================================================

-- ---------- test principals ----------
insert into auth.users (id, instance_id, aud, role, email)
values
  ('00000000-0000-0000-0000-00000000aaaa','00000000-0000-0000-0000-000000000000','authenticated','authenticated','staff-test@test.local'),
  ('00000000-0000-0000-0000-00000000bbbb','00000000-0000-0000-0000-000000000000','authenticated','authenticated','admin-test@test.local'),
  ('00000000-0000-0000-0000-00000000cccc','00000000-0000-0000-0000-000000000000','authenticated','authenticated','customer-a@test.local'),
  ('00000000-0000-0000-0000-00000000dddd','00000000-0000-0000-0000-000000000000','authenticated','authenticated','customer-b@test.local')
on conflict (id) do nothing;

insert into public.user_roles (user_id, role) values
  ('00000000-0000-0000-0000-00000000aaaa','staff'),
  ('00000000-0000-0000-0000-00000000bbbb','admin')
on conflict do nothing;

insert into public.customer (id, name, email, auth_user_id) values
  ('00000000-0000-0000-0000-0000000000c1','Customer A','customer-a@test.local','00000000-0000-0000-0000-00000000cccc'),
  ('00000000-0000-0000-0000-0000000000c2','Customer B','customer-b@test.local','00000000-0000-0000-0000-00000000dddd')
on conflict (id) do nothing;

-- jwt helpers: simulate a signed-in user for auth.uid()/auth.jwt()
create or replace procedure test_as(p_uuid text, p_email text) language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', p_uuid, 'email', p_email, 'role', 'authenticated')::text, false);
end $$;
create or replace procedure test_as_nobody() language plpgsql as $$
begin
  perform set_config('request.jwt.claims', '', false);
end $$;

-- ---------- fixtures ----------
insert into public."order" (id, customer_name, project_name, customer_id)
values ('00000000-0000-0000-0000-0000000000e1','Test Co','T1 main', '00000000-0000-0000-0000-0000000000c1'),
       ('00000000-0000-0000-0000-0000000000e2','Other Co','T2 other','00000000-0000-0000-0000-0000000000c2'),
       ('00000000-0000-0000-0000-0000000000e3','Empty Co','T3 empty','00000000-0000-0000-0000-0000000000c1');

insert into public.drawer (id, order_id, nickname, status)
values ('00000000-0000-0000-0000-0000000000d1','00000000-0000-0000-0000-0000000000e1','d1','created_by_user'),
       ('00000000-0000-0000-0000-0000000000d2','00000000-0000-0000-0000-0000000000e1','d2','created_by_user'),
       ('00000000-0000-0000-0000-0000000000d3','00000000-0000-0000-0000-0000000000e1','d3','created_by_user'),
       ('00000000-0000-0000-0000-0000000000d4','00000000-0000-0000-0000-0000000000e2','d4','created_by_user');

do $$
declare v text; n int; ts1 timestamptz; ex boolean;
  o1 uuid := '00000000-0000-0000-0000-0000000000e1';
  o2 uuid := '00000000-0000-0000-0000-0000000000e2';
  o3 uuid := '00000000-0000-0000-0000-0000000000e3';
  d1 uuid := '00000000-0000-0000-0000-0000000000d1';
  d2 uuid := '00000000-0000-0000-0000-0000000000d2';
  d3 uuid := '00000000-0000-0000-0000-0000000000d3';
  d4 uuid := '00000000-0000-0000-0000-0000000000d4';
begin
  -- T0: insert triggers — stage defaulted from legacy, events written, recompute ran
  select stage into v from drawer where id = d1;
  assert v = 'scanned', 'T0a stage seeded from legacy, got ' || v;
  select computed_status into v from "order" where id = o1;
  assert v = 'scanning', 'T0b computed=scanning, got ' || v;
  select computed_status into v from "order" where id = o3;
  assert v = 'received', 'T0c zero-drawer order = received, got ' || v;

  call test_as('00000000-0000-0000-0000-00000000aaaa','staff-test@test.local');

  -- T1: illegal transition rejected
  ex := false;
  begin
    perform set_drawer_stage(d1, 'delivered');
  exception when others then ex := true;
  end;
  assert ex, 'T1 scanned->delivered must be illegal';

  -- T2: legal advance chain + recompute truth table along the way
  perform set_drawer_stage(d1, 'design_queue', p_source => 'tidycad');
  perform set_drawer_stage(d2, 'design_queue', p_source => 'tidycad');
  perform set_drawer_stage(d3, 'design_queue', p_source => 'tidycad');
  select computed_status into v from "order" where id = o1;
  assert v = 'design', 'T2a design, got ' || v;

  perform set_drawer_stage(d1, 'designed');
  perform set_drawer_stage(d1, 'awaiting_approval');
  select computed_status into v from "order" where id = o1;
  assert v = 'awaiting_approval', 'T2b awaiting_approval, got ' || v;

  perform set_drawer_stage(d1, 'approved');
  perform set_drawer_stage(d1, 'in_production');
  select computed_status into v from "order" where id = o1;
  assert v = 'production', 'T2c any-in-production wins: production, got ' || v;

  -- T3: sanctioned return loop (approval rework)
  perform set_drawer_stage(d2, 'designed');
  perform set_drawer_stage(d2, 'awaiting_approval');
  perform set_drawer_stage(d2, 'designed');           -- return
  select kind into v from status_event
   where drawer_id = d2 and field='stage' and to_status='designed'
   order by created_at desc limit 1;
  assert v = 'return', 'T3 return kind recorded, got ' || v;

  -- T4: optimistic concurrency — stale expected stage rejected
  ex := false;
  begin
    perform set_drawer_stage(d2, 'awaiting_approval', p_expected_stage => 'design_queue');
  exception when sqlstate '40001' then ex := true;
  end;
  assert ex, 'T4 stale expected_stage must raise 40001';

  -- T5: idempotent retry — second call with same key is a no-op
  perform set_drawer_stage(d2, 'awaiting_approval', p_idempotency_key => 'test-idem-1');
  perform set_drawer_stage(d2, 'designed', p_idempotency_key => 'test-idem-1'); -- retried dup
  select stage into v from drawer where id = d2;
  assert v = 'awaiting_approval', 'T5a dup key must not re-apply, got ' || v;
  select count(*) into n from status_event where idempotency_key = 'test-idem-1';
  assert n = 1, 'T5b exactly one event for key, got ' || n;

  -- T6: corrections — staff blocked, admin without note blocked, admin+note ok
  ex := false;
  begin
    perform set_drawer_stage(d1, 'scanned', p_correction => true, p_note => 'oops');
  exception when sqlstate '42501' then ex := true;
  end;
  assert ex, 'T6a staff cannot correct';
  call test_as('00000000-0000-0000-0000-00000000bbbb','admin-test@test.local');
  ex := false;
  begin
    perform set_drawer_stage(d1, 'scanned', p_correction => true);
  exception when others then ex := true;
  end;
  assert ex, 'T6b correction requires note';
  perform set_drawer_stage(d1, 'scanned', p_correction => true, p_note => 'test correction');
  select kind into v from status_event
   where drawer_id = d1 and field='stage' order by created_at desc limit 1;
  assert v = 'correction', 'T6c correction kind recorded';
  perform set_drawer_stage(d1, 'design_queue');  -- restore forward
  perform set_drawer_stage(d1, 'designed');
  perform set_drawer_stage(d1, 'awaiting_approval');
  perform set_drawer_stage(d1, 'approved');
  perform set_drawer_stage(d1, 'in_production');

  -- T7: bridge — legacy ADVANCE applies, legacy REGRESSION ignored
  update drawer set status = 'processed_by_tidydesk' where id = d3;   -- tidyCAM-style write
  select stage into v from drawer where id = d3;
  assert v = 'designed', 'T7a bridge advance to designed, got ' || v;
  select count(*) into n from status_event
   where drawer_id = d3 and field='stage' and kind='bridge' and to_status='designed';
  assert n = 1, 'T7b bridge event recorded once';
  update drawer set status = 'created_by_user' where id = d3;         -- accidental regression
  select stage into v from drawer where id = d3;
  assert v = 'designed', 'T7c legacy regression ignored, got ' || v;

  -- T8: approval loop on the STATE axis — stage untouched by changes_requested
  update drawer set design_preview_url = 'https://x/p1.png' where id = d3;
  select stage into v from drawer where id = d3;
  assert v = 'awaiting_approval', 'T8a preview -> awaiting_approval, got ' || v;
  update drawer set customer_approval_status = 'changes_requested' where id = d3;
  select stage || '/' || state into v from drawer where id = d3;
  assert v = 'awaiting_approval/rework', 'T8b rework is state not stage, got ' || v;
  update drawer set design_preview_url = 'https://x/p2.png' where id = d3;
  select stage || '/' || state into v from drawer where id = d3;
  assert v = 'awaiting_approval/active', 'T8c republish clears rework, got ' || v;
  update drawer set customer_approval_status = 'approved' where id = d3;
  select stage into v from drawer where id = d3;
  assert v = 'approved', 'T8d approval advances stage, got ' || v;

  -- T9: truth table — delivered/delivered/rework-ish mix
  perform set_drawer_stage(d1, 'ready');
  perform set_drawer_stage(d1, 'delivered');
  perform set_drawer_stage(d3, 'in_production');
  perform set_drawer_stage(d3, 'ready');
  perform set_drawer_stage(d3, 'delivered');
  select computed_status into v from "order" where id = o1;  -- d2 still awaiting
  assert v = 'production', 'T9a 2 delivered + 1 awaiting = production, got ' || v;
  select (get_order_tracker(o1)->'blockers'->>'awaiting_approval')::int into n;
  assert n = 1, 'T9b tracker surfaces 1 customer blocker, got ' || n;
  select (get_order_tracker(o1)->'completion'->>'delivered')::int into n;
  assert n = 2, 'T9c completion 2 delivered, got ' || n;

  -- T10: partial cancellation — cancelled drawer excluded from aggregation
  perform set_drawer_state(d2, 'cancelled', 'customer dropped this drawer');
  select computed_status into v from "order" where id = o1;
  assert v = 'delivered', 'T10 all remaining delivered = delivered, got ' || v;
  select count(*) into n from status_event where drawer_id = d2;  -- history retained
  assert n >= 3, 'T10b cancellation retains history';

  -- T11: late-added drawer legitimately regresses computed status (evented)
  insert into drawer (id, order_id, nickname, status)
  values ('00000000-0000-0000-0000-0000000000d5', o1, 'd5-late', 'created_by_user');
  select computed_status into v from "order" where id = o1;
  assert v = 'production', 'T11a late drawer regresses delivered->production, got ' || v;
  select count(*) into n from status_event
   where order_id = o1 and field='stage' and kind='recompute'
     and from_status='delivered' and to_status='production';
  assert n = 1, 'T11b regression is evented';

  -- T12: override lifecycle — reasoned set, effective status, explicit clear
  ex := false;
  begin
    perform set_order_override(o1, 'closed');
  exception when others then ex := true;
  end;
  assert ex, 'T12a override requires reason';
  perform set_order_override(o1, 'closed', 'test: customer paid, done');
  select (get_order_tracker(o1)->>'status') into v;
  assert v = 'closed', 'T12b effective status = override, got ' || v;
  select computed_status into v from "order" where id = o1;
  assert v = 'production', 'T12c computed preserved under override, got ' || v;
  perform set_order_override(o1, null, 'test: reopening');
  select (get_order_tracker(o1)->>'status') into v;
  assert v = 'production', 'T12d clear resurfaces computed, got ' || v;

  -- T13: scheduling is metadata — no lifecycle transition
  select count(*) into n from status_event where order_id = o1 and field = 'stage';
  ts1 := now();
  perform set_delivery_schedule(o1, ts1 + interval '3 days', 'test schedule');
  perform set_delivery_schedule(o1, ts1 + interval '5 days', 'rescheduled');
  select count(*) - n into n from status_event where order_id = o1 and field = 'stage';
  assert n = 0, 'T13 scheduling created stage transitions: ' || n;

  -- T14: customer isolation + anti-enumeration
  call test_as('00000000-0000-0000-0000-00000000cccc','customer-a@test.local');
  select (get_order_tracker(o1)->>'order_id') into v;   -- own order: ok
  assert v is not null, 'T14a customer reads own tracker';
  ex := false;
  begin
    perform get_order_tracker(o2);                       -- other customer's order
  exception when sqlstate '42501' then ex := true;
  end;
  assert ex, 'T14b cross-customer tracker read must fail';
  ex := false;
  begin
    perform get_order_tracker('00000000-0000-0000-0000-00000000ffff'); -- nonexistent
  exception when sqlstate '42501' then ex := true;
  end;
  assert ex, 'T14c nonexistent order must raise the SAME error (anti-enumeration)';
  ex := false;
  begin
    perform set_drawer_stage(d4, 'design_queue');        -- customer can't transition
  exception when sqlstate '42501' then ex := true;
  end;
  assert ex, 'T14d customer cannot call set_drawer_stage';

  -- T15: event immutability (application-path; owner can still drop triggers — documented)
  ex := false;
  begin
    update status_event set note = 'tamper' where order_id = o1;
  exception when others then ex := true;
  end;
  assert ex, 'T15a update blocked';
  ex := false;
  begin
    delete from status_event where order_id = o1;
  exception when others then ex := true;
  end;
  assert ex, 'T15b delete blocked';

  -- T16: ATOMICITY — every failed call leaves ZERO side effects
  -- (plpgsql raises roll back the RPC's subtransaction: no row change, no event,
  --  no legacy mirror change, no recompute)
  call test_as('00000000-0000-0000-0000-00000000aaaa','staff-test@test.local');
  select count(*) into n from status_event;
  select stage || '/' || status::text || '/' || state into v from drawer where id = d4;
  begin perform set_drawer_stage(d4, 'delivered');                    exception when others then null; end;
  begin perform set_drawer_stage(d4, 'design_queue', p_expected_stage => 'cut'); exception when others then null; end;
  begin perform set_drawer_stage(d4, 'backlog', p_correction => true, p_note => 'x'); exception when others then null; end; -- staff, not admin
  begin perform set_drawer_state(d4, 'on_hold');                      exception when others then null; end; -- missing reason
  begin perform set_order_override(o2, 'closed');                     exception when others then null; end; -- missing reason
  assert (select count(*) from status_event) = n,
    'T16a failed calls must write no events';
  assert (select stage || '/' || status::text || '/' || state from drawer where id = d4) = v,
    'T16b failed calls must not touch the drawer row';

  -- T17: successful transition writes EXACTLY its own event set, atomically:
  -- 1 drawer stage event + (recompute event only if order position changed)
  select count(*) into n from status_event;
  perform set_drawer_stage(d4, 'design_queue');   -- o2: scanning -> design
  assert (select count(*) from status_event) = n + 2,
    'T17a expected exactly 2 events (stage + recompute), got ' || ((select count(*) from status_event) - n);
  assert (select computed_status from "order" where id = o2) = 'design', 'T17b o2 recomputed to design';
  select count(*) into n from status_event;
  perform set_drawer_stage(d4, 'designed');       -- o2 position unchanged (design)
  assert (select count(*) from status_event) = n + 1,
    'T17c expected exactly 1 event (stage only), got ' || ((select count(*) from status_event) - n);

  raise notice 'ALL TESTS PASSED';
end $$;

-- T18 (run OUT-OF-BAND, as two separate transactions — see runbook):
--   tx1:  begin; select set_drawer_stage('<d4>', 'qc_passed'); rollback;
--   tx2:  assert drawer.stage still 'designed' AND no qc_passed event exists.
-- Proves the whole write set (row + events + recompute) rides ONE transaction
-- with no autonomous/out-of-band writes surviving a rollback.
