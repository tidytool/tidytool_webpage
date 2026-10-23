# verification.md — T2-L0 remote reconstruction contract (Todoist 6hq6FjvcjFjVfXfv)

**Deliverable:** `planning/remote-reconstruction-contract.md`, a docs-only change.

**Done when** (card): the doc is merged to main in tidytool_webpage and Sam has reviewed it.
That is a **human gate**. This branch delivers the doc ready for that review. It is ✗ until Sam
reviews and merges, by design.

**Plan comment:** posted to the Todoist card (comment id `6hq8Vf26fhV3w7cM`).

**Worktree note:** the dispatcher named
`.claude/worktrees/6hq6FjvcjFjVfXfv-contract`, branch
`agent/6hq6FjvcjFjVfXfv-remote-reconstruction-contract`. This implementer session's file writes are
harness-restricted to `.claude/worktrees/agent-a84ceaeb7d4fcfd20`, branch
`worktree-agent-a84ceaeb7d4fcfd20`. Both branches start at the same base, `744015f`.

- All commits are on `worktree-agent-a84ceaeb7d4fcfd20`.
- The `agent/…` branch is untouched at `744015f`.
- To land the commits on the intended branch:
  `git -C .claude/worktrees/6hq6FjvcjFjVfXfv-contract merge --ff-only worktree-agent-a84ceaeb7d4fcfd20`

## Scope items → doc section

Line numbers refer to `planning/remote-reconstruction-contract.md` at commit `3ea3b13`.

| # | Card / dispatcher scope item | ✓/✗ | Where (section, line) |
|---|---|---|---|
| 1 | `capture` table shape: all 12 card columns, `source` device\|worker, `status` queued\|processing\|done\|failed | ✓ | §3.1 (l.125): column table plus target SQL. Extras are marked "proposed". |
| 2 | `scan_frames` bucket paths, private, owner-write | ✓ | §4.1 (l.346) bucket and path convention. §4.2 (l.375) read/write matrix per prefix plus policies (insert-only as owner; no update or delete). |
| 3 | `claim_next_capture()` with FOR UPDATE SKIP LOCKED | ✓ | §6 table (l.559). §6.1 SQL (l.583ff, `limit 1 for update skip locked`). |
| 4 | `worker_heartbeat` | ✓ | §3.3 (l.219) `capture_worker`. §6 / §6.1 RPC. §7.2 (l.994) cadence. |
| 5 | `drawer.capture_state` column, NOT new tracker stages | ✓ | §3.4 (l.239), with the guard trigger making it RPC-only. §5.2 (l.502) and §5.3 (l.524): no `status_def` codes, never touches stage/state. |
| 6 | Capture state machine; `capture_state` on each transition | ✓ | §5.1 (l.465) normative transition table T1–T11, with the `capture_state` column. |
| 7 | Failure → customer sees "Rescan needed" | ✓ | §3.4 mapping table. §7.1 (l.971) error codes. §7.3 (l.1019) per-party view. |
| 8 | Stale-claim recovery (heartbeat timeout → requeue or fail, retry cap) | ✓ | §7.2 (l.994). `_reap_stale_captures` SQL in §6.1. |
| 9 | Idempotency of claim / complete | ✓ | §8 (l.1033), with `attempt_count` fencing. |
| 10 | Which RPCs mediate `capture_state`, and who may call them | ✓ | §6 table (caller column). §5.1 (caller column). Guard trigger in §3.4. |
| 11 | Storage path convention, plus who reads/writes each prefix | ✓ | §4.1, §4.2, §4.3 (l.428): outputs in the existing buckets/paths. |
| 12 | Signed-URL note (key caches on the object path, never the token URL) | ✓ | §4.4 (l.448). |
| 13 | Consumer: tidyCAM | ✓ | §9.1 (l.1056) |
| 14 | Consumer: Mac mini worker | ✓ | §9.2 (l.1086) |
| 15 | Consumer: portal | ✓ | §9.3 (l.1117) |
| 16 | Consumer: tidyCAD, incl. the pixel-vs-normalized corner gotcha | ✓ | §9.4 (l.1137). §5.2 rule 2. §2 grounding. |
| 17 | Expand-only rollout note | ✓ | §10 (l.1164): additive migration, rollback, dev verification checklist. |
| 18 | Illustrative SQL marked as target shape, not applied | ✓ | 7 markers (`TARGET SHAPE — not applied` / "Target-shape SQL (not applied)"). The intro states nothing is applied. |
| 19 | "Decision (proposed)" markers plus "Open questions for Sam" | ✓ | 17 markers. §12 (l.1245) has 12 questions. |
| — | Done-when: merged to main and Sam reviewed | ✗ (human gate) | Needs reviewer, then PR, then Sam. |

## Diff touches only the doc and verification.md

`git diff --stat origin/main` before this file was added:

```
 planning/remote-reconstruction-contract.md | 1291 ++++++++++++++++++++++++++++
 1 file changed, 1291 insertions(+)
```

After this commit the only addition is `verification.md` at the repo root.

- No file under `portal/` changed, including `portal/supabase/migrations/`.
- No file under `docs/` changed.
- No migration was written or applied (dev or prod).
- No code changed and no dependency was added.

## Everything the doc cites as existing actually exists

Produced by a grep script over `portal/supabase/migrations/*.sql` plus file checks. It ran in this
worktree; output excerpt:

```
OK      drawer table (id uuid NOT NULL, no default)  <-  20260628062931_remote_schema.sql:48
OK      drawer.photo_url / point_cloud_url  <-  20260628062931_remote_schema.sql:57
OK      is_admin()  <-  20260628062931_remote_schema.sql:26
OK      is_staff()  <-  20260715191252_staff_role_drawer_access.sql:12
OK      user_roles_role_check (admin,user,staff)  <-  20260715191252_staff_role_drawer_access.sql:9
OK      policy drawers select / drawers update / drawer_insert_authenticated  <-  20260628062931_remote_schema.sql:138/139/131
OK      policy drawer_select_staff / drawer_update_staff  <-  20260715191252_staff_role_drawer_access.sql:27/29
OK      status_def / status_transition  <-  20260727100000_status_backbone.sql:37/86
OK      status_event (+source check)  <-  20260727100000_status_backbone.sql:140
OK      record_status_event()  <-  20260727100000_status_backbone.sql:254
OK      drawer_stage_bridge() insert default  <-  20260727100000_status_backbone.sql:448
OK      set_drawer_stage() / set_drawer_state()  <-  20260727100000_status_backbone.sql:582/647
OK      set_order_state() / set_order_override()  <-  20260727100000_status_backbone.sql:681/708
OK      get_order_tracker() / get_work_queue() / get_status_pipeline()  <-  20260727100000_status_backbone.sql:762/855/891
OK      drawer in supabase_realtime  <-  20260727100000_status_backbone.sql:173
OK      get_my_drawers() v2 (customer join)  <-  20260706000000_portal_durable_model_and_admin.sql
OK      _customer_can_see_drawer() (+ revoked from authenticated)  <-  20260803120000_customer_tool_labels.sql:66/486
OK      get_my_label_status() / drawer_label deny-all  <-  20260803120000_customer_tool_labels.sql:449/40
OK      storage policy drawer_assets_insert  <-  20260703220000_baseline_storage_policies.sql:34
OK      storage policy "Allow authenticated uploads to lidar_scans"  <-  20260703220000_baseline_storage_policies.sql:61
OK      capture_quality enum / set_capture_quality()  <-  20260721175633_…:6 / 20260721175808_…:4
OK      drawer.claimed_by (design claim)  <-  20260812210000_drawer_claims_and_progress.sql
OK      record_scan_correction()  <-  20260714040206_scan_correction_audit_rails.sql:47
NEW(ok) capture, capture_worker, capture_state, current_capture_id, scan_frames, claim_next_capture,
        worker_heartbeat, create/complete/fail_capture, is_worker  (0 migration files mention them: no name clash)
NEW(ok) is_approved()  (0 files; the doc correctly cites it as NOT yet existing)
OK      planning/TIDYCAM-launch-coordination.md, planning/ARCHITECTURE.md, portal/supabase/migrations/README.md,
        portal/src/components/LabelEditor.tsx:7 ("photo_url IS the ortho render"), portal/src/app/page.tsx:254
        (rpc get_my_drawers), portal/src/app/admin/queue/page.tsx, portal/src/app/admin/employees,
        tools/db_apply.py, .claude/team.json:41 (contract_globs "planning/*contract*.md")
```

The sibling-repo facts (tidyCAM and tidyCAD storage paths, caches, corner conventions) come from a
read-only survey of `/Users/sam/Documents/Development/tidyCAM` and `…/tidyCAD`, with file:line
citations held by the implementer. Neither repo was modified.

## Independent verifier pass

The `verifier` subagent read the full doc and returned **PASS** on:

- all 12 card columns, with the exact status and source values;
- every other scope item;
- SQL labelled as target shape, with no migration files;
- an SQL sanity read: SKIP LOCKED syntax is valid, and the check constraints are consistent with
  T1–T11;
- no raw status writes, and no `drawer_count`/`drawer_ids` change.

It raised one non-blocking risk: the proposed `backlog → scanned` advance in §5.3 did not name a
compliant writer. **Fixed in `3ea3b13`.** §5.3 now specifies the internal
`_capture_advance_stage()`, a set_drawer_stage-equivalent with a single hard-coded sanctioned
transition. It is called only from `complete_capture`, and `stage` is never raw-updated.

## Checks not run

This is a docs-only change: no file under `portal/` changed. `npm run typecheck`, the
`npm run test:*` suites and `npm run build` were not run because they cannot be affected. No dev
server or browser walk-through applies.

## Pre-existing failures

None observed. None were looked for beyond the above, because no code was touched.

## Hardware sign-off needed: no

This is a contract document. The lanes that implement it (tidyCAM upload, Mac mini worker) will
need device sign-off in their own cards.
