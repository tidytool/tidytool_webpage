# Review — T2-L1 capture schema (card 6hq6FjxP4V9rj3GM)

Written down by the dispatcher. The reviewer and the systems-engineer lens are read-only and return
their verdicts as text, so their substance is recorded here.

## Final verdict (reviewer, round 2)

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