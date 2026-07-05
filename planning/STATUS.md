# TidyTool Status — 2026-07-05 (evening refresh)

_Written by the PM agent. Playbook: `planning/pm-agent.md`. Overwritten each run — history in git._

## Project version snapshot

- Phase 0 — Stop the bleeding: ✅ 100%
- Phase 1 — Credibility core: ✅ 100% — landing conversion redesign merged; `[TODO]` placeholders no longer present in docs/
- Phase 2 — Local visibility: ~5% — **now the biggest gap.** GBP not started (8-week clock), landing pages + LocalBusiness schema unbuilt
- Phase 3 — Depth/inbound: 0% (gated on rebrand decision, Sept 2026)
- Phase 4 — Customer portal: ~85% — portal live, durable identity model applied to prod, admin CRM v1 shipped (T3–T3.6). Open: notifications, CRM v2, label entry (blocked on tidyCAM)

## Shipped since last check (same-day burst)

- T3: portal on durable model + admin pipeline view
- T3.5a/b/c: admin CRM — audit trail, edit/merge/search RPCs, filterable orders UI, bulk ops, org tab, manual creation
- T3.6: admin invite-to-portal + Tally issue link on empty dashboard
- Landing conversion redesign merged (#5); hero photo cleanup
- **All staged migrations applied to prod** (verified via `list_migrations`): storage-policies baseline, durable_identity, and the full admin CRM set — yesterday's #2 blocker is cleared

## Next steps by impending ROI

1. **SMTP + notifications track** — custom SMTP (Resend/Postmark, ~1h Sam dashboard + DNS) then approval-request/status emails per `planning/ARCHITECTURE.md`. Why now: portal + CRM generate state changes nobody is told about; the approval loop IS the revenue path, and SMTP is the last hard blocker. Effort: 1h Sam + ~0.5 day dev.
2. **Close remaining auth hygiene** — leaked-password protection still OFF and Postgres security patches pending (both confirmed by advisors today). ~15 min dashboard work; live product with real customer logins.
3. **Phase 2 lead-gen sprint** — portal sprinted to 85% while lead gen sat at 5%. (a) GBP registration [Sam, starts the postcard clock]; (b) `/lean-manufacturing` + `/schools` landing pages + LocalBusiness schema [dev-buildable now, brand-portable]. This is the pillar that produces quotes.
4. **Admin CRM v2** (`planning/FEATURE-admin-crm.md`): notes on records, pipeline aging indicators, CSV export. Real value but Sam is the only user — diminishing returns vs. #3.
5. **DB housekeeping** — drop `drawer_backup_2026_05_02` + `_archive_customer_2026_07_03` (advisor-flagged, deny-all but dead weight), delete `[TEST]` drawers (admin bulk-delete now exists), move `pg_net` out of public schema.

Deliberately parked: label entry (blocked on tidyCAM tool names), reorders/saved designs, kanban board.

## Waiting on Sam

- SMTP provider signup + DNS records (unblocks notifications)
- Dashboard toggles: leaked-password protection ON, Postgres patch upgrade, confirm open-signups disabled
- GBP registration + postcard verification
- Rebrand decision — September 2026
- Rotate Discord approval webhook (plaintext exposure 2026-06-28); Hermes webhook decision pending

## Cleanup log (this run)

- None removed — active burst; `FEATURE-admin-crm.md` retained (v2 items open). Advisor SECURITY DEFINER warnings reviewed: expected pattern (RPC-only API), no action.
