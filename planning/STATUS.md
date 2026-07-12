# TidyTool Status — 2026-07-12

_Written by the PM agent. Playbook: `planning/pm-agent.md`. Overwritten each run — history in git._

## Project version snapshot

- Phase 0 — Stop the bleeding: ✅ 100%
- Phase 1 — Credibility core: ✅ 100%
- Phase 2 — Local visibility: ~60% — dev side done; remaining gap is Sam-side GBP registration + postcard verification
- Phase 3 — Depth/inbound: 0% (gated on rebrand decision, Sept 2026)
- Phase 4 — Customer portal: ~90% — portal + admin CRM + notifications live. Open: T3.7 est-delivery, T4 timeline, tidyCAM security gate, label entry (blocked on tidyCAM)

## Shipped since last check (2026-07-09)

- No code shipped — quiet three days (only the last PM commit).
- **Advisor check (this run, prod):** the leaked-password-protection and Postgres-patch warnings **no longer appear** in the security advisor — it looks like Sam completed the dashboard toggles. Sam: confirm, and this drops off the list for good. Remaining advisor items are known/intentional (SECURITY DEFINER RPCs guarded by `is_admin()`, anon RPCs for the public QR/approval pages) plus queued housekeeping: `pg_net` in public schema, and `drawer_backup_2026_05_02` / `_archive_customer_2026_07_03` backup tables still present (RLS-on, no policies — locked but should be dropped).

## Next steps by impending ROI

1. **tidyCAM pre-launch security gate** (`planning/TIDYCAM-launch-coordination.md`) — unchanged #1. (a) Rotate DB password (~10 min, Sam — credential shipped in mobile builds until 2026-07-05); (b) approval-gate RLS before TestFlight invites (~0.5 day, needs Sam's high-risk review); (c) storage tightening (branch-test first). Why now: launch blocker + live credential exposure, decaying since 2026-07-05.
2. **GBP registration** [Sam, ~1 hr] — the single remaining lever on the lead-gen pillar; starts an 8-week postcard clock. Checklist ready: `planning/gbp-setup-checklist.md`. Highest value-per-hour on the board.
3. **T3.7 — Estimated delivery date** (~0.5 day + migration review) — data model decided (nullable `order.estimated_delivery`); admin edit/create + portal display. Small, customer-visible, feeds T4. With auth toggles apparently done, this moves up.
4. **T4 — lifecycle timeline** (~1 day) — `drawer_event` RLS, status-trigger → events, portal "pizza tracker". Natural follow-on once T3.7 lands.
5. **DB housekeeping** (~1 hr, low risk but prod-touching so Sam sign-off) — drop `drawer_backup_2026_05_02` + `_archive_customer_2026_07_03`, delete `[TEST]` drawers, move `pg_net` out of public. Confirmed still present this run.

Deliberately parked: label entry (blocked on tidyCAM tool names), CRM v2, reorders/saved designs.

## Waiting on Sam

- **Rotate the Supabase database password** (urgent — exposed in past mobile builds)
- Review/approve tidyCAM approval-gate + storage-tightening migrations (auth/RLS — high-risk gate)
- **Confirm dashboard toggles done** (leaked-password protection + Postgres patch) — advisor no longer flags them; one word closes this item
- **GBP registration + postcard verification** — the only thing holding Phase 2 back
- Rebrand decision — September 2026
- Rotate Discord approval webhook (plaintext exposure 2026-06-28)
- Owner-side conversion items: Tally "How did you hear about us?" → optional; 1–2 additional testimonials; higher-res install photos
- Disposition of `planning/FEATURE-approval-changelog.md` (flagged 2026-07-07, still unanswered): `drawer_event` + `log_design_revision` shipped since the spec — confirm superseded so it can be pruned
- Disposition of `planning/customer-interview-form.pdf` (flagged 2026-07-09, still unanswered) — confirm keep/delete

## Cleanup log (this run)

- Nothing pruned — no work completed since 2026-07-09, and both prune candidates (`FEATURE-approval-changelog.md`, `customer-interview-form.pdf`) are still awaiting Sam's disposition, so they stay per guardrails. Repo memory and auto-memory verified current (durable facts only); TODO scan of `docs/` + `portal/` source: clean.
