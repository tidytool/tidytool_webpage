-- Remote capture queue: RLS, grant and state-machine tests (migrations 20261023120000, 20261023130000).
-- Contract: planning/remote-reconstruction-contract.md section 10 "Dev verification".
--
-- DEV ONLY. Run:  python3 tools/db_test.py portal/supabase/tests/remote_capture_rls_test.sql
-- One transaction: fixtures (auth users, roles, customers, orders, drawers, storage objects)
-- are created inside it and everything is ROLLED BACK at the end, so nothing is left on dev.
-- Roles are simulated with set_config('role', ...) + request.jwt.claims (set local semantics).
-- Returns one row per assertion: (n, test, ok, detail).
--
-- Not covered here (needs two concurrent sessions): concurrent claim_next_capture handing
-- out different rows, and concurrent create_capture/complete_capture without 40P01.

begin;

-- ---------------------------------------------------------------- harness
create temp table _r (n serial, test text, ok boolean, detail text) on commit drop;
grant all on _r to public;
grant all on sequence _r_n_seq to public;

-- Switch the simulated caller: a uuid => authenticated user with that sub; null => anon;
-- 'postgres' semantics via pg_temp.as_admin().
create function pg_temp.as_user(p uuid) returns void language plpgsql as $f$
begin
  perform set_config('role', 'postgres', true);
  if p is null then
    perform set_config('request.jwt.claims', '{"role":"anon"}', true);
    perform set_config('role', 'anon', true);
  else
    perform set_config('request.jwt.claims',
      json_build_object('sub', p, 'role', 'authenticated', 'email', p::text || '@test.invalid')::text, true);
    perform set_config('role', 'authenticated', true);
  end if;
end $f$;

create function pg_temp.as_admin() returns void language plpgsql as $f$
begin
  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claims', '', true);
end $f$;

-- Run p_sql; pass when it raises p_state (null = must not raise).
create function pg_temp.expect(p_test text, p_sql text, p_state text default null)
returns void language plpgsql as $f$
declare v_state text; v_msg text;
begin
  begin
    execute p_sql;
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
  end;
  insert into pg_temp._r (test, ok, detail)
  values (p_test, v_state is not distinct from p_state,
          'want ' || coalesce(p_state, 'no error') || ', got ' || coalesce(v_state || ' ' || v_msg, 'no error'));
end $f$;

-- Run p_sql (first column of first row, as text); pass when it equals p_want.
create function pg_temp.is(p_test text, p_sql text, p_want text)
returns void language plpgsql as $f$
declare v text; v_state text; v_msg text;
begin
  begin
    execute p_sql into v;
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
  end;
  insert into pg_temp._r (test, ok, detail)
  values (p_test, v_state is null and v is not distinct from p_want,
          'want ' || coalesce(p_want, 'null') || ', got '
          || coalesce(v_state || ' ' || v_msg, coalesce(v, 'null')));
end $f$;

-- Upload n frames (+ manifest) under <drawer>/<capture>/ as the current caller.
create function pg_temp.upload(d uuid, c uuid, n int default 20) returns void language sql as $f$
  insert into storage.objects (bucket_id, name, owner, owner_id)
  select 'scan_frames', d::text || '/' || c::text || '/frames/frame_' || lpad(i::text, 4, '0') || '.jpg',
         auth.uid(), auth.uid()::text
    from generate_series(1, n) i
  union all
  select 'scan_frames', d::text || '/' || c::text || '/manifest.json', auth.uid(), auth.uid()::text;
$f$;

-- Make capture c the oldest queued row so claim_next_capture picks it deterministically.
create function pg_temp.front(c uuid) returns void language sql as $f$
  update public.capture set created_at = '2000-01-01' where id = c;
$f$;
-- Simulate a stale claim (heartbeat older than 3 min).
create function pg_temp.stale(c uuid) returns void language sql as $f$
  update public.capture set heartbeat_at = now() - interval '4 minutes' where id = c;
$f$;

-- ---------------------------------------------------------------- fixtures (as postgres)
-- Users: A = customer, B = another customer, S = staff, W = worker.
insert into auth.users (id, email, aud, role) values
  ('00000000-0000-4000-8000-0000000000a1', 'cap-test-a@test.invalid', 'authenticated', 'authenticated'),
  ('00000000-0000-4000-8000-0000000000b1', 'cap-test-b@test.invalid', 'authenticated', 'authenticated'),
  ('00000000-0000-4000-8000-0000000000c1', 'cap-test-s@test.invalid', 'authenticated', 'authenticated'),
  ('00000000-0000-4000-8000-0000000000e1', 'cap-test-w@test.invalid', 'authenticated', 'authenticated');
insert into public.user_roles (user_id, role) values
  ('00000000-0000-4000-8000-0000000000c1', 'staff'),
  ('00000000-0000-4000-8000-0000000000e1', 'worker');
insert into public.customer (id, name, email, auth_user_id) values
  ('10000000-0000-4000-8000-0000000000a1', 'Cap Test A', 'cap-test-a@test.invalid', '00000000-0000-4000-8000-0000000000a1'),
  ('10000000-0000-4000-8000-0000000000b1', 'Cap Test B', 'cap-test-b@test.invalid', '00000000-0000-4000-8000-0000000000b1');
insert into public."order" (id, project_name, customer_name, customer_email, customer_id, created_by) values
  ('20000000-0000-4000-8000-0000000000a1', 'cap-test A', 'Cap Test A', 'cap-test-a@test.invalid',
   '10000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000c1'),
  ('20000000-0000-4000-8000-0000000000b1', 'cap-test B', 'Cap Test B', 'cap-test-b@test.invalid',
   '10000000-0000-4000-8000-0000000000b1', '00000000-0000-4000-8000-0000000000c1');
-- dA: staff pre-created at backlog (section 5.3); dA2: created by A with a photo already;
-- dA3: staff-created, no photo; dB: B's order.
insert into public.drawer (id, order_id, created_by, nickname, status, stage, photo_url) values
  ('30000000-0000-4000-8000-0000000000a1', '20000000-0000-4000-8000-0000000000a1',
   '00000000-0000-4000-8000-0000000000c1', 'cap-test dA', 'backlogged_by_admin', 'backlog', null),
  ('30000000-0000-4000-8000-0000000000a2', '20000000-0000-4000-8000-0000000000a1',
   '00000000-0000-4000-8000-0000000000a1', 'cap-test dA2', 'created_by_user', null, 'https://pre.invalid/photo.png'),
  ('30000000-0000-4000-8000-0000000000a3', '20000000-0000-4000-8000-0000000000a1',
   '00000000-0000-4000-8000-0000000000c1', 'cap-test dA3', 'created_by_user', null, null),
  ('30000000-0000-4000-8000-0000000000b1', '20000000-0000-4000-8000-0000000000b1',
   '00000000-0000-4000-8000-0000000000c1', 'cap-test dB', 'created_by_user', null, null),
  ('30000000-0000-4000-8000-0000000000a4', '20000000-0000-4000-8000-0000000000a1',
   '00000000-0000-4000-8000-0000000000c1', 'cap-test dA4', 'created_by_user', 'backlog', null);

select pg_temp.is('fixture: order A linked to customer A',
  $q$select customer_id::text from public."order" where id = '20000000-0000-4000-8000-0000000000a1'$q$,
  '10000000-0000-4000-8000-0000000000a1');
select pg_temp.is('fixture: dA starts at stage backlog',
  $q$select stage from public.drawer where id = '30000000-0000-4000-8000-0000000000a1'$q$, 'backlog');

-- ---------------------------------------------------------------- grants / shapes
select pg_temp.is('capture: client column grant excludes error/timings/worker/attempt columns',
  $q$select string_agg(column_name, ',' order by column_name) from information_schema.column_privileges
      where table_schema = 'public' and table_name = 'capture' and grantee = 'authenticated'
        and privilege_type = 'SELECT'$q$,
  'created_at,created_by,drawer_id,finished_at,frame_count,id,model_url,ortho_url,source,status,updated_at');
select pg_temp.is('capture: no INSERT/UPDATE/DELETE privilege for authenticated',
  $q$select count(*)::text from information_schema.role_table_grants
      where table_schema = 'public' and table_name in ('capture','capture_worker')
        and grantee in ('authenticated','anon')$q$, '0');
select pg_temp.is('create_capture returns only the narrow client shape',
  $q$select pg_get_function_result('public.create_capture(uuid,uuid,int,text,text,text,jsonb)'::regprocedure)$q$,
  'TABLE(capture_id uuid, drawer_id uuid, source text, status text, created_at timestamp with time zone)');
select pg_temp.is('scan_frames bucket is private',
  $q$select public::text from storage.buckets where id = 'scan_frames'$q$, 'false');
select pg_temp.is('no UPDATE/DELETE storage policy on scan_frames',
  $q$select count(*)::text from pg_policies where schemaname = 'storage' and tablename = 'objects'
      and cmd in ('UPDATE','DELETE','ALL') and (coalesce(qual,'') like '%scan_frames%' or coalesce(with_check,'') like '%scan_frames%')$q$, '0');

-- ---------------------------------------------------------------- anon
select pg_temp.as_user(null);
select pg_temp.expect('anon cannot execute create_capture',
  $q$select * from public.create_capture('40000000-0000-4000-8000-0000000000f1', '30000000-0000-4000-8000-0000000000a1', 20)$q$, '42501');
select pg_temp.expect('anon cannot select capture', $q$select id from public.capture$q$, '42501');

-- ---------------------------------------------------------------- uploads (A, B, S)
select pg_temp.as_user('00000000-0000-4000-8000-0000000000a1');
select pg_temp.expect('A uploads frames + manifest to a drawer they can see (org/customer join)',
  $q$select pg_temp.upload('30000000-0000-4000-8000-0000000000a1', '40000000-0000-4000-8000-0000000000a1')$q$);
select pg_temp.expect('A uploads frames for dA2 (own drawer), capture a2',
  $q$select pg_temp.upload('30000000-0000-4000-8000-0000000000a2', '40000000-0000-4000-8000-0000000000a2')$q$);
select pg_temp.expect('A uploads frames for dA2, capture a3',
  $q$select pg_temp.upload('30000000-0000-4000-8000-0000000000a2', '40000000-0000-4000-8000-0000000000a3')$q$);
select pg_temp.expect('A uploads frames for dA3, capture a4',
  $q$select pg_temp.upload('30000000-0000-4000-8000-0000000000a3', '40000000-0000-4000-8000-0000000000a4')$q$);
select pg_temp.expect('A upload with a bad path (not frame_NNNN) is refused',
  $q$insert into storage.objects (bucket_id, name, owner) values ('scan_frames',
     '30000000-0000-4000-8000-0000000000a1/40000000-0000-4000-8000-0000000000a9/evil.jpg', auth.uid())$q$, '42501');

select pg_temp.as_user('00000000-0000-4000-8000-0000000000b1');
select pg_temp.expect('B cannot upload under a drawer B cannot see',
  $q$select pg_temp.upload('30000000-0000-4000-8000-0000000000a1', '40000000-0000-4000-8000-0000000000f2', 1)$q$, '42501');
select pg_temp.expect('B uploads frames to own drawer dB, captures b1..b3',
  $q$select pg_temp.upload('30000000-0000-4000-8000-0000000000b1', '40000000-0000-4000-8000-0000000000b1'),
            pg_temp.upload('30000000-0000-4000-8000-0000000000b1', '40000000-0000-4000-8000-0000000000b2'),
            pg_temp.upload('30000000-0000-4000-8000-0000000000b1', '40000000-0000-4000-8000-0000000000b3')$q$);
select pg_temp.is('B cannot read A''s frames (scan_frames objects)',
  $q$select count(*)::text from storage.objects where bucket_id = 'scan_frames'
      and name like '30000000-0000-4000-8000-0000000000a%'$q$, '0');
select pg_temp.is('B reads own frames (resume upload)',
  $q$select count(*)::text from storage.objects where bucket_id = 'scan_frames'
      and name like '30000000-0000-4000-8000-0000000000b1/40000000-0000-4000-8000-0000000000b1/%'$q$, '21');

select pg_temp.as_user('00000000-0000-4000-8000-0000000000c1');
select pg_temp.expect('staff cannot inject a frame under a prefix A already started',
  $q$insert into storage.objects (bucket_id, name, owner) values ('scan_frames',
     '30000000-0000-4000-8000-0000000000a1/40000000-0000-4000-8000-0000000000a1/frames/frame_0099.jpg', auth.uid())$q$, '42501');
select pg_temp.is('staff reads all test frames',
  $q$select count(*)::text from storage.objects where bucket_id = 'scan_frames'
      and name ~ '^30000000-0000-4000-8000-0000000000(a|b)'$q$, '147');

select pg_temp.as_user('00000000-0000-4000-8000-0000000000a1');
select pg_temp.is('A reads own frames',
  $q$select count(*)::text from storage.objects where bucket_id = 'scan_frames'
      and name like '30000000-0000-4000-8000-0000000000a1/40000000-0000-4000-8000-0000000000a1/%'$q$, '21');
select pg_temp.is('A cannot read B''s frames',
  $q$select count(*)::text from storage.objects where bucket_id = 'scan_frames'
      and name like '30000000-0000-4000-8000-0000000000b%'$q$, '0');
select pg_temp.is('A cannot update own frames (immutable)',
  $q$with u as (update storage.objects set metadata = '{}'::jsonb where bucket_id = 'scan_frames'
      and owner = auth.uid() returning 1) select count(*)::text from u$q$, '0');

select pg_temp.as_user(null);
select pg_temp.is('anon reads no scan_frames objects',
  $q$select count(*)::text from storage.objects where bucket_id = 'scan_frames'$q$, '0');

select pg_temp.as_user('00000000-0000-4000-8000-0000000000e1');
select pg_temp.is('worker reads all test frames',
  $q$select count(*)::text from storage.objects where bucket_id = 'scan_frames'
      and name ~ '^30000000-0000-4000-8000-0000000000(a|b)'$q$, '147');

-- ---------------------------------------------------------------- worker cannot touch order / drawer / customer
select pg_temp.is('worker is_worker() = true', $q$select public.is_worker()::text$q$, 'true');
select pg_temp.is('worker cannot SELECT order', $q$select count(*)::text from public."order"$q$, '0');
select pg_temp.expect('worker cannot INSERT order',
  $q$insert into public."order" (project_name, created_by) values ('cap-test worker', auth.uid())$q$, '42501');
select pg_temp.is('worker cannot UPDATE order',
  $q$with u as (update public."order" set notes = notes returning 1) select count(*)::text from u$q$, '0');
select pg_temp.is('worker cannot DELETE order',
  $q$with u as (delete from public."order" returning 1) select count(*)::text from u$q$, '0');
select pg_temp.is('worker cannot SELECT drawer', $q$select count(*)::text from public.drawer$q$, '0');
select pg_temp.expect('worker cannot INSERT drawer',
  $q$insert into public.drawer (id, created_by, nickname) values (gen_random_uuid(), auth.uid(), 'x')$q$, '42501');
select pg_temp.is('worker cannot SELECT customer', $q$select count(*)::text from public.customer$q$, '0');
select pg_temp.expect('worker cannot write capture directly',
  $q$update public.capture set status = 'done'$q$, '42501');

-- ---------------------------------------------------------------- create_capture
select pg_temp.as_user('00000000-0000-4000-8000-0000000000b1');
select pg_temp.expect('B cannot create a capture on A''s drawer',
  $q$select * from public.create_capture('40000000-0000-4000-8000-0000000000f3', '30000000-0000-4000-8000-0000000000a1', 20)$q$, '42501');

select pg_temp.as_user('00000000-0000-4000-8000-0000000000a1');
select pg_temp.is('A is not a worker', $q$select public.is_worker()::text$q$, 'false');
select pg_temp.expect('A create_capture without frames -> P0001',
  $q$select * from public.create_capture('40000000-0000-4000-8000-0000000000a0', '30000000-0000-4000-8000-0000000000a1', 20)$q$, 'P0001');
select pg_temp.is('A creates capture a1 on dA -> queued',
  $q$select status from public.create_capture('40000000-0000-4000-8000-0000000000a1', '30000000-0000-4000-8000-0000000000a1', 20,
     p_timings => '{"capture_s": 1}')$q$, 'queued');
select pg_temp.is('create_capture replay returns the same row',
  $q$select capture_id::text || ' ' || status from public.create_capture('40000000-0000-4000-8000-0000000000a1', '30000000-0000-4000-8000-0000000000a1', 20)$q$,
  '40000000-0000-4000-8000-0000000000a1 queued');
select pg_temp.expect('upload after create_capture for that capture is refused',
  $q$insert into storage.objects (bucket_id, name, owner) values ('scan_frames',
     '30000000-0000-4000-8000-0000000000a1/40000000-0000-4000-8000-0000000000a1/frames/frame_0021.jpg', auth.uid())$q$, '42501');
select pg_temp.expect('creator cannot select capture.error/timings (column grant)',
  $q$select error, timings from public.capture$q$, '42501');
select pg_temp.expect('creator cannot select * from capture (column grant)',
  $q$select * from public.capture$q$, '42501');
select pg_temp.is('creator reads named client columns of own capture',
  $q$select status from public.capture where id = '40000000-0000-4000-8000-0000000000a1'$q$, 'queued');
select pg_temp.expect('device capture with ortho_url outside drawer-assets/<drawer_id>/ is refused',
  $q$select * from public.create_capture('40000000-0000-4000-8000-0000000000d1', '30000000-0000-4000-8000-0000000000a2', null, 'device',
     'https://x.supabase.co/storage/v1/object/public/drawer-assets/30000000-0000-4000-8000-0000000000b1/orders/x/photo_1.png')$q$, 'P0001');
select pg_temp.is('A get_my_capture_status shows dA as processing',
  $q$select display_state from public.get_my_capture_status() where drawer_id = '30000000-0000-4000-8000-0000000000a1'$q$, 'processing');
-- guard trigger
select pg_temp.expect('owner cannot write drawer.capture_state directly',
  $q$update public.drawer set capture_state = 'ready' where id = '30000000-0000-4000-8000-0000000000a2'$q$, '42501');
select pg_temp.expect('owner cannot write drawer.current_capture_id directly',
  $q$update public.drawer set current_capture_id = '40000000-0000-4000-8000-0000000000a1' where id = '30000000-0000-4000-8000-0000000000a2'$q$, '42501');
select pg_temp.expect('tidyCAM-style drawer update payload still succeeds',
  $q$update public.drawer set nickname = 'cap-test dA2 renamed', photo_url = photo_url, dimensions = dimensions,
     point_cloud_url = point_cloud_url, boundary_corners = boundary_corners where id = '30000000-0000-4000-8000-0000000000a2'$q$);
select pg_temp.expect('client drawer insert with capture_state is refused',
  $q$insert into public.drawer (id, created_by, nickname, capture_state) values (gen_random_uuid(), auth.uid(), 'x', 'ready')$q$, '42501');
select pg_temp.expect('non-worker cannot claim',
  $q$select * from public.claim_next_capture('cap-test-a')$q$, '42501');
select pg_temp.expect('non-staff cannot read the capture queue',
  $q$select public.get_capture_queue()$q$, '42501');

select pg_temp.as_user('00000000-0000-4000-8000-0000000000c1');
select pg_temp.expect('staff cannot write drawer.capture_state directly',
  $q$update public.drawer set capture_state = 'ready' where id = '30000000-0000-4000-8000-0000000000a1'$q$, '42501');

select pg_temp.as_admin();
select pg_temp.is('dA capture_state = queued after create_capture',
  $q$select capture_state || ' ' || current_capture_id from public.drawer where id = '30000000-0000-4000-8000-0000000000a1'$q$,
  'queued 40000000-0000-4000-8000-0000000000a1');

-- ---------------------------------------------------------------- claim / heartbeat / reap / complete (capture a1)
select pg_temp.front('40000000-0000-4000-8000-0000000000a1');
select pg_temp.as_user('00000000-0000-4000-8000-0000000000e1');
select pg_temp.is('worker claims a1 as attempt 1',
  $q$select capture_id::text || ' ' || attempt || ' ' || frames_prefix from public.claim_next_capture('cap-test-w1')$q$,
  '40000000-0000-4000-8000-0000000000a1 1 30000000-0000-4000-8000-0000000000a1/40000000-0000-4000-8000-0000000000a1/');
select pg_temp.is('heartbeat on live claim -> true',
  $q$select public.worker_heartbeat('cap-test-w1', '40000000-0000-4000-8000-0000000000a1', 1, '0.0.1')::text$q$, 'true');
select pg_temp.is('heartbeat with wrong attempt -> false',
  $q$select public.worker_heartbeat('cap-test-w1', '40000000-0000-4000-8000-0000000000a1', 2)::text$q$, 'false');
select pg_temp.is('heartbeat on an unknown capture -> false (no FK error)',
  $q$select public.worker_heartbeat('cap-test-w3', '40000000-0000-4000-8000-0000000000ff', 1)::text$q$, 'false');
select pg_temp.as_admin();
select pg_temp.is('dA capture_state = processing',
  $q$select capture_state from public.drawer where id = '30000000-0000-4000-8000-0000000000a1'$q$, 'processing');
select pg_temp.stale('40000000-0000-4000-8000-0000000000a1');
select pg_temp.as_user('00000000-0000-4000-8000-0000000000e1');
select pg_temp.is('stale heartbeat: next claim reaps and re-claims a1 as attempt 2',
  $q$select capture_id::text || ' ' || attempt from public.claim_next_capture('cap-test-w2')$q$,
  '40000000-0000-4000-8000-0000000000a1 2');
select pg_temp.expect('complete_capture with the old attempt -> 40001',
  $q$select public.complete_capture('40000000-0000-4000-8000-0000000000a1', 'cap-test-w1', 1,
     'https://x.supabase.co/storage/v1/object/public/drawer-assets/30000000-0000-4000-8000-0000000000a1/orders/o/photo_1.png')$q$, '40001');
select pg_temp.expect('complete_capture with ortho outside the drawer prefix is refused',
  $q$select public.complete_capture('40000000-0000-4000-8000-0000000000a1', 'cap-test-w2', 2,
     'https://x.supabase.co/storage/v1/object/public/drawer-assets/30000000-0000-4000-8000-0000000000b1/orders/o/photo_1.png')$q$, 'P0001');
select pg_temp.is('complete_capture on the live attempt -> done',
  $q$select (public.complete_capture('40000000-0000-4000-8000-0000000000a1', 'cap-test-w2', 2,
     'https://x.supabase.co/storage/v1/object/public/drawer-assets/30000000-0000-4000-8000-0000000000a1/orders/o/photo_2.png',
     'https://x.supabase.co/storage/v1/object/public/lidar_scans/30000000-0000-4000-8000-0000000000a1/orders/o/model_2.usdz',
     '{"total_s": 9}')).status$q$, 'done');
select pg_temp.is('complete_capture replay returns the same row',
  $q$select (c).id::text || ' ' || (c).status || ' ' || (c).attempt_count from (select public.complete_capture('40000000-0000-4000-8000-0000000000a1', 'cap-test-w2', 2,
     'https://x.supabase.co/storage/v1/object/public/drawer-assets/30000000-0000-4000-8000-0000000000a1/orders/o/photo_2.png') c offset 0) s$q$,
  '40000000-0000-4000-8000-0000000000a1 done 2');
select pg_temp.as_admin();
select pg_temp.is('a1 timings: client kept, worker stored, attempts = [lost, done]',
  $q$select (timings->'client'->>'capture_s') || ' ' || (timings->'worker'->>'total_s') || ' '
     || (select string_agg(e->>'outcome', ',' order by (e->>'attempt')::int) from jsonb_array_elements(timings->'attempts') e)
     from public.capture where id = '40000000-0000-4000-8000-0000000000a1'$q$, '1 9 lost,done');
select pg_temp.is('dA: photo/model filled from the capture, capture_state ready',
  $q$select capture_state || ' ' || (photo_url like '%/photo_2.png') || ' ' || (point_cloud_url like '%/model_2.usdz')
     from public.drawer where id = '30000000-0000-4000-8000-0000000000a1'$q$, 'ready true true');
select pg_temp.is('section 5.3 (b): pre-created backlog drawer advanced to scanned via the bridge',
  $q$select d.stage || ' ' || (select count(*) from public.status_event e where e.drawer_id = d.id
       and e.field = 'stage' and e.kind = 'bridge' and e.from_status = 'backlog' and e.to_status = 'scanned')
     from public.drawer d where d.id = '30000000-0000-4000-8000-0000000000a1'$q$, 'scanned 1');
select pg_temp.is('stage/state untouched by capture on dA3 (still active)',
  $q$select state from public.drawer where id = '30000000-0000-4000-8000-0000000000a3'$q$, 'active');

-- ---------------------------------------------------------------- fill-if-empty + non-retryable fail (dA2)
select pg_temp.as_user('00000000-0000-4000-8000-0000000000a1');
select pg_temp.expect('A creates capture a2 on dA2',
  $q$select * from public.create_capture('40000000-0000-4000-8000-0000000000a2', '30000000-0000-4000-8000-0000000000a2', 20)$q$);
select pg_temp.as_admin();
select pg_temp.front('40000000-0000-4000-8000-0000000000a2');
select pg_temp.as_user('00000000-0000-4000-8000-0000000000e1');
select pg_temp.expect('worker claims + completes a2',
  $q$select public.complete_capture(c.capture_id, 'cap-test-w1', c.attempt,
     'https://x.supabase.co/storage/v1/object/public/drawer-assets/30000000-0000-4000-8000-0000000000a2/orders/o/photo_9.png')
     from public.claim_next_capture('cap-test-w1') c$q$);
select pg_temp.as_admin();
select pg_temp.is('pre-set photo_url is NOT overwritten by complete_capture',
  $q$select photo_url || ' ' || capture_state from public.drawer where id = '30000000-0000-4000-8000-0000000000a2'$q$,
  'https://pre.invalid/photo.png ready');
select pg_temp.as_user('00000000-0000-4000-8000-0000000000a1');
select pg_temp.expect('A creates capture a3 on dA2',
  $q$select * from public.create_capture('40000000-0000-4000-8000-0000000000a3', '30000000-0000-4000-8000-0000000000a2', 20)$q$);
select pg_temp.as_admin();
select pg_temp.front('40000000-0000-4000-8000-0000000000a3');
select pg_temp.as_user('00000000-0000-4000-8000-0000000000e1');
select pg_temp.is('fail_capture with a non-retryable code -> failed at once',
  $q$select (public.fail_capture(c.capture_id, 'cap-test-w1', c.attempt, 'bad_frames', 'blurry')).status
     from public.claim_next_capture('cap-test-w1') c$q$, 'failed');
select pg_temp.expect('fail_capture with an unknown code is refused',
  $q$select public.fail_capture('40000000-0000-4000-8000-0000000000a3', 'cap-test-w1', 1, 'made_up')$q$, 'P0001');
select pg_temp.as_admin();
select pg_temp.is('dA2 capture_state = rescan_needed',
  $q$select capture_state from public.drawer where id = '30000000-0000-4000-8000-0000000000a2'$q$, 'rescan_needed');
select pg_temp.as_user('00000000-0000-4000-8000-0000000000a1');
select pg_temp.is('photo wins: dA2 (rescan_needed but has a photo) has no customer chip',
  $q$select count(*)::text from public.get_my_capture_status() where drawer_id = '30000000-0000-4000-8000-0000000000a2'$q$, '0');

-- ---------------------------------------------------------------- retry + reaper exhaustion (a4 on dA3)
select pg_temp.expect('A creates capture a4 on dA3',
  $q$select * from public.create_capture('40000000-0000-4000-8000-0000000000a4', '30000000-0000-4000-8000-0000000000a3', 20)$q$);
select pg_temp.as_admin();
select pg_temp.front('40000000-0000-4000-8000-0000000000a4');
select pg_temp.as_user('00000000-0000-4000-8000-0000000000e1');
select pg_temp.is('retryable fail with attempts left -> queued (T5)',
  $q$select (public.fail_capture(c.capture_id, 'cap-test-w1', c.attempt, 'download_failed')).status
     from public.claim_next_capture('cap-test-w1') c$q$, 'queued');
select pg_temp.is('stale fail_capture (old attempt) is a no-op',
  $q$select (public.fail_capture('40000000-0000-4000-8000-0000000000a4', 'cap-test-w1', 1, 'worker_error')).status$q$, 'queued');
select pg_temp.is('claim a4 attempt 2',
  $q$select attempt::text from public.claim_next_capture('cap-test-w1')$q$, '2');
select pg_temp.as_admin();
select pg_temp.stale('40000000-0000-4000-8000-0000000000a4');
select pg_temp.as_user('00000000-0000-4000-8000-0000000000e1');
select pg_temp.is('reaper requeues a4 and it is re-claimed as attempt 3',
  $q$select attempt::text from public.claim_next_capture('cap-test-w2')$q$, '3');
select pg_temp.as_admin();
select pg_temp.stale('40000000-0000-4000-8000-0000000000a4');
select pg_temp.as_user('00000000-0000-4000-8000-0000000000e1');
select pg_temp.expect('third loss reaped on next claim', $q$select * from public.claim_next_capture('cap-test-w2')$q$);
select pg_temp.as_admin();
select pg_temp.is('a4 failed with retries_exhausted after attempt_limit, 3 attempts audited',
  $q$select status || ' ' || split_part(error, ':', 1) || ' ' || jsonb_array_length(timings->'attempts')
     from public.capture where id = '40000000-0000-4000-8000-0000000000a4'$q$, 'failed retries_exhausted 3');
select pg_temp.is('dA3 capture_state = rescan_needed',
  $q$select capture_state from public.drawer where id = '30000000-0000-4000-8000-0000000000a3'$q$, 'rescan_needed');
select pg_temp.is('failure leaves stage/state alone (no on_hold/rework)',
  $q$select stage || ' ' || state from public.drawer where id = '30000000-0000-4000-8000-0000000000a3'$q$, 'scanned active');
select pg_temp.as_user('00000000-0000-4000-8000-0000000000a1');
select pg_temp.is('A sees "rescan_needed" chip for dA3 (no photo)',
  $q$select display_state from public.get_my_capture_status() where drawer_id = '30000000-0000-4000-8000-0000000000a3'$q$, 'rescan_needed');
select pg_temp.expect('non-staff cannot requeue',
  $q$select public.requeue_capture('40000000-0000-4000-8000-0000000000a4', 'x')$q$, '42501');

select pg_temp.as_user('00000000-0000-4000-8000-0000000000c1');
select pg_temp.is('staff requeue -> queued, attempt_limit = attempt_count + 3',
  $q$select (c).status || ' ' || (c).attempt_count || '/' || (c).attempt_limit
     from (select public.requeue_capture('40000000-0000-4000-8000-0000000000a4', 'frames look fine') c offset 0) s$q$, 'queued 3/6');
select pg_temp.is('staff cancel -> failed cancelled',
  $q$select (c).status || ' ' || split_part((c).error, ':', 1)
     from (select public.cancel_capture('40000000-0000-4000-8000-0000000000a4', 'customer will rescan') c offset 0) s$q$, 'failed cancelled');
select pg_temp.is('staff get_capture_queue lists the test workers (w1, w2, w3) and failures with error',
  $q$select (select count(*) from jsonb_array_elements(q->'workers') w where w->>'worker_id' like 'cap-test-%')::text || ' '
     || (select count(*) from jsonb_array_elements(q->'captures') c where c->>'capture_id' = '40000000-0000-4000-8000-0000000000a4'
           and c->>'error' like 'cancelled:%')
     from public.get_capture_queue() q$q$, '3 1');

-- ---------------------------------------------------------------- supersede (dB)
select pg_temp.as_user('00000000-0000-4000-8000-0000000000b1');
select pg_temp.is('B creates capture b1 (queued)',
  $q$select status from public.create_capture('40000000-0000-4000-8000-0000000000b1', '30000000-0000-4000-8000-0000000000b1', 20)$q$, 'queued');
select pg_temp.is('B sees own drawer chip (processing)',
  $q$select display_state from public.get_my_capture_status() where drawer_id = '30000000-0000-4000-8000-0000000000b1'$q$, 'processing');
select pg_temp.as_user('00000000-0000-4000-8000-0000000000a1');
select pg_temp.is('A cannot read B''s capture rows',
  $q$select count(id)::text from public.capture where drawer_id = '30000000-0000-4000-8000-0000000000b1'$q$, '0');
select pg_temp.is('A get_my_capture_status returns only A''s drawers',
  $q$select count(*)::text from public.get_my_capture_status() where drawer_id = '30000000-0000-4000-8000-0000000000b1'$q$, '0');
select pg_temp.as_user('00000000-0000-4000-8000-0000000000b1');
select pg_temp.expect('B creates capture b2 on dB (supersedes queued b1)',
  $q$select * from public.create_capture('40000000-0000-4000-8000-0000000000b2', '30000000-0000-4000-8000-0000000000b1', 20)$q$);
select pg_temp.is('superseded queued capture -> failed/superseded',
  $q$select status from public.capture where id = '40000000-0000-4000-8000-0000000000b1'$q$, 'failed');
select pg_temp.as_admin();
select pg_temp.is('b1 error code = superseded',
  $q$select split_part(error, ':', 1) from public.capture where id = '40000000-0000-4000-8000-0000000000b1'$q$, 'superseded');
select pg_temp.front('40000000-0000-4000-8000-0000000000b2');
select pg_temp.as_user('00000000-0000-4000-8000-0000000000e1');
select pg_temp.is('worker claims b2',
  $q$select capture_id::text from public.claim_next_capture('cap-test-w1')$q$, '40000000-0000-4000-8000-0000000000b2');
select pg_temp.as_user('00000000-0000-4000-8000-0000000000b1');
select pg_temp.expect('B creates b3 while b2 is processing',
  $q$select * from public.create_capture('40000000-0000-4000-8000-0000000000b3', '30000000-0000-4000-8000-0000000000b1', 20)$q$);
select pg_temp.as_user('00000000-0000-4000-8000-0000000000e1');
select pg_temp.is('late-finishing superseded b2 still completes',
  $q$select (public.complete_capture('40000000-0000-4000-8000-0000000000b2', 'cap-test-w1', 1,
     'https://x.supabase.co/storage/v1/object/public/drawer-assets/30000000-0000-4000-8000-0000000000b1/orders/o/photo_1.png')).status$q$, 'done');
select pg_temp.as_admin();
select pg_temp.is('... but leaves the drawer alone (no photo, state = queued for b3)',
  $q$select coalesce(photo_url, 'null') || ' ' || capture_state || ' ' || current_capture_id
     from public.drawer where id = '30000000-0000-4000-8000-0000000000b1'$q$,
  'null queued 40000000-0000-4000-8000-0000000000b3');

-- ---------------------------------------------------------------- deletes (FK cycle)
select pg_temp.expect('deleting the current capture row directly succeeds (FK set-null passes the guard)',
  $q$delete from public.capture where id = '40000000-0000-4000-8000-0000000000a3'$q$);
select pg_temp.is('... and nulls drawer.current_capture_id + capture_state',
  $q$select coalesce(current_capture_id::text, 'null') || ' ' || coalesce(capture_state, 'null')
     from public.drawer where id = '30000000-0000-4000-8000-0000000000a2'$q$, 'null null');
select pg_temp.as_user('00000000-0000-4000-8000-0000000000e1');
select pg_temp.is('heartbeat on a deleted capture -> false (no FK error)',
  $q$select public.worker_heartbeat('cap-test-w1', '40000000-0000-4000-8000-0000000000a3', 1)::text$q$, 'false');

-- Known, accepted edge of section 5.3 (b) (Q4 pending Sam): a backlog drawer whose legacy
-- status is ALREADY 'created_by_user' does not advance, because drawer_stage_bridge fires only
-- on a real status change. Pinned so a behaviour change is deliberate.
select pg_temp.as_user('00000000-0000-4000-8000-0000000000a1');
select pg_temp.expect('A uploads + creates capture a5 on dA4 (backlog, status already created_by_user)',
  $q$select pg_temp.upload('30000000-0000-4000-8000-0000000000a4', '40000000-0000-4000-8000-0000000000a5'),
     (select status from public.create_capture('40000000-0000-4000-8000-0000000000a5', '30000000-0000-4000-8000-0000000000a4', 20))$q$);
select pg_temp.as_admin();
select pg_temp.front('40000000-0000-4000-8000-0000000000a5');
select pg_temp.as_user('00000000-0000-4000-8000-0000000000e1');
select pg_temp.expect('worker claims + completes a5',
  $q$select public.complete_capture(c.capture_id, 'cap-test-w1', c.attempt,
     'https://x.supabase.co/storage/v1/object/public/drawer-assets/30000000-0000-4000-8000-0000000000a4/orders/o/photo_1.png')
     from public.claim_next_capture('cap-test-w1') c$q$);
select pg_temp.as_admin();
select pg_temp.is('5.3(b) edge: backlog drawer with status already created_by_user stays backlog',
  $q$select stage || ' ' || capture_state from public.drawer where id = '30000000-0000-4000-8000-0000000000a4'$q$, 'backlog ready');

-- status_event is append-only and blocks any drawer delete on its own (prod's admin purge
-- path lifts that with tidytool.allow_audited_purge, 20260910175336, not yet on dev). Lift it
-- inside this rolled-back transaction so the test isolates the capture FK cycle.
alter table public.status_event disable trigger status_event_no_delete;
select pg_temp.expect('deleting a drawer that has captures succeeds (capture<->drawer FK cycle)',
  $q$delete from public.drawer where id = '30000000-0000-4000-8000-0000000000b1'$q$);
select pg_temp.is('... and cascades its captures',
  $q$select count(*)::text from public.capture where drawer_id = '30000000-0000-4000-8000-0000000000b1'$q$, '0');

-- ---------------------------------------------------------------- functions pin search_path
select pg_temp.is('every new capture function pins search_path',
  $q$select count(*)::text from pg_proc where pronamespace = 'public'::regnamespace
      and proname in ('is_worker','drawer_capture_state_guard','_can_capture_drawer','_sync_drawer_capture_state',
        '_can_capture_drawer_path','create_capture','_reap_stale_captures','claim_next_capture','worker_heartbeat',
        'complete_capture','fail_capture','requeue_capture','cancel_capture','get_my_capture_status','get_capture_queue')
      and not exists (select 1 from unnest(proconfig) c where c like 'search_path=%')$q$, '0');
select pg_temp.is('worker_heartbeat updates capture before upserting capture_worker (lock order)',
  $q$select (strpos(d, 'update public.capture') between 1 and strpos(d, 'insert into public.capture_worker'))::text
     from pg_get_functiondef('public.worker_heartbeat(text,uuid,int,text)'::regprocedure) d$q$, 'true');
select pg_temp.is('internal helpers are not executable by authenticated',
  $q$select string_agg(p, ',' order by p) from (values ('public._can_capture_drawer(uuid)'), ('public._sync_drawer_capture_state(uuid)'),
       ('public._reap_stale_captures(text)')) v(p) where has_function_privilege('authenticated', p, 'execute')$q$, null);

select pg_temp.as_admin();
select n, test, ok, detail from pg_temp._r order by n;
rollback;