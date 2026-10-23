# verification.md: T2-L1 capture schema + RLS (Todoist 6hq6FjxP4V9rj3GM)

Branch `agent/6hq6FjxP4V9rj3GM-capture-schema`. Contract: `planning/remote-reconstruction-contract.md`
on PR #38 (unmerged). Every "Decision (proposed)" is implemented as the §12 recommendation, including
Q4 option (b) and Q9 (the bucket is created in the migration).

## Plan (also posted as a comment on the card)
1. One expand-only migration, `portal/supabase/migrations/20261023120000_remote_capture_queue.sql`.
   Review round 1 added a follow-up, `20261023130000_worker_heartbeat_lock_order.sql`.
2. Apply to dev only with `db_apply`, then run `--check` on dev.
3. RLS and behaviour tests in `portal/supabase/tests/remote_capture_rls_test.sql`, run by the
   dev-only runner `tools/db_test.py`.
4. This file. No prod apply, no push, no PR.

## Done-when

| Criterion | | Evidence |
|---|---|---|
| Migration in `portal/supabase/migrations/`, expand-only | ✓ | `20261023120000_remote_capture_queue.sql` adds tables, columns, functions, policies and the bucket. Its only `drop` replaces `user_roles_role_check` with a strictly wider check (`+ 'worker'`) in the same transaction, per contract §3.5/§10.1. `20261023130000_worker_heartbeat_lock_order.sql` is a body-only `create or replace` of `worker_heartbeat`: same signature, return type and grants. |
| Applied to **dev** via db_apply | ✓ | Both files. See "Dev apply" below. |
| Applied to **prod** via db_apply | ✗ | **Pending Sam.** Commands below, in order. |
| RLS tests green | ✓ | 111/111 on dev. See "RLS tests" below. |
| Migration synced byte-exact into the repo | ✓ | Each file's md5 matches its dev history md5: `dab876d045763014c8ce1d2458c32268` and `2b16beac2ceb88fc8a80145f1d20b4ca`. Each file has a header comment and no trailing newline, and db_apply stores the file bytes verbatim. |
| Typecheck clean | ✓ | `npm run typecheck` exits 0. `types.ts` is untouched, so no build is needed. |

### Prod commands for Sam (run both, in this order)
```
python3 tools/db_apply.py portal/supabase/migrations/20261023120000_remote_capture_queue.sql --env prod --approved --reload-postgrest
python3 tools/db_apply.py portal/supabase/migrations/20261023130000_worker_heartbeat_lock_order.sql --env prod --approved
```
The first command needs `--reload-postgrest` because it adds REST-exposed RPCs. The second only
replaces an existing function, so it needs no reload.

### Dev apply
```
$ python3 tools/db_apply.py portal/supabase/migrations/20261023120000_remote_capture_queue.sql --env dev --reload-postgrest
Applied 20261023120000_remote_capture_queue.sql to dev (gfkrebuioszsxanjdnsx). History md5 verified: dab876d045763014c8ce1d2458c32268.
$ python3 tools/db_apply.py portal/supabase/migrations/20261023130000_worker_heartbeat_lock_order.sql --env dev
Applied 20261023130000_worker_heartbeat_lock_order.sql to dev (gfkrebuioszsxanjdnsx). History md5 verified: 2b16beac2ceb88fc8a80145f1d20b4ca.

$ md5 -q portal/supabase/migrations/20261023120000_remote_capture_queue.sql        -> dab876d045763014c8ce1d2458c32268
$ md5 -q portal/supabase/migrations/20261023130000_worker_heartbeat_lock_order.sql -> 2b16beac2ceb88fc8a80145f1d20b4ca

$ python3 tools/db_apply.py --check --env dev
  20260910175336 admin_cleanup_controls                        LOCAL ONLY — not applied to dev
  20260910175529 admin_order_detail_drawer_state               LOCAL ONLY — not applied to dev
DIVERGED: 56 local file(s), 54 row(s) on dev; 25 byte-verified, 29 recorded without byte-faithful content.
```
The DIVERGED status was already there before this work (see "Pre-existing failures"). Before it, 23
files were byte-verified; now 25 are, and the two new ones are these migrations.

### worker_heartbeat lock order (review round 1, MUST FIX)
- **The problem.** In 20261023120000, `worker_heartbeat` upserted `capture_worker` before it updated
  `capture`. `complete_capture` and `fail_capture` lock the two tables the other way round, so a
  heartbeat thread running beside the main thread could deadlock (40P01). Separately, a beat for a
  capture that no longer exists raised 23503: the FK on `capture_worker.current_capture_id`.
- **The fix (20261023130000).** The function now updates `capture` first and records whether that
  claim is live. It then upserts `capture_worker`, with
  `current_capture_id = case when live then p_capture_id end`. Every capture RPC now takes locks in
  the order capture → capture_worker → drawer.
- **Proof on dev.** `pg_get_functiondef(worker_heartbeat)` puts `update public.capture` at offset 540,
  before `insert into public.capture_worker` at offset 859. Test #110 asserts this ordering.
- **The new tests are real regressions.** Before 20261023130000 was applied, tests #57 and #103
  failed with `23503 ... capture_worker_current_capture_id_fkey` and #110 failed. After the apply all
  three pass. Those three are:
  - #57: a heartbeat on an unknown capture returns false;
  - #103: a heartbeat on a deleted capture returns false;
  - #110: the lock order.
- **Concurrency check not run.** The optional heartbeat-vs-complete_capture check was not done.
  `tools/db_test.py` sends each file as one stateless Management API request, so it cannot hold two
  sessions open, and there is no `psql` on this machine. The fix rests on the uniform lock order
  rather than on an observed run.

### RLS tests
```
$ python3 tools/db_test.py portal/supabase/tests/remote_capture_rls_test.sql
111/111 passed on dev (gfkrebuioszsxanjdnsx).
```
How the suite works:
- It runs as one transaction that ends in `ROLLBACK`.
- Every fixture is created inside that transaction: 4 auth users, roles, 2 customers, 2 orders,
  5 drawers and storage objects.
- Callers are simulated with `set_config('role', 'authenticated'|'anon')` plus `request.jwt.claims`.

A check afterwards confirmed nothing was left on dev:
- 0 captures, 0 capture_workers and 0 scan_frames objects;
- 0 `cap-test` drawers;
- `status_event_no_delete` is still enabled.

The card's required tests:
- **A customer cannot read another customer's frames.**
  - Storage objects: #17 and #22.
  - Capture rows: #92.
  - Related coverage: anon reads nothing (#9, #24), frames are immutable (#23), and both injection
    cases are refused: after create_capture (#40) and into another user's prefix (#19).
- **The worker cannot select, insert, update or delete `order`.** #27–#30 all pass. Only the INSERT
  cases need the new restrictive `*_deny_worker` policies: #28 (order) and #32 (drawer). The
  SELECT/UPDATE/DELETE cases (#27, #29, #30, plus #31 and #33 for drawer and customer) would already
  pass under the existing policies, which hide rows the worker did not create. They assert the
  invariant but do not prove the new policies.

Cheap contract invariants also asserted:
- **Column grant.** As the creator, `select error, timings` and `select *` both fail with 42501
  (#41, #42). The named columns work (#43). The grant lists exactly the 11 client columns (#3).
- **Narrow shape.** `create_capture` returns the narrow client shape (#5).
- **Bucket.** `scan_frames` is private and has no update or delete policy (#6, #7).
- **§10 dev-verification checklist.** Every item that one session can test passes:
  - authorization: 42501, P0001 and queued (#35, #37, #38);
  - the guard trigger (#46–#49, #52);
  - fencing, replay and fill-if-empty (#60–#63, #70);
  - reaper requeue and `retries_exhausted` (#59, #80–#83);
  - supersede and the late finisher (#94–#100);
  - photo wins (#75);
  - the device URL prefix check (#44);
  - both deletes in the FK cycle (#101, #102, #107, #108);
  - search_path pinned on every new function (#109).
- **§5.3 option (b).** A backlog drawer advances to scanned through `drawer_stage_bridge` and records
  one bridge `status_event` (#66).
- **Known, accepted edge of §5.3 option (b) (Q4 is Sam's).** A drawer at `stage = 'backlog'` whose
  legacy `status` is *already* `'created_by_user'` does **not** advance after `complete_capture`. The
  bridge fires only when the status actually changes. #106 pins this, and the behaviour is unchanged.

**Not covered**, because both need two concurrent sessions:
- concurrent `claim_next_capture` handing out different rows;
- concurrent `create_capture`, `complete_capture` and `worker_heartbeat` finishing without 40P01.

Both rely on `FOR UPDATE SKIP LOCKED` and the §8 lock order.

The drawer-delete test (#107) disables `status_event_no_delete` inside the rolled-back transaction.
`status_event` is append-only, and on dev that blocks every drawer delete, with or without captures.
Prod's purge path (`tidytool.allow_audited_purge`, 20260910175336) is not on dev yet.

### Advisors (dev, security)
There are no new `function_search_path_mutable` findings. The new findings fall into existing,
intentional classes:
- `capture_worker` shows "RLS enabled, no policy". That is intentional deny-all, the same house
  pattern as `drawer_label`.
- The new RPCs show "authenticated can execute SECURITY DEFINER". That is the house posture: each
  RPC does its own role check.

## Deviations / additions beyond the contract's target SQL (for the reviewer and the contract amendment)
1. **Restrictive `*_deny_worker` policies on `order`, `drawer` and `customer`.** The existing
   `order_insert_authenticated` (`with check created_by = auth.uid()`) and
   `drawer_insert_authenticated` would let a worker user insert rows. That would break the §3.5
   invariant and the card's "worker cannot touch order". The policies are additive, and the
   predicate is `(select is_worker())`, which Postgres evaluates once per statement.
2. **requeue/cancel audit entries.** `requeue_capture` and `cancel_capture` append a
   `timings.attempts` entry with outcome `requeued` or `cancelled`, plus `by` and `reason`. Cancel
   appends one only if the capture was processing. Both require a non-empty reason. §3.2 lists only
   lost, done, failed and retry, so the new outcomes need adding to the contract.
3. **`get_capture_queue`.** It returns at most 500 captures, newest first. `customer_name` is
   `order.customer_name`, falling back to `customer.name`.
4. **Option (b) write is limited to the current capture.** The write also requires
   `current_capture_id = capture.id`, which matches §5.2 rule 1.
5. **`worker_heartbeat` differs from the §6.1 target shape.** It updates capture before upserting
   capture_worker, and it sets `current_capture_id` only while the claim is live (20261023130000).
   §6.1 should be amended to match.

## Pre-existing failures
- `db_apply --check --env dev` was already DIVERGED before this change.
  `20260910175336_admin_cleanup_controls` and `20260910175529_admin_order_detail_drawer_state` exist
  locally but not on dev. They are out of scope and were not applied.
- Dev `auth.users` has no `link_customer_on_auth` trigger, although contract §10 assumes one. Check
  prod before creating the worker user.
- On the clean tree, typecheck, `test:pricing` (36/36) and `test:labels` (11/11) were green.

## Hardware sign-off needed: no
This change is schema-only and was verified on dev. Two steps are Sam's (§10):
- applying both migrations to prod;
- creating the worker user, which must wait until the EmployeesList worker-role change (§13.1)
  ships.
