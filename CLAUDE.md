# CLAUDE.md — working agreement for the AI dev workflow

This file aligns any AI coding agent (Claude Code, Cowork, etc.) with the target for this repo.
Read it before making changes.

## What this project is

TidyTool's web presence has **two jobs**, served by two surfaces in one repo:

1. **Lead generation** — the public marketing site (`docs/`) for custom, AI-designed,
   CNC-cut XLPE foam tool organizers. Its job is to convert visitors into quote requests
   and notify Sam. It is **not** an e-commerce store and should stay simple and fast.
2. **Customer portal** — the authenticated account hub (`portal/`) where existing customers
   sign in, see their drawers/orders, and approve foam designs before we cut. This is where
   the relationship continues after the sale: design sign-off, order tracking, and (later)
   reorders and saved designs.

The two share a brand and a Supabase backend but are deployed and built separately (see
"Repo layout"). Conversion still comes first: a new visitor's path to a quote must never be
slowed down by portal features.

## Repo layout — what gets published

There are now **two deployables** with two different rules. Do not mix them.

- `docs/` — the **static marketing site** + public, link-based pages. Served by GitHub Pages
  (only this folder). Plain HTML/CSS/JS, no build step. Public.
- `portal/` — the **authenticated customer account hub** (Next.js + Supabase). Has a build
  step; deployed separately (Cloudflare Pages / Vercel), **not** served by GitHub Pages.
- `planning/` — feature specs and internal notes. Not served.
- `prompts/` — phase implementation prompts. Not served.

Everything except `docs/` and `portal/` (CLAUDE.md, ROADMAP.md, `planning/`, `prompts/`,
README) is internal and must never be moved into `docs/`.

Note: the repo itself is public on GitHub, so internal files are still visible there until
the repo goes private (planned alongside the Cloudflare Pages migration). Never commit
`portal/.env*` — secrets stay out of the repo.

## Prime directives

1. **Right tool per surface — simplicity still wins.**
   - **`docs/` (marketing + public link pages): stays plain HTML/CSS/JS, no build step, no
     framework.** This is a brochure that must load instantly and convert; it has no reason
     to carry a framework. Don't add one here.
   - **`portal/` (the customer account hub) uses Next.js (React) + Supabase.** Logins,
     dashboards, reorders and saved designs are real application state, and hand-rolling that
     in vanilla JS costs more than it saves. We optimize for shipping customer value and for
     hireability (React + Supabase is the highest-supply stack). A build step is acceptable
     **here only**.
   - Simplicity is still the bar inside the portal: prefer server components, the official
     `@supabase/ssr` helpers, and as few dependencies as the job needs. Reach for one
     well-justified library, not a pile. Anything heavier than the chosen stack (state
     libraries, UI kits, ORMs) needs sign-off.
2. **Protect conversion.** The "Get a Free Quote" path is the product. Don't bury the CTA,
   don't add friction, don't break the form.
3. **Stay within budget.** Work in small, ticketed tasks. Don't spin up long multi-agent
   loops; don't re-architect a static site. Prefer the cheapest change that meets the goal.
4. **Human approval scales with risk.** Most changes don't need a gate — copy, styling,
   content, docs, and additive/non-destructive code can ship without waiting for sign-off.
   Require explicit review from **Sam or Shem** (equal say, either suffices — agreed
   2026-08-15) **only for high-risk changes**: anything touching the quote
   form or conversion path, production database migrations (schema changes, RLS, destructive
   SQL), auth, secrets/`.env`, DNS/the live domain, or deleting data. When the blast radius is
   unclear, treat it as high-risk and ask. Never auto-deploy to the live domain or run
   destructive production SQL unattended. (Disposable Supabase **branches** are low-risk —
   experiment freely, just delete them when done so they stop billing.)

## House style

- Brand colors and type are CSS variables in `:root` (`docs/assets/css/styles.css`). Re-theme there,
  not with scattered inline overrides. The portal should reuse the same brand tokens so the two
  surfaces feel like one product.
- Semantic HTML, accessible (alt text, focus states, labelled controls), mobile-first responsive.
- In `docs/`, keep `main.js` tiny and vanilla; no new libraries without sign-off. In `portal/`,
  stay close to the framework defaults and keep dependencies minimal (see Prime Directive 1).
- Match the existing voice: confident, rugged, professional. Short punchy headlines.

## How to propose work (lightweight "agent roles," one human in the loop)

Rather than six always-on agents, fold the roles into one ticket-driven flow:

- **Brief (Visionary/Designer thinking):** state the goal, who it's for, and the look/feel.
- **Propose (Junior Dev):** make the change on a branch; summarize what and why.
- **Review (Senior Dev/Tester):** self-critique — check links, mobile layout, the form path,
  performance, accessibility. List anything risky.
- **Approve (Sam or Shem):** either signs off on the preview before it goes live.

## Definition of done for any change

- [ ] Renders correctly on desktop and mobile widths
- [ ] All nav links / anchors resolve; the quote form is reachable and submits
- [ ] No console errors; no hotlinked third-party images
- [ ] Brand tokens used (no hard-coded one-off colors)
- [ ] Change described in the commit message; `ROADMAP.md` updated if it advances a phase

## Current priorities

See `ROADMAP.md`. Phases 0–1 (credibility core) are complete. Active track is **Phase 4 —
the customer portal**: the public, link-based design-approval page already ships from
`docs/approve/` (vanilla, token = drawer id). The next step is the authenticated account hub
in `portal/` (Next.js + Supabase): customer login, a dashboard of their orders/drawers, and
the approval screen inside that logged-in context.

Backend note: there is not yet a clean link between `auth.users` and a customer's orders
(`drawer.created_by` is the tidyCAM operator, and the `customer` table is unused). The portal
scopes a logged-in customer to their data by matching `order.customer_email` to the auth email
via a `SECURITY DEFINER` RPC. That migration is staged in `portal/supabase/migrations/` and
must be reviewed/applied before the dashboard returns real data.
