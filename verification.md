# verification.md — T2-L0 remote reconstruction contract (Todoist 6hq6FjvcjFjVfXfv)

**Deliverable:** `planning/remote-reconstruction-contract.md`. This is a docs-only change.

**Done when** (card): the doc is merged to main in tidytool_webpage and Sam has reviewed it. That
is a **human gate**. This branch delivers the doc ready for that review, so the item stays ✗ until
Sam reviews and merges it. That is by design.

**Plan comment:** posted to the Todoist card (comment id `6hq8Vf26fhV3w7cM`).

**Branch:** the commits are made in worktree `.claude/worktrees/agent-a84ceaeb7d4fcfd20` on
`worktree-agent-a84ceaeb7d4fcfd20`. The coordinator fast-forwards
`agent/6hq6FjvcjFjVfXfv-remote-reconstruction-contract` to that tip. The `agent/` branch carried
the round-0 commits through `be7eff1`, and the round-1 commits sit on top.

## Scope items → doc section

Line numbers refer to `planning/remote-reconstruction-contract.md` as of review round 1.

| # | Card / dispatcher scope item | ✓/✗ | Where (section, line) |
|---|---|---|---|
| 1 | `capture` table shape: all 12 card columns, `source` device\|worker, `status` queued\|processing\|done\|failed | ✓ | §3.1 (l.127): column table plus target SQL. The extras are marked "proposed". |
| 2 | `scan_frames` bucket paths, private, owner-write | ✓ | §4.1 (l.374): bucket, path convention, closed-after-create rule. §4.2 (l.415): read/write matrix and policies. |
| 3 | `claim_next_capture()` with FOR UPDATE SKIP LOCKED | ✓ | §6 table (l.656). §6.1 SQL (`limit 1 for update skip locked`). |
| 4 | `worker_heartbeat` | ✓ | §3.3 (l.228). §6 and §6.1. §7.2 (l.1121). |
| 5 | `drawer.capture_state` column, NOT new tracker stages | ✓ | §3.4 (l.248) with the guard trigger. §5.2 (l.551) and §5.3 (l.593). |
| 6 | Capture state machine; `capture_state` on each transition | ✓ | §5.1 (l.514), transitions T1–T11. |
| 7 | Failure → customer sees "Rescan needed" | ✓ | §3.4. §5.2 rule 4. §7.1 (l.1098). §7.3 (l.1146). |
| 8 | Stale-claim recovery (heartbeat timeout → requeue or fail, retry cap) | ✓ | §7.2. `_reap_stale_captures` in §6.1. |
| 9 | Idempotency of claim and complete | ✓ | §8 (l.1160): fencing plus lock order. |
| 10 | Which RPCs mediate `capture_state`, and who may call them | ✓ | §6 table and §5.1 caller column. Guard trigger in §3.4. |
| 11 | Storage path convention; who reads and writes each prefix | ✓ | §4.1, §4.2, §4.3 (l.477). |
| 12 | Signed-URL note | ✓ | §4.4 (l.497). |
| 13–16 | Consumers: tidyCAM, worker, portal, tidyCAD (incl. pixel vs normalized corners) | ✓ | §9.1 (l.1198), §9.2 (l.1243), §9.3 (l.1278), §9.4 (l.1308). |
| 17 | Expand-only rollout | ✓ | §10 (l.1350). |
| 18 | SQL marked as target shape, not applied | ✓ | `TARGET SHAPE — not applied` markers, plus the §6.1 heading. |
| 19 | "Decision (proposed)" markers and "Open questions for Sam" | ✓ | 18 markers. §12 (l.1456), 13 questions. §13 (l.1532), follow-up cards. |
| — | Done-when: merged to main and Sam reviewed | ✗ (human gate) | — |

## Review round 1: fixes

| Item | ✓ | Fix and where |
|---|---|---|
| MUST 1: on-device rescan leaves stale "Rescan needed" | ✓ | Rule (b) chosen as **Decision (proposed)**. §5.2 rule 4: the customer chip is derived server-side in `get_my_capture_status().display_state` and is suppressed once `photo_url` exists. It cites tidyCAM's direct `photo_url` write (`supabase_order_service.dart` ≈l.278, `feature/release-1.7.1`). §9.1 states that the on-device path does not create captures. Q2 is rewritten from "optional" to (b) recommended vs (a) alternative. §10 "zero changes" is scoped to the existing on-device-only path. §7.3 customer row updated. |
| MUST 2: `error` / `timings` exposed to the creator | ✓ | §3.1 SQL: column-level `grant select (…)` without `error`, `timings`, worker or attempt columns (l.193), and `select=*` is refused by design. `create_capture` returns the narrow `table(capture_id, drawer_id, source, status, created_at)` (l.722). `get_my_capture_status` returns no error or timings. A §12 note marks this as resolved. |
| MUST 3: §9 existence claims without merged citations | ✓ | §9.2: the `tidycam-worker` CLI is marked as existing only on the unmerged tidyCAM `agent/6hq8P84Xx6XWVPh6-worker-core`, with no claim, heartbeat or bucket I/O. §9.1: everything is new L-lane work unless cited, and listing via `get_my_drawers()` is new L1 work (tidyCAM does not call it). Citations now point to tidyCAM `origin/main` `supabase_order_service.dart` l.485/532/803, tidyCAD `origin/main` `photo_cache.py` l.51, `lidar.py` l.91–93 and `work_queue.py` l.40–41/62–65, and portal `page.tsx` l.254 and `EmployeesList.tsx` l.73–74/211/219. §2 names the checkouts the survey read. |
| SHOULD 1: lock order / 40P01 | ✓ | `create_capture` reads the pointer unlocked, locks the predecessor capture, then the drawer, re-checks, and raises `40001` after 3 tries (l.782ff). §8 states the global order (capture before drawer) and makes `40001`/`40P01` retryable. A §10 dev check covers concurrent create plus complete. |
| SHOULD 2: guard trigger vs FK `on delete set null` | ✓ | The guard allows `pg_trigger_depth() > 1` nulling only `current_capture_id`, and clears `capture_state` with it (l.302–310). §3.4 note on the FK cycle. §10 dev checks delete a drawer with captures and a capture row directly. |
| SHOULD 3: bridge option for backlog→scanned | ✓ | §5.3 presents option (b), the `drawer_stage_bridge` legacy `status = 'created_by_user'` write (`20260727100000_status_backbone.sql` l.471–479), alongside option (a) `_capture_advance_stage`, with pros and cons. (b) is recommended for the pilot. Updated in the `complete_capture` comment, §6 table, §10 item 6 and Q4. |
| SHOULD 4: worker user is Sam-only; email and EmployeesList | ✓ | §10: Sam creates the user on dev and prod. The email must not match `customer.email` (`link_customer_on_auth`, `20260704000000_durable_identity.sql` l.114–141). The user holds only the `worker` role, and is created only after the EmployeesList change ships. §9.3: EmployeesList change specified (worker badge, actions hidden, server actions refuse). Q13 and §13 card 1 added. |
| SHOULD 5: tidyCAD Select on photo-less drawers | ✓ | §9.4: a required coordinated follow-up to guard Select while `photo_url is null`, citing `work_queue.py` l.40–41/62–65. §13 card 2. |
| SHOULD 6: frame injection by org members after create | ✓ | `_can_capture_drawer_path` now also requires that no `capture` row exists for segment 2 and that no object under the prefix is owned by someone else (l.438ff). §4.1 rewrites the 409 note to pre-create only, and post-create uploads are refused. §4.2 row and §10 dev check updated. |
| SHOULD 7: device-source URL checks | ✓ | `create_capture(source='device')` applies the same `/drawer-assets/<drawer_id>/` and `/lidar_scans/<drawer_id>/` checks as `complete_capture` (l.774). §10 dev check added. |
| Also: open questions and follow-up list | ✓ | Q13 covers who creates and administers the worker user. Error visibility is resolved, not open. §13 lists coordinated follow-up cards (EmployeesList, tidyCAD Select guard, worker CLI queue I/O, tidyCAM remote capture plus listing, tidyCAM device captures if rule (a), worker-user runbook). |

## Diff touches only the doc and verification.md

`git diff --stat origin/main` at the round-1 tip:

```
 planning/remote-reconstruction-contract.md | 1553 +++++++++++++++
 verification.md                            |  (this file)
 2 files changed
```

- No file under `portal/` or `docs/` changed.
- No migration was written or applied, on dev or prod.
- No code changed, and no dependency was added.

## Everything the doc cites as existing actually exists

Round 0: a grep script over `portal/supabase/migrations/*.sql` plus file checks. Every cited object
was found, and every new name has zero hits, so there is no clash. The excerpt is kept from the
round-0 run:

```
OK drawer table (id uuid NOT NULL, no default) <- 20260628062931_remote_schema.sql:48
OK is_admin() <- 20260628062931_remote_schema.sql:26 · is_staff() <- 20260715191252_staff_role_drawer_access.sql:12
OK user_roles_role_check <- 20260715191252_staff_role_drawer_access.sql:9
OK drawers select/update, drawer_insert_authenticated <- 20260628062931_remote_schema.sql:138/139/131
OK drawer_select_staff / drawer_update_staff <- 20260715191252_staff_role_drawer_access.sql:27/29
OK status_def / status_transition / status_event source check <- 20260727100000_status_backbone.sql:37/86/140
OK record_status_event / drawer_stage_bridge / set_drawer_stage / set_drawer_state <- 20260727100000_status_backbone.sql:254/448/582/647
OK get_order_tracker / get_work_queue / get_status_pipeline <- 20260727100000_status_backbone.sql:762/855/891
OK _customer_can_see_drawer (+revoked from authenticated) / get_my_label_status <- 20260803120000_customer_tool_labels.sql:66/486/449
OK drawer_assets_insert / lidar_scans upload policy <- 20260703220000_baseline_storage_policies.sql:34/61
OK capture_quality / set_capture_quality / drawer_claimed_by_idx / record_scan_correction
NEW(ok) capture, capture_worker, capture_state, current_capture_id, scan_frames, claim_next_capture,
        worker_heartbeat, create/complete/fail_capture, is_worker, is_approved: 0 migration hits
```

Round 1 added citations, each checked in this session:

- `link_customer_on_auth`: `20260704000000_durable_identity.sql` l.114–141 (read).
- Legacy bridge: `20260727100000_status_backbone.sql` l.471–479 (read).
- `portal/src/components/EmployeesList.tsx` l.73–74/211/219 (grep).
- tidyCAM `origin/main` `lib/services/storage/supabase_order_service.dart` l.485/532/803 (`git grep origin/main`).
- tidyCAM direct `photo_url` update ≈l.278 on `feature/release-1.7.1`, the local checkout (`sed`).
- tidyCAM `agent/6hq8P84Xx6XWVPh6-worker-core` exists locally and on origin, and is unmerged
  (`git branch -a`).
- tidyCAM `origin/main` has no `get_my_drawers` call (`git grep`, 0 hits).
- tidyCAD `origin/main` `tidytool/services/work_queue.py` l.40–41/62–65, `photo_cache.py` l.51 and
  `lidar.py` l.91–93 (`git grep origin/main`, plus a read of `work_queue.py`).

## Independent verifier pass (round 0)

The `verifier` subagent returned PASS on every scope item, the SQL sanity read, and the
no-raw-status-write check. Its one risk, an unnamed stage writer in §5.3, was fixed in `3ea3b13`
and extended in round 1 with option (b).

## Checks not run

This is docs-only: nothing under `portal/` changed, so `npm run typecheck`, the `npm run test:*`
suites and `npm run build` were not run, because they cannot be affected. No dev server or browser
walk-through applies.

## Pre-existing failures

None observed. None were looked for beyond the checks above, because no code was touched.

## Hardware sign-off needed: no

This is a contract document. The implementing lanes (tidyCAM upload, the Mac mini worker) need
device sign-off in their own cards.
