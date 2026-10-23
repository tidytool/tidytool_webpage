# Review — card 6hq6FjvcjFjVfXfv (T2-L0 remote reconstruction contract)

Round 1: REVISE (3 MUST, 7 SHOULD — all fixed in 09c5a28..3686e72). Round 2 (final, fresh context) below.

VERDICT: APPROVE
Done-when: 0/1 ✓ — the sole criterion ("doc merged to main, Sam reviewed") is the human gate; pending by design. All card scope items covered.
Checks run: typecheck/test/build skipped — docs-only diff (planning/remote-reconstruction-contract.md +1553, verification.md +124; nothing under portal/ or docs/, no migration, no deps, no .env).

## Round-1 items (verified against current text)
- MUST 1 on-device rescan stale chip ✓ — rule (b) Decision (proposed) §5.2 rule 4 (l.572–591); display_state derived server-side in get_my_capture_status (§6 l.671); portal must not re-derive (§9.3 l.1287); Q2 is (b) vs (a), not "optional" (l.1463–1473); §10 "zero changes" scoped (l.1374–1376). Leftover wording gap in §7.3 → SHOULD 1.
- MUST 2 error/timings exposure ✓ — column-level grant excludes error, timings, worker/attempt cols (l.188–195); create_capture returns narrow table (l.722, 743, 824).
- MUST 3 §9 existence claims ✓ — worker CLI marked unmerged, no queue I/O; get_my_drawers listing marked new L1 work.
- SHOULD 1 lock order ✓ — create_capture loop (l.785–796) pointer → predecessor capture → drawer → re-check; no remaining cycle.
- SHOULD 2 FK set-null vs guard ✓ — pg_trigger_depth() > 1 clear-only exception (l.304–309).
- SHOULD 3 bridge option ✓ — option (b) in §5.3; mapping/advance/actor_role confirmed in status_backbone. Snippet gap → SHOULD 2.
- SHOULD 4 worker user Sam-only, email, EmployeesList ✓ — §10 l.1378–1390.
- SHOULD 5 tidyCAD Select guard ✓ — §9.4, §13 card 2.
- SHOULD 6 frame injection ✓ — l.443–450; depends on definer visibility → SHOULD 3.
- SHOULD 7 device-source URL checks ✓ — l.770–779.

## MUST FIX
None.

## SHOULD FIX (left for Sam's call — review rounds exhausted)
1. `planning/remote-reconstruction-contract.md:1151` (§7.3 tidyCAM row) keys "Rescan" off the raw `failed` capture row — reintroduces the MUST 1 symptom inside tidyCAM and contradicts §5.2 rule 4. Drive tidyCAM's chip/action from `get_my_capture_status().display_state`; raw rows for history only.
2. `:960–962` (§6.1 option (b) snippet in complete_capture) — comment says "current capture only" but SQL lacks `and current_capture_id = v.id`. Also the bridge only fires when legacy `status` changes, so a backlog drawer already at `created_by_user` stays in backlog — add to §10 dev checklist.
3. `:1418–1419` (§10 dev check) — `_can_capture_drawer_path` ownership check (l.447–450) and create_capture's frame count (l.760–765) assume the SECURITY DEFINER owner sees all `storage.objects` rows. If not: injection silently passes, create_capture always raises P0001. Mark "second user under an existing prefix → refused" as a hard gate that also proves definer visibility.

## Notes (no action)
- Citation drift: tidyCAD lidar.py cached_scan_path l.91–94 (doc 91–93); work_queue.py ALLOWED_STAGE_WRITES l.40–44 (doc 40–41).
- storage `owner` deprecated upstream for `owner_id`; `owner = auth.uid()` matches house policies and works.
- pg_trigger_depth() is new to this codebase (house pattern is the GUC flag); exception is clear-only and correct.
- Drawer delete cascades capture history; admin_delete_drawer audit snapshot covers only the drawer row; scan_frames objects orphan. §11 defers lifecycle — worth one sentence.
- `_can_capture_drawer_path` granted to authenticated → callable via PostgREST as a "can I capture X" oracle; negligible with uuid ids.
- Confirm in L1 that get_my_drawers shows a creator's drawer with null order_id (`unassigned`, §4.3), else tidyCAM gets no display_state.
- If §5.3 option (a) is chosen, actor_role 'worker' needs a check of status_event readers (portal timeline, tidyCAD work_queue.py:903).

## Systems Engineer
SE VERDICT: COORDINATE (overall PASS WITH NOTES)
Contracts touched: Capture → reconstruction (new); Schema + migrations; Status model (§5.3 only); storage/bucket surface.
- tidyCAM (origin/main, feature/release-1.7.1): unchanged. Remote capture, listing, capture reads are new L1 work (§13 card 4).
- Mac mini worker (agent/6hq8P84Xx6XWVPh6-worker-core): unchanged; claim/heartbeat/upload/complete loop is new (§13 card 3).
- portal: unchanged; EmployeesList must change before the worker user exists (§13 card 1).
- tidyCAD: unchanged reads; Select-on-photo guard is a coordinated follow-up (§13 card 2).
- docs/ /approve, /drawer.html, /q: unchanged. QuickBooks projection: unchanged.
Migration philosophy: expand-only ✓ (new tables, two nullable drawer columns, widened CHECK, new bucket/policies/RPCs; nothing renamed, retyped or narrowed; no backfill).
Required before merge: nothing blocking.

## High-risk items for Sam (CLAUDE.md rule 4) — apply when the migration lane lands, not on this merge
- Prod migration: new tables, user_roles CHECK widening, drawer guard trigger, new RLS + storage policies.
- Auth: creating the worker auth user + sole `worker` role row (dev and prod); email ≠ any customer.email; only after EmployeesList ships.
- RLS/storage: scan_frames policies and the definer-visibility assumption (SHOULD 3).
- Status model: §5.3 choice for backlog→scanned.
- Data deletion: frame retention (Q8), orphan cleanup.
- Decisions: Q1–Q13, especially Q2, Q4, Q10, Q11 (scale for remote drawers — blocks design, not this contract).

Hardware sign-off needed: no — contract document; device steps live on the L1–L3 lane cards.
