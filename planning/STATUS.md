# TidyTool Status — 2026-07-07

_Written by the PM agent. Playbook: `planning/pm-agent.md`. Overwritten each run — history in git._

## Project version snapshot

- Phase 0 — Stop the bleeding: ✅ 100%
- Phase 1 — Credibility core: ✅ 100%
- Phase 2 — Local visibility: ~5% — **still the biggest gap.** GBP not started, landing pages + LocalBusiness schema unbuilt
- Phase 3 — Depth/inbound: 0% (gated on rebrand decision, Sept 2026)
- Phase 4 — Customer portal: ~90% — portal live, admin CRM v1, **notifications + custom SMTP now LIVE**. Open: T4 timeline, CRM v2, tidyCAM security gate, label entry (blocked on tidyCAM)

## Shipped since last check (2026-07-05 evening)

- Notifications LIVE: `notify` edge function (Resend) + migration `20260708000000` applied to prod; design-ready + approved emails smoke-tested end-to-end
- Custom SMTP live (Resend, sender `mail.thetidytool.com`); runbook `planning/smtp-notifications-runbook.md` kept as reference — last run's #1 ROI item is DONE
- Portal build fix: exclude `supabase/` Deno functions from Next.js typecheck
- Hero sample photo removed from hero, kept in proof gallery (PRs #11/#12)
- `planning/TIDYCAM-launch-coordination.md` drafted (mobile pre-launch review; committed this run)

## Next steps by impending ROI

1. **tidyCAM pre-launch security gate** (`planning/TIDYCAM-launch-coordination.md`). (a) Rotate the DB password — the Postgres connection string shipped inside every mobile build until 2026-07-05 (~10 min, Sam). (b) Server-side approval-gate RLS — signups stay ENABLED by decision, so this is the only wall before TestFlight invites (~0.5 day + branch test, needs Sam's review: auth/RLS = high-risk). (c) Storage policy tightening (verified safe for tidyCAM paths; test on branch). Why now: launch-blocker + live credential exposure. PM audit note: all 29 `admin_*`/`get_admin_*` RPCs across migrations DO internally check `is_admin()` (grep-verified), so lint-0029 is defense-in-depth (revoke EXECUTE from `authenticated`), not an open hole.
2. **Phase 2 lead-gen sprint** — portal is at ~90% while the pillar that produces quotes sits at 5%. (a) GBP registration [Sam, starts postcard clock]; (b) `/lean-manufacturing` + `/schools` pages + LocalBusiness schema [dev-buildable now, brand-portable, `prompts/phase-2-prompt.md` ready]. Effort: ~1 day dev + Sam's GBP hour.
3. **Auth hygiene toggles** — leaked-password protection ON + Postgres security patch (~15 min dashboard). Live product, real logins, repeatedly advisor-flagged.
4. **T4 — lifecycle timeline** (migration 0005): `drawer_event` RLS for customers, status-trigger → events, portal "pizza tracker". Notifications going live makes the timeline the natural next customer-facing step. ~1 day.
5. **DB housekeeping** — drop `drawer_backup_2026_05_02` + `_archive_customer_2026_07_03`, delete `[TEST]` drawers (bulk-delete exists), move `pg_net` out of public.

Deliberately parked: label entry (blocked on tidyCAM tool names), CRM v2 (notes/aging/CSV), reorders/saved designs.

## Waiting on Sam

- **Rotate the Supabase database password** (urgent — exposed in past mobile builds; independent of everything else)
- Review/approve tidyCAM approval-gate + storage-tightening migrations (auth/RLS — high-risk gate per CLAUDE.md)
- Dashboard toggles: leaked-password protection ON, Postgres patch upgrade
- GBP registration + postcard verification (8-week clock hasn't started)
- Rebrand decision — September 2026
- Rotate Discord approval webhook (plaintext exposure 2026-06-28)
- Owner-side conversion items: Tally "How did you hear about us?" → optional; 1–2 more testimonials; higher-res install photos
- Disposition of `planning/FEATURE-approval-changelog.md` — the `drawer_event` log + `log_design_revision` shipped since it was proposed; confirm whether the spec is superseded so it can be pruned

## Cleanup log (this run)

- Deleted `planning/DB-baseline-runbook.md` — superseded 2026-07-03; baseline (T1) complete, provenance lives in `portal/supabase/migrations/README.md`
- Deleted `planning/FEATURE-landing-conversion-redesign.md` — shipped/merged (PR #5); remaining owner-side items moved to "Waiting on Sam" above and already in ROADMAP
- ROADMAP.md: portal launch-hygiene line updated (SMTP done; signups stay enabled by 2026-07-05 decision); T5 notifications marked shipped
- Kept `planning/FEATURE-approval-changelog.md` (completion ambiguous — flagged above); kept `smtp-notifications-runbook.md` (self-declared reference w/ durable sender gotcha); repo `memory/` and auto-memory unchanged (durable facts only)
