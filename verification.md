# verification.md: T2-L1 capture schema + RLS (Todoist 6hq6FjxP4V9rj3GM)

Branch `agent/6hq6FjxP4V9rj3GM-capture-schema`. Contract: `planning/remote-reconstruction-contract.md`
on PR #38 (unmerged). Every "Decision (proposed)" is implemented as the §12 recommendation, including
Q4 option (b) and Q9 (the bucket is created in the migration).

## Plan (also posted as a comment on the card)
1. One expand-only migration: `portal/supabase/migrations/20261023120000_remote_capture_queue.sql`.
2. Apply it to dev only with `db_apply`, then run `--check` on dev.
3. RLS and behaviour tests: `portal/supabase/tests/remote_capture_rls_test.sql`, run by the dev-only runner `tools/db_test.py`.
4. This file. No prod apply, no push, no PR.

## Done-when

| Criterion | | Evidence |
|---|---|---|
| Migration in `portal/supabase/migrations/`, expand-only | ✓ | `20261023120000_remote_capture_queue.sql`. Everything is additive: new tables, columns, functions, policies and the bucket. The only `drop` replaces `user_roles_role_check` with a strictly wider check (`+ 'worker'`) in the same transaction, as contract §3.5/§10.1 specifies. |
| Applied to **dev** via db_apply | ✓ | See "Dev apply" below. |
| Applied to **prod** via db_apply | ✗ | **Pending Sam.** Command below. |
| RLS tests green | ✓ | 105/105 on dev. See "RLS tests" below. |
| Migration synced byte-exact into the repo | ✓ | File md5 == dev history md5 `dab876d045763014c8ce1d2458c32268`. The file has a header comment and no trailing newline, and db_apply stores the file bytes verbatim. |
| Typecheck clean | ✓ | `npm run typecheck`: exit 0. `types.ts` is untouched, so no build is needed. |

### Prod command for Sam
```
python3 tools/db_apply.py portal/supabase/migrations/20261023120000_remote_capture_queue.sql --env prod --approved --reload-postgrest
```
`--reload-postgrest` is there because the migration adds REST-exposed RPCs. Without it, run
`python3 tools/db_apply.py --reload-postgrest --env prod` afterwards.

### Dev apply
```
$ python3 tools/db_apply.py portal/supabase/migrations/20261023120000_remote_capture_queue.sql --env dev --reload-postgrest
Applied 20261023120000_remote_capture_queue.sql to dev (gfkrebuioszsxanjdnsx). History md5 verified: dab876d045763014c8ce1d2458c32268.
PostgREST schema cache reloading on dev (gfkrebuioszsxanjdnsx); ...

$ md5 -q portal/supabase/migrations/20261023120000_remote_capture_queue.sql
dab876d045763014c8ce1d2458c32268
dev: select md5(array_to_string(statements, E';\n')) ... where version='20261023120000'  ->  dab876d045763014c8ce1d2458c32268

$ python3 tools/db_apply.py --check --env dev
  20260910175336 admin_cleanup_controls                        LOCAL ONLY — not applied to dev
  20260910175529 admin_order_detail_drawer_state               LOCAL ONLY — not applied to dev
DIVERGED: 55 local file(s), 53 row(s) on dev; 24 byte-verified, 29 recorded without byte-faithful content.
```
The DIVERGED status is **pre-existing** (see below). Before this apply the check showed the same two
rows and 23 byte-verified files. After it, 24 are byte-verified; the new one is this migration.

### RLS tests
```
$ python3 tools/db_test.py portal/supabase/tests/remote_capture_rls_test.sql
105/105 passed on dev (gfkrebuioszsxanjdnsx).
```
How the suite works:
- It runs as one transaction that ends in `ROLLBACK`. Every fixture lives inside it: 4 auth users,
  roles, 2 customers, 2 orders, 4 drawers and 147 storage objects.
- It simulates callers with `set_config('role', 'authenticated'|'anon')` plus `request.jwt.claims`.
- A check afterwards confirmed nothing was left on dev: 0 captures, 0 capture_workers, 0 `cap-test` users,
  0 scan_frames objects, 0 drawers with `capture_state`/`current_capture_id`, and the
  `status_event_no_delete` trigger still enabled.

The card's required tests:
- **A customer cannot read another customer's frames.** Covered by #17 and #22 (storage objects) and
  #91 (capture rows). anon is covered by #9 and #24. Frames are immutable (#23), and both injection
  cases are refused: after create_capture (#40) and into another user's prefix (#19).
- **The worker cannot select, insert, update or delete `order`.** Covered by #27–#30. The worker also
  cannot select or insert `drawer` (#31, #32), cannot select `customer` (#33), and cannot write
  `capture` (#34).

Cheap contract invariants also asserted:
- **Column grant.** `select error, timings` and `select *` as the creator → 42501 (#41, #42). The
  named columns work (#43). The grant lists exactly the 11 client columns (#3).
- **Narrow shape.** create_capture returns the narrow client shape (#5).
- **Bucket.** scan_frames is private and has no update/delete policy (#6, #7).
- **§10 dev-verification checklist.** Every item that one session can test passes:
  - auth: 42501/P0001/queued (#35, #37, #38);
  - the guard trigger (#46–#49, #52);
  - fencing, replay and fill-if-empty (#59–#62, #69);
  - the reaper requeue and `retries_exhausted` (#58, #79–#82);
  - supersede and the late finisher (#93–#99);
  - photo wins (#74);
  - device URL prefix (#44);
  - both deletes in the FK cycle (#100–#103);
  - search_path pinned on every new function (#104).
- **§5.3 (b).** A backlog drawer advances to scanned through `drawer_stage_bridge`, with one bridge
  `status_event` (#65).

**Not covered** (each needs two concurrent sessions): concurrent `claim_next_capture` handing out
different rows, and concurrent `create_capture`/`complete_capture` finishing without 40P01. Both rely
on `FOR UPDATE SKIP LOCKED` and the §8 lock order as written.

The drawer-delete test (#102) disables `status_event_no_delete` inside the rolled-back transaction.
`status_event` is append-only, and on dev that blocks *every* drawer delete, with or without captures.
Prod's purge path (`tidytool.allow_audited_purge`, migration 20260910175336) is not on dev yet.

### Advisors (dev, security)
There are no new `function_search_path_mutable` findings. The new findings are all in the existing,
intentional classes:
- `capture_worker` shows "RLS enabled, no policy". That is intentional deny-all, the same house
  pattern as `drawer_label`.
- The new RPCs show "authenticated can execute SECURITY DEFINER". This is the house posture: each
  RPC does its own role check.

## Deviations / additions beyond the contract's target SQL (for the reviewer and the contract amendment)
1. **RESTRICTIVE `*_deny_worker` policies on `order`, `drawer` and `customer`.** The existing
   `order_insert_authenticated` (`with check created_by = auth.uid()`) and
   `drawer_insert_authenticated` would have let a worker user insert rows, which breaks the §3.5
   invariant and the card's "worker cannot touch order". The policies are additive. The predicate is
   wrapped as `(select is_worker())` so it is evaluated once per statement.
2. **`requeue_capture` / `cancel_capture` audit.** Both append a `timings.attempts` entry with outcome
   `requeued` or `cancelled` (plus `by` and `reason`); cancel adds one only if the capture was
   processing. Both require a non-empty reason. §3.2 lists only lost/done/failed/retry, so the new
   outcomes should be added to the contract.
3. **`get_capture_queue` limits.** It returns at most 500 captures, newest first. `customer_name` is
   `order.customer_name`, falling back to `customer.name`.
4. **Option (b) write is scoped to the current capture.** The legacy `status = 'created_by_user'`
   write also requires `current_capture_id = capture.id`, matching §5.2 rule 1.

## Pre-existing failures
- `db_apply --check --env dev` was already DIVERGED before this change.
  `20260910175336_admin_cleanup_controls` and `20260910175529_admin_order_detail_drawer_state` exist
  locally but not on dev. They were not applied here because they are out of scope.
- Dev `auth.users` has no `link_customer_on_auth` trigger, which contract §10 assumes exists. This
  needs checking on prod before Sam creates the worker user.
- typecheck, `test:pricing` (36/36) and `test:labels` (11/11) were green on the clean tree.

## Hardware sign-off needed: no
This is a schema-only change, verified on dev. The prod apply and creation of the worker user (§10)
are Sam's steps, and the worker user must wait until the EmployeesList worker-role change (§13.1)
has shipped.
