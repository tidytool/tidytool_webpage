# TidyTool Status — 2026-07-05

_Written by the PM agent (`tidytool-pm`, every 3 days). Playbook: `planning/pm-agent.md`. This file is overwritten each run — history is in git._

## Project version snapshot

- Phase 0 — Stop the bleeding: ✅ 100%
- Phase 1 — Credibility core: ✅ 100% (testimonial/case-study `[TODO]` content still on Sam)
- Phase 2 — Local visibility: ~5% — GBP not started, landing pages not built; 8-week GBP target is ticking
- Phase 3 — Depth/inbound: 0% (gated on rebrand decision, Sept 2026)
- Phase 4 — Customer portal: ~70% — QR page + approval shipped, portal LIVE at app.thetidytool.com, schema baseline (T1) done, T2 identity migration merged; open: prod applies, backfill, lifecycle/notifications, admin view, launch hygiene

## Shipped since last check

- 2026-07-05: T2 durable customer/organization identity migration (0004) merged
- 2026-07-03: T1 schema baseline — 10 prod migrations materialized byte-exact into `portal/supabase/migrations/`
- 2026-07-03: Portal launched (email+password + magic-link setup); nav rename paused, reverted to "Customer Login"
- 2026-07-03: Supabase hardening round 2 applied to prod; security debt closed

## Next steps by impending ROI

1. **Portal launch hygiene** (`planning/portal-launch-runbook.md`) — custom SMTP + token_hash email templates, **disable open signups**, leaked-password protection, delete `[TEST]` drawers. Why now: portal is live and publicly linked; open signups on a live product is the single riskiest open item, and SMTP unblocks the notifications track. Effort ~2–4h. ROI: high value × high urgency ÷ low effort.
2. **Apply staged migrations to prod** — storage-policies baseline (`20260703220000`, branch-tested) and T2 identity 0004. Why now: everything downstream (backfill, lifecycle, `drawer_event` timeline, admin view) is blocked behind these; both awaiting Sam's review per CLAUDE.md. Effort ~1h review + apply.
3. **GBP setup** (Sam, `planning/gbp-setup-checklist.md`) — free, brand-portable, compounds monthly; roadmap targets verified-and-live within 8 weeks of Phase 2 start. The longest-lead lead-gen item — start the postcard clock.
4. **Testimonial + case-study `[TODO]`s** (Sam) — the only gap left in Pillar 1's proof section; low effort, direct conversion impact.
5. **T2 backfill + customer lifecycle** — next dev step in `planning/ARCHITECTURE.md` sequence once #2 lands.

## Waiting on Sam

- Prod apply: storage-policies baseline + T2 migration 0004 (high-risk gate per CLAUDE.md)
- Dashboard toggles: leaked-password protection, disable open signups; Postgres patch upgrade
- GBP registration + postcard verification; testimonial permissions/content
- Rebrand decision — deadline September 2026
- Consider rotating the Discord approval webhook (URL was pasted in plaintext chat 2026-06-28)

## Cleanup log (this run)

- Deleted `prompts/phase-0-prompt.md`, `prompts/phase-1-prompt.md` — phases complete and integrated
- Collapsed the completed Supabase-hardening owner item in `ROADMAP.md` to a one-line ✅ summary
- `memory/MEMORY.md`: removed dead link to nonexistent `feedback-code-style.md`
- Auto-memory: rewrote `supabase-security-debt` (closed; kept remaining items + EXECUTE gotcha), `supabase-schema-unmanaged` (now migration-managed; kept durable gotchas), `tidytool-approval-feature` (shipped; kept design facts + follow-ups); updated index; added `tidytool-pm-agent`
