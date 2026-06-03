# TidyTool Website — Roadmap

**Goal:** a simple lead-generation site that excites new leads and pings Sam the moment a
quote form is filled out. Cheap to run, easy for an AI dev workflow to maintain.

**Definition of done (the whole project):** visitor lands → understands the value → submits
the quote form → Sam gets a notification → site stays up and bug-free with light, scheduled
monitoring.

Legend: `[ ]` todo · `[~]` in progress · `[x]` done

---

## Phase 0 — Local build & iteration (we are here)

> Host on Sam's local network, iterate until ready to go public.

- [x] Extract & curate content from the current Shopify site
- [x] Scaffold static repo (HTML/CSS/JS, no build step)
- [x] Build single-page lead-gen site with all core sections
- [x] Add Tally form placeholder + embed instructions
- [ ] `git init` and first commit *(run locally — see note below)*
- [ ] Serve locally and review on desktop + phone
- [ ] Sam's first round of feedback → iterate on copy, layout, colors
- [ ] Replace Tally placeholder with the real embed + test a submission end-to-end
- [ ] Swap in real product photography (current site uses CDN images we shouldn't hotlink)

## Phase 1 — Go live on Cloudflare Pages

- [ ] Push repo to GitHub
- [ ] Connect repo to Cloudflare Pages (preset: None, output: `/`)
- [ ] Verify the preview deploy looks identical to local
- [ ] Add `thetidytool.com` custom domain + update DNS
- [ ] Confirm email/MX records are unaffected by the DNS change
- [ ] Cancel Shopify subscription ← biggest recurring-cost win

## Phase 2 — Harden the lead engine

- [ ] Confirm Tally email notifications arrive reliably
- [ ] Pipe submissions to a Google Sheet (free Tally integration) so leads are owned/backed up
- [ ] Add basic privacy policy + contact email in the footer
- [ ] Add lightweight analytics (e.g. Cloudflare Web Analytics — free, privacy-friendly)

## Phase 3 — Automated monitoring

- [ ] Scheduled task: daily/weekly uptime + broken-link + form-reachable check
- [ ] Alert Sam only when something is broken (no noise)
- [ ] Optional: weekly digest of new leads + site health

## Phase 4 — Optional polish (one-off sessions, not always-on)

- [ ] Quarterly competitor / market-comp scan (the "Visionary" pass)
- [ ] Branding & color refinement pass (the "Designer" pass)
- [ ] A/B test hero headline + CTA copy for conversion

---

## Known roadblocks / watch-list

- **DNS migration** is the fiddly step — protect MX/email records when repointing the domain.
- **Don't hotlink** the current site's Shopify CDN images; source or shoot our own before launch.
- **Token budget ($100/mo):** keep the AI workflow to bounded, ticketed tasks + scheduled checks.
  Avoid always-on multi-agent review loops — they burn budget fast for little gain on a static site.
- **Never auto-merge to production unattended** — keep a human approval (Sam) on changes; use
  Cloudflare branch previews to review before promoting.

## Note on the first commit

This repo is created but not yet under git. From the project folder, run:

```bash
git init && git add -A && git commit -m "Initial TidyTool lead-gen site"
```
