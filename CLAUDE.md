# CLAUDE.md — working agreement for the AI dev workflow

This file aligns any AI coding agent (Claude Code, Cowork, etc.) with the target for this repo.
Read it before making changes.

## What this project is

A **lead-generation website** for TidyTool — custom, AI-designed, CNC-cut XLPE foam tool
organizers. The site exists to convert visitors into quote requests and notify Sam. It is
**not** an e-commerce store and should stay simple.

## Repo layout — what gets published

GitHub Pages serves **only the `docs/` folder**. Everything else (CLAUDE.md, ROADMAP.md,
`planning/`, `prompts/`, README) is internal and must never be moved into `docs/`.

- `docs/` — the live website (index.html, assets/, CNAME). Public.
- `planning/` — feature specs and internal notes. Not served.
- `prompts/` — phase implementation prompts. Not served.

Note: the repo itself is public on GitHub, so internal files are still visible there until
the repo goes private (planned alongside the Cloudflare Pages migration).

## Prime directives

1. **Keep it simple and dependency-free.** Plain HTML/CSS/JS, no build step, no framework,
   no npm runtime deps. If a change seems to need a framework, stop and ask first.
2. **Protect conversion.** The "Get a Free Quote" path is the product. Don't bury the CTA,
   don't add friction, don't break the form.
3. **Stay within budget.** Work in small, ticketed tasks. Don't spin up long multi-agent
   loops; don't re-architect a static site. Prefer the cheapest change that meets the goal.
4. **Human approval before production.** Propose changes, let Sam review (ideally via a
   Cloudflare branch preview). Never auto-deploy to the live domain unattended.

## House style

- Brand colors and type are CSS variables in `:root` (`docs/assets/css/styles.css`). Re-theme there,
  not with scattered inline overrides.
- Semantic HTML, accessible (alt text, focus states, labelled controls), mobile-first responsive.
- Keep `main.js` tiny and vanilla. No new libraries without sign-off.
- Match the existing voice: confident, rugged, professional. Short punchy headlines.

## How to propose work (lightweight "agent roles," one human in the loop)

Rather than six always-on agents, fold the roles into one ticket-driven flow:

- **Brief (Visionary/Designer thinking):** state the goal, who it's for, and the look/feel.
- **Propose (Junior Dev):** make the change on a branch; summarize what and why.
- **Review (Senior Dev/Tester):** self-critique — check links, mobile layout, the form path,
  performance, accessibility. List anything risky.
- **Approve (Sam):** Sam signs off on the preview before it goes live.

## Definition of done for any change

- [ ] Renders correctly on desktop and mobile widths
- [ ] All nav links / anchors resolve; the quote form is reachable and submits
- [ ] No console errors; no hotlinked third-party images
- [ ] Brand tokens used (no hard-coded one-off colors)
- [ ] Change described in the commit message; `ROADMAP.md` updated if it advances a phase

## Current priorities

See `ROADMAP.md`. Right now: finish Phase 0 (local iteration, wire the real Tally form,
replace placeholder images), then Phase 1 (Cloudflare Pages + DNS + cancel Shopify).
