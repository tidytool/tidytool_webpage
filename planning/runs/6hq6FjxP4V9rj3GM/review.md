# Review — T2-L1 capture schema (card 6hq6FjxP4V9rj3GM)

Written down by the dispatcher. The reviewer and the systems-engineer lens are read-only and return
their verdicts as text, so their substance is recorded here.

## Round 3 — pilot decisions (commit 01454f1): reviewer APPROVE · SE lens COORDINATE

```
VERDICT: APPROVE
Done-when (round 3 scope): 5/5 ✓ (Q1a service_role worker; auth.uid() null handled; Q4 bridge
removed; tests flipped/added; byte-exact dev-only apply). Prod apply is Sam's.
Checks run: typecheck ✓ · test:pricing ✓ 36/36 · test:labels ✓ 11/11 · build skipped (no portal/src)
· db_test ✓ 130/130 on dev · db_apply --check dev: 26 byte-verified (DIVERGED only from the known
20260910* LOCAL ONLY)
MUST FIX: none
Hardware sign-off needed: no
```
- **Byte-exact.** File md5 = dev history md5 = `000c2b409c2c7d701fdb95b42d90aef7`. 120000 and
  130000 are untouched.
- **Draft apply/revert.** The implementer applied a draft of 140000 to dev before the
  auth_user_id finding, then reverted it (restored the bodies and deleted the history row) and
  applied the final file. The reviewer compared md5(prosrc) on dev with the final files for
  is_worker, complete_capture, claim_next_capture, worker_heartbeat and fail_capture: all match,
  and nothing from the draft remains.
- **complete_capture.** The only change is the removed §5.3(b) block. Lock order, replay check and
  the attempt_count fence are identical; test 118 shows the fence under service_role.
- **auth_user_id drop not null.** Safe: the claim/heartbeat upserts are the only writers, nothing
  reads the column, and it has no FK or unique constraint.
- **is_worker().** For every authenticated JWT the new disjunct is false; anon has no EXECUTE; with
  no claims, coalesce(auth.role(), '') makes it false. Tests 123–130 are the negatives.
- **Note.** Any service-role-key holder can now drive the queue: the Q1 (a) blast radius, accepted
  for the pilot. The worker must call through PostgREST; a direct Postgres connection has no
  claims and gets 42501.

**SE lens: COORDINATE.**
- No consumer breaks: portal admin.ts only calls auth.admin.*; publish_for_approval.py doesn't
  branch on is_worker(); every is_worker() policy is `to authenticated`.
- Removing the Q4 bridge write only affected `backlog` rows, so the insert-time `scanned` gap is not
  worse.
- Doc fixes F1–F3 and the reviewer's contract notes are committed on the #38 branch (f1a7605,
  e92f3f8; unpushed, Sam pushes).
- F3 needs Sam's confirmation: a staff-pre-created drawer reaches `scanned` only by a staff
  advance. That is on the needs-sam card "Confirm 2 gaps in the Oct 23 decisions…".

## Verdict (reviewer, round 2)

```
VERDICT: APPROVE
Done-when: 3/3 ✓ (applied to prod is ✗, Sam-only; not counted)
Checks run: typecheck ✓ · test:pricing ✓ 36/36 · test:labels ✓ 11/11 · build skipped (no portal/src
or server code) · db_test ✓ 111/111 on dev, re-run by the reviewer · db_apply --check dev: both new
migrations byte-verified (25, up from 23); DIVERGED only because of the pre-existing local-only
20260910175336 / 20260910175529
MUST FIX: none
SHOULD FIX: the lock-order claim was overstated. Corrected in verification.md; the applied migration
header stays as is.
Hardware sign-off needed: no
```

## Round 1 — reviewer: REVISE (resolved)
- **MUST FIX 1: fixed.** `worker_heartbeat` locked capture_worker before capture, while
  complete_capture and fail_capture lock capture first, so the heartbeat could deadlock with them
  (40P01). A beat on an unknown capture raised 23503.
  - The fix is a follow-up, `20261023130000_worker_heartbeat_lock_order.sql`: a body-only
    `create or replace` that updates capture first.
  - Tests #57, #103 and #110 failed before the follow-up and pass after it.
- **MUST FIX 2: escalated to Sam.** The contract on PR #38 has drifted from what was built.
- **SHOULD FIX: done.** Test #106 pins the §5.3(b) no-op edge. verification.md now cites only #28
  and #32 as proof of the deny-worker policies.

## Systems-engineer lens: ESCALATE (open, on Sam)
No consumer breaks: tidyCAM, tidyCAD, the portal, docs/ `/q/` and `/approve/`, and the QuickBooks
projection are unchanged. The change is expand-only: the one drop/re-add widens
`user_roles_role_check`. Round 2 re-check: "OK-with-notes, heartbeat deadlock genuinely fixed."

Merge is blocked on Sam (needs-sam card "T2-L1 capture schema: decide Q1/Q4/Q7/Q9 on PR #38 + accept
new RLS policies"):
- **D6 — §12 Q4(b), not yet approved by Sam.** The worker advances drawers backlog→scanned through
  `drawer_stage_bridge`, attributed as `customer`, which makes it a new indirect stage writer. If
  Sam declines, a follow-up migration removes 20261023120000 l.518-523.
- **D5 — Q7 numbers frozen.** 20–400 frames, 25 MB, 3 min stale, 45 min cap, 3 attempts. Q1 and Q9
  are also taken as recommended.
- **D1 — new RLS on core tables (human gate).** RESTRICTIVE `order_deny_worker`,
  `drawer_deny_worker` and `customer_deny_worker`. They are needed: without them,
  `*_insert_authenticated` would let the worker insert orders and drawers.
- **D2–D4 — beyond the contract.** requeue/cancel require a reason and log `requeued`/`cancelled`;
  get_capture_queue is capped at 500 rows; a null `p_source` is rejected.
- **D7 — not tested live.** Concurrent claim and concurrent create-vs-complete. db_test.py runs a
  single session.
- **D8 — admin-delete path not exercised for real.** Dev lacks 20260910175336, so it needs a
  `with_data` branch of prod. Admin delete also cascades captures without an audit snapshot and
  orphans scan_frames objects.

## Contract amendments PR #38 must absorb
- **§3.5 / §10:** the deny-worker policies (fix "no existing policy changes"; add them to the
  rollback list).
- **§3.2:** the attempt outcomes `failed`, `retry`, `requeued`, `cancelled`, with `by` and `reason`.
- **§6:** requeue/cancel reason and error cases; the 500-row cap, ordering and customer_name
  fallback; null-source rejection; the new `worker_heartbeat` body; "pure upsert" →
  "returns false and clears the pointer on a non-live claim".
- **§3.3:** `capture_worker.current_capture_id` = the live claim, else null.
- **§8:** state the real per-RPC lock order (see verification.md) and drop "the heartbeat touches
  only capture".
- **§5.3(b):** scoping to the current capture, and the no-op edge for a backlog drawer whose status
  is already `created_by_user`.
- **§9.1 / §9.4:** never write back a stale full drawer row; drawer→capture embeds need an FK hint
  (PGRST201).
- **§10 / §11:** what admin delete does to captures and frames.
- **§10 grounding:** `link_customer_on_auth` is missing on dev; check prod before creating the
  worker user.

## Remaining theoretical deadlock (accepted)
`claim_next_capture` locks capture_worker then drawer; complete/fail lock drawer then
capture_worker. A cycle needs claim and complete to run at once on a shared drawer, which the
serial worker loop does not do, and §8 treats 40P01 as retryable. A possible later fix: in
complete/fail, update capture_worker before writing the drawer.