# TidyTool — Website + Customer Portal

TidyTool's web presence does **two jobs** from one repo:

1. **Lead generation** — a simple, fast, dependency-free static marketing site
   (`docs/`) for [thetidytool.com](https://thetidytool.com). Its job: **turn visitors into
   qualified leads** via a "Get a Free Quote" form, and ping you on every submission.
2. **Customer portal** — an authenticated account hub (`portal/`, Next.js + Supabase) where
   existing customers sign in, see their drawers/orders, and **approve foam designs** before
   we cut.

The two share a brand and a Supabase backend but build and deploy separately. See `CLAUDE.md`
for the working agreement and `portal/README.md` for portal setup.

---

## Tech stack

**Marketing site (`docs/`) — deliberately boring:**

- Plain **HTML + CSS + vanilla JS**. No framework, no build step.
- Pages like `index.html`; styles in `assets/css/styles.css`, JS in `assets/js/main.js`.
- Lead capture via an embedded **Tally** form (free tier: unlimited submissions + email notifications).
- A public, link-based design-approval page (`docs/approve/`) reads Supabase directly via
  `fetch` + the anon key — still no framework, no build step.

Why no build step here? It hosts anywhere with zero config, GitHub/Cloudflare Pages deploy it
as-is on every push, and an AI agent can edit it without a toolchain to break.

**Customer portal (`portal/`):**

- **Next.js 15** (App Router, React, TypeScript) + **Supabase** auth via `@supabase/ssr`.
- A build step lives **here only** — this is real application state (logins, dashboards,
  approvals), so a framework earns its keep. See `portal/README.md`.

---

## Run it locally

**Marketing site** — just a static file server over `docs/`:

```bash
cd docs
python3 -m http.server 8080   # or: npx serve .
```

Then open <http://localhost:8080>. To share on your LAN, others can hit
`http://<your-computer-ip>:8080` while the server runs.

**Customer portal** — a Next.js app with its own setup:

```bash
cd portal
cp .env.example .env.local    # add the Supabase anon key
npm install && npm run dev     # http://localhost:3000
```

Full portal instructions live in `portal/README.md`.

---

## Wiring up the Tally form (the lead engine)

The quote section in `index.html` has a clearly marked placeholder. Three steps to go live:

1. **Create the form** at [tally.so](https://tally.so) — fields like name, email, company,
   toolbox type, and "describe/upload your tools" (Tally supports file uploads up to 10MB free).
2. **Turn on notifications:** Tally → form → *Integrations / Notifications* → enable
   **self email notifications** so a new submission emails you. (Optional later: route to
   Slack or a webhook — that's a Pro feature at ~$29/mo.)
3. **Embed it:** Tally → *Share → Embed → Inline*, copy the snippet, and replace the
   `<div class="form-card">…placeholder…</div>` block in `index.html` with it. The HTML
   already contains a commented example showing exactly where it goes.

Until then the placeholder renders so the layout is complete.

---

## Deploy to Cloudflare Pages (Phase 1)

1. Push this repo to GitHub.
2. Cloudflare dashboard → **Workers & Pages → Create → Pages → Connect to Git**.
3. Build settings: **framework preset = None**, **build command = (blank)**,
   **output directory = `/`** (the site is already static).
4. Every push to `main` auto-deploys; each branch gets its own preview URL.
5. Once you're happy, add `thetidytool.com` as a custom domain and update DNS,
   then cancel Shopify.

---

## Repository layout

```
tidytool_webpage/
├── docs/                   # PUBLIC marketing site (GitHub Pages serves this folder)
│   ├── index.html          # homepage
│   ├── approve/            # public, link-based design-approval page (vanilla)
│   ├── q/ + drawer.html    # QR drawer pages
│   └── assets/             # css (brand tokens in :root) + vanilla js
├── portal/                 # CUSTOMER PORTAL (Next.js + Supabase; built/deployed separately)
│   ├── src/                # app routes, components, supabase helpers
│   └── supabase/migrations # staged SQL (e.g. get_my_drawers)
├── planning/               # feature specs & internal notes (not served)
├── prompts/                # phase implementation prompts (not served)
├── README.md               # this file
├── ROADMAP.md              # phased plan + progress checklist
├── CLAUDE.md               # guardrails & briefs for the AI dev workflow
└── .gitignore
```

## Content source

Copy and structure are adapted from the current Shopify site's Products page
(value props, the "real cost of disorganization" stats, the 4-step process,
XLPE materials detail, and audience segments). See `ROADMAP.md` for what's next.
