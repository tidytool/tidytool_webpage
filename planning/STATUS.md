# TidyTool Status — 2026-07-09

_Written by the PM agent. Playbook: `planning/pm-agent.md`. Overwritten each run — history in git._

## Project version snapshot

- Phase 0 — Stop the bleeding: ✅ 100%
- Phase 1 — Credibility core: ✅ 100% (named Waddoups testimonial + Bridgerland case study are LIVE — owner "fill placeholders" item closed)
- Phase 2 — Local visibility: **~60% — CORRECTION.** Prior reports said "landing pages + schema unbuilt"; in fact `docs/lean-manufacturing.html`, `docs/technical-schools.html`, LocalBusiness JSON-LD, sitemap, and local-intent titles have been live in main since 2026-06-12 (verified this run: linked in nav, in sitemap, schema in `index.html`). The remaining gap is entirely Sam-side: GBP registration + postcard verification.
- Phase 3 — Depth/inbound: 0% (gated on rebrand decision, Sept 2026)
- Phase 4 — Customer portal: ~90% — portal + admin CRM + notifications live. Open: T3.7 est-delivery, T4 timeline, tidyCAM security gate, label entry (blocked on tidyCAM)

## Shipped since last check (2026-07-07)

- Nothing new — quiet two days (only the last PM commit). This run's value is the Phase 2 correction above and cleanup.

## Next steps by impending ROI

1. **tidyCAM pre-launch security gate** (`planning/TIDYCAM-launch-coordination.md`) — unchanged #1. (a) Rotate DB password (~10 min, Sam — credential shipped in mobile builds until 2026-07-05); (b) approval-gate RLS before TestFlight invites (~0.5 day, needs Sam's high-risk review); (c) storage tightening (branch-test first). Why now: launch blocker + live credential exposure.
2. **GBP registration** [Sam, ~1 hr] — with the Phase 2 dev assets confirmed shipped, this is the single remaining lever on the lead-gen pillar and it starts an 8-week postcard clock. Checklist ready: `planning/gbp-setup-checklist.md`. Highest value-per-hour on the board.
3. **Auth hygiene toggles** [Sam, ~15 min dashboard] — leaked-password protection ON + Postgres security patch. Live product, real logins, advisor-flagged for weeks.
4. **T3.7 — Estimated delivery date** (~0.5 day + migration review) — data model already decided (nullable `order.estimated_delivery`); admin edit/create + portal display. Small, customer-visible, and feeds T4.
5. **T4 — lifecycle timeline** (~1 day) — `drawer_event` RLS, status-trigger → events, portal "pizza tracker". Natural follow-on once T3.7 lands.

Also queued: DB housekeeping (drop `drawer_backup_2026_05_02` + `_archive_customer_2026_07_03`, delete `[TEST]` drawers, move `pg_net` out of public). Deliberately parked: label entry (blocked on tidyCAM), CRM v2, reorders/saved designs.

## Waiting on Sam

- **Rotate the Supabase database password** (urgent — exposed in past mobile builds)
- Review/approve tidyCAM approval-gate + storage-tightening migrations (auth/RLS — high-risk gate)
- Dashboard toggles: leaked-password protection ON, Postgres patch upgrade
- **GBP registration + postcard verification** — now the only thing holding Phase 2 back
- Rebrand decision — September 2026
- Rotate Discord approval webhook (plaintext exposure 2026-06-28)
- Owner-side conversion items: Tally "How did you hear about us?" → optional; 1–2 additional testimonials; higher-res install photos
- Disposition of `planning/FEATURE-approval-changelog.md` (flagged 2026-07-07, still unanswered): `drawer_event` + `log_design_revision` shipped since the spec — confirm superseded so it can be pruned
- Disposition of `planning/customer-interview-form.pdf` — kept as a possibly-reusable template after the BTech interview guide was pruned; confirm keep/delete

## Cleanup log (this run)

- Deleted `prompts/phase-2-prompt.md` — all 5 tasks verified executed in main (LocalBusiness JSON-LD in `index.html`; both landing pages live, in nav + sitemap; local-intent titles/meta; GBP checklist delivered as `planning/gbp-setup-checklist.md`)
- Deleted `planning/btech-interview-guide.md` — interview (2026-06-25) completed; its outputs (named testimonial + case study) are live on the site
- `ROADMAP.md`: Phase 2 dev-side items marked ✅ shipped; owner testimonial action item checked off (quote + case study live)
- `memory/project-overview.md`: removed stale "stat strip" theme note (stat strip was cut in the conversion redesign)
- Kept: `planning/FEATURE-approval-changelog.md` (still ambiguous — flagged above), `customer-interview-form.pdf` (flagged above), `smtp-notifications-runbook.md` (reference), `BACKEND-analysis.md` (§4.5/§4.6/§4.7/§3d still open), phase-3 + phase-4 prompts (phases open). Auto-memory unchanged (durable facts only).
