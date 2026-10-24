# verification.md: T2-L1 capture schema + RLS (Todoist 6hq6FjxP4V9rj3GM)

Branch `agent/6hq6FjxP4V9rj3GM-capture-schema`. Contract: `planning/remote-reconstruction-contract.md`
on PR #38 (unmerged). Rounds 1–2 implemented every "Decision (proposed)" as the §12 recommendation.
Round 3 (`20261023140000`) applies Sam's final 2026-10-23 decisions: Q1 (a) service-role worker and
Q4 declined (the bridge advance is removed). See "Round 3 — pilot decisions" below.

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
| Applied to **dev** via db_apply | ✓ | All three files (120000, 130000, 140000). `--check --env dev`: 26 byte-verified; DIVERGED only from the pre-existing local-only 20260910175336/175529. |
| Applied to **prod** via db_apply | ✗ | **Pending Sam.** Three commands below, in order. |
| RLS tests green | ✓ | 130/130 on dev, after round 3 (111/111 after round 2). See "RLS tests" and "Round 3" below. |
| Migration synced byte-exact into the repo | ✓ | Each file's md5 matches its dev history md5: `dab876d045763014c8ce1d2458c32268` (120000), `2b16beac2ceb88fc8a80145f1d20b4ca` (130000), `000c2b409c2c7d701fdb95b42d90aef7` (140000). Each file has a header comment and no trailing newline, and db_apply stores the file bytes verbatim. The round-3 reviewer also matched dev's live function bodies (md5 of prosrc) to the final files. |
| Typecheck clean | ✓ | `npm run typecheck` exits 0. `types.ts` is untouched, so no build is needed. |

### Prod commands for Sam (run all three, in this order)
```
python3 tools/db_apply.py portal/supabase/migrations/20261023120000_remote_capture_queue.sql --env prod --approved --reload-postgrest
python3 tools/db_apply.py portal/supabase/migrations/20261023130000_worker_heartbeat_lock_order.sql --env prod --approved
python3 tools/db_apply.py portal/supabase/migrations/20261023140000_pilot_decisions.sql --env prod --approved
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
  `current_capture_id = case when live then p_capture_id end`.
- **Correction (review round 2).** The 20261023130000 header and an earlier draft of this file said
  "capture → capture_worker → drawer in every capture RPC". That is not what the code does. The real
  order per RPC is:
  - `worker_heartbeat`: capture → capture_worker.
  - `complete_capture` / `fail_capture`: capture → drawer → capture_worker.
  - `claim_next_capture`: capture_worker → capture (SKIP LOCKED only, so it never waits) → drawer.

  The invariant that holds is that every capture lock that can wait is taken before drawer and
  capture_worker. That removes the heartbeat deadlock. One theoretical cycle remains, from
  20261023120000: claim takes capture_worker then drawer, while complete/fail take drawer then
  capture_worker. It needs claim and complete to run at once on a shared drawer, which the worker's
  serial loop doesn't do, and §8 treats 40P01 as retryable. The header is applied and byte-exact, so
  it stays as is.
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

---

## Round 3: pilot decisions (Sam, 2026-10-23 01:05 MT; Todoist comment on 6hq97rWq8jpgwhHv)

New file: `portal/supabase/migrations/20261023140000_pilot_decisions.sql`. The two earlier
migrations are unchanged. Evidence moved here from the repo root (`git mv`, following the PR #40 convention).

| Decision | | Evidence |
|---|---|---|
| **Q1 (a)**: the worker uses the service-role key for the pilot | ✓ | `is_worker()` = `coalesce(auth.role(), '') = 'service_role' or <worker user_roles row>`. `auth.role()` reads the same claims (`request.jwt.claim.role` / `request.jwt.claims->>'role'`) that `auth.uid()` reads. Tests 113–122. |
| `auth.uid()` is null under service_role | ✓ | Only one write path depends on it: `capture_worker.auth_user_id` in `claim_next_capture` and `worker_heartbeat`. That column was **NOT NULL**, so a service_role claim or heartbeat raised 23502. **Fix: expand-only relaxation** `alter table public.capture_worker alter column auth_user_id drop not null`. A null value means "service-role caller, no auth user". Nothing reads the column: `get_capture_queue` does not expose it, and a grep of portal/src and planning finds no reader. The claim and heartbeat bodies are therefore **unchanged**. Other places checked: `timings.attempts` entries on worker paths carry `worker_id` (the `p_worker_id` text), never `auth.uid()`. `attempts.by` (requeue/cancel) and `capture.created_by` (create_capture) are written only by staff/customer RPCs. `complete_capture`, `fail_capture` and `_reap_stale_captures` never read `auth.uid()`. Tests 119 and 120. |
| service_role has EXECUTE on the 4 worker RPCs | ✓ | Explicit additive `grant execute ... to service_role` on claim/heartbeat/complete/fail. The schema's default privileges already gave it (dev `proacl` before the change: `service_role=X/postgres`); the grant pins it. Test 122. |
| `deny_worker` policies untouched; `is_worker()` still false for every authenticated non-worker | ✓ | No policy DDL. For an `authenticated` request the role claim is `authenticated`, so the new disjunct is false. Tests 123–130: A, B and staff `is_worker()` = false; A and staff cannot claim (42501); A cannot heartbeat; staff still reads drawers; anon cannot claim. Pre-existing tests 26 and 36 (worker true / A false) still pass. |
| **Q4 declined**: no bridge advance in `complete_capture` | ✓ | The §5.3(b) block (20261023120000 l.518–523, `update drawer set status = 'created_by_user' where stage = 'backlog'`) is removed. Everything else is byte-identical: a `diff` against the 20261023120000 body shows only that block removed plus one comment line extended. Lock order (capture → drawer → capture_worker), the attempt_count fence, replay, fill-if-empty and the photo-wins rule are all unchanged. Dev `pg_get_functiondef(complete_capture)` contains no `created_by_user` (strpos 0). Tests 66, 106 and 121. |
| Expand-only, byte-exact | ✓ | One NOT NULL relaxed, plus body-only `create or replace` with the same signatures and return types. File md5 = dev history md5 = `000c2b409c2c7d701fdb95b42d90aef7`. Header present, no trailing newline. |
| Typecheck | ✓ | `cd portal && npm run typecheck`: `tsc --noEmit` exits 0. portal/src is untouched, so no build. |

### Dev apply (and a re-apply, disclosed)
The first draft (md5 `bc025c616b9071552e233cbc7f4a8b7c`) kept NOT NULL and wrote a nil-uuid
sentinel via `coalesce(auth.uid(), '0000…')` in replaced claim and heartbeat bodies. It was applied
to dev and passed 130/130. The coordinator then asked for the NOT NULL relaxation instead. To keep
dev history byte-faithful to the final file, I took these steps:
1. In one transaction on dev, re-ran `is_worker`, `claim_next_capture` and `complete_capture` from
   20261023120000 and `worker_heartbeat` from 20261023130000, then deleted the dev
   `schema_migrations` row `20261023140000`. Verified afterwards: history row count 0, `is_worker`
   has no `service_role`, `complete_capture` has the status write again, and `auth_user_id`
   `is_nullable = NO`.
2. Applied the final file. Nothing was ever applied to prod.
```
$ python3 tools/db_apply.py portal/supabase/migrations/20261023140000_pilot_decisions.sql --env dev
Applied 20261023140000_pilot_decisions.sql to dev (gfkrebuioszsxanjdnsx). History md5 verified: 000c2b409c2c7d701fdb95b42d90aef7.
$ md5 -q portal/supabase/migrations/20261023140000_pilot_decisions.sql
000c2b409c2c7d701fdb95b42d90aef7
$ python3 tools/db_apply.py --check --env dev
  20260910175336 admin_cleanup_controls                        LOCAL ONLY — not applied to dev
  20260910175529 admin_order_detail_drawer_state               LOCAL ONLY — not applied to dev
DIVERGED: 57 local file(s), 55 row(s) on dev; 26 byte-verified, 29 recorded without byte-faithful content.
```
Byte-verified rose from 25 to 26; the new one is 20261023140000. The only divergences are the two
known pre-existing 20260910* LOCAL ONLY entries. A direct history query on dev
(`md5(array_to_string(statements, E';\n'))`) gives `20261023140000 pilot_decisions
000c2b409c2c7d701fdb95b42d90aef7`.

Spot-checks on dev:
- `pg_get_functiondef('public.is_worker()')`:
  `select coalesce(auth.role(), '') = 'service_role' or exists (select 1 from public.user_roles where user_id = auth.uid() and role = 'worker');`
- `pg_get_functiondef(complete_capture)`: `strpos('created_by_user') = 0`; the new Q4 comment sits at
  offset 2180; the definition md5 is `8bb9b244ccf3534bc915c4a8cd2d64b0`.
- `information_schema.columns`: `capture_worker.auth_user_id` `is_nullable = YES`.

### Tests (full suite)
```
$ python3 tools/db_test.py portal/supabase/tests/remote_capture_rls_test.sql
130/130 passed on dev (gfkrebuioszsxanjdnsx).
```
Test file md5: `e372c95483521814e72819d420168d79`. The run rolled back. Residue check afterwards:
- 0 captures, 0 capture_worker rows, 0 scan_frames objects;
- 0 `cap-test` auth users, 0 `cap-test` drawers.

Changed tests:
- **test 66** now reads "stage unchanged on complete". dA (backlog, `backlogged_by_admin`) stays
  `backlog backlogged_by_admin` with 0 stage events leaving backlog. It ran red against the old body
  (`scanned created_by_user`, 2 events) before the apply.
- **test 106** now reads "stage unchanged on complete". dA4 stays `backlog created_by_user ready`.

New tests (112–130):
- 112: fixture, capture a6 on dA.
- 113: under service_role, `is_worker()` = true and `auth.uid()` is null.
- 114: claim a6 as attempt 1.
- 115: heartbeat on a live claim returns true.
- 116: an idle heartbeat returns true.
- 117: complete returns done.
- 118: a stale attempt fails with 40001 (the fence holds).
- 119: the `capture_worker` rows are written for `cap-test-sr` and `cap-test-sr2`, with
  `auth_user_id` **null**, the version recorded, and the claim cleared.
- 120: a6 has `attempt_count` 1 and `worker_id` `cap-test-sr`. One `done` attempt is audited with
  `worker_id`, and the attempt has no `by` key.
- 121: dA stays backlog and keeps its earlier photo (fill-if-empty); `capture_state` is ready.
- 122: service_role has EXECUTE on all four RPCs.
- 123–130: the negative cases listed above.

Before the apply, tests 66 and 113–121 were red and the rest were green.

Simulation: `set_config('role','service_role')` with `request.jwt.claims = {"role":"service_role"}`
and no `sub`, which is how PostgREST sets up a service-key request.

### Prod command for Sam (the third one, after the two above, in order)
```
python3 tools/db_apply.py portal/supabase/migrations/20261023140000_pilot_decisions.sql --env prod --approved
```
It needs no `--reload-postgrest`: no function is added or renamed, only replaced, and the column
change does not alter any RPC signature.

### Notes for Sam / reviewer
- **Service role and `auth.uid()`.** Under service_role, `auth.uid()` is null, so the original
  migration would have failed the worker's first claim with 23502 (`capture_worker.auth_user_id NOT
  NULL`). Nothing else on the worker path depends on it.
- **Who can be a worker now.** `is_worker()` trusts the JWT role claim. Any holder of the service-role
  key is a worker (and more) for the pilot. A forged `role` claim requires the JWT secret.
- **Contract amendments.** §5.3 (option (b) withdrawn, so `scanned` = customer confirm) and §3.5/§6
  (a service_role worker; `auth_user_id` nullable) need updating in the contract doc.
- **Rescinding Q1 (a) after the pilot.** Revert the `is_worker()` body and backfill
  `capture_worker.auth_user_id` before any `set not null`.

### Hardware sign-off needed: no
Under Q1 (a) the worker authenticates with the existing service-role key. No worker auth user and no
Mac mini change is needed to verify this schema; dev covers it.
