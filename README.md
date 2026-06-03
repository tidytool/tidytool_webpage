# TidyTool — Lead-Gen Website

A simple, fast, dependency-free static site for [thetidytool.com](https://thetidytool.com).
Its one job: **turn visitors into qualified leads** via a "Get a Free Quote" form, and
ping you whenever someone fills it out.

Built to be hosted locally during iteration, then deployed to **Cloudflare Pages** (Phase 1).

---

## Tech stack (deliberately boring)

- Plain **HTML + CSS + vanilla JS**. No framework, no build step.
- One page: `index.html`. All styles in `assets/css/styles.css`, all JS in `assets/js/main.js`.
- Lead capture via an embedded **Tally** form (free tier handles unlimited submissions + email notifications).

Why no build step? It hosts anywhere with zero config, Cloudflare Pages deploys it as-is on
every `git push`, and the code-gen agent can edit it without a toolchain to break.

---

## Run it locally

You only need a static file server. Pick one:

```bash
# Python (preinstalled on macOS)
python3 -m http.server 8080

# or Node, if you prefer
npx serve .
```

Then open <http://localhost:8080>. To share on your local network, others can hit
`http://<your-computer-ip>:8080` while the server runs.

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
├── index.html              # the entire site
├── assets/
│   ├── css/styles.css      # all styling; brand tokens live in :root
│   └── js/main.js          # nav, smooth scroll, scroll-reveal
├── README.md               # this file
├── ROADMAP.md              # phased plan + progress checklist
├── CLAUDE.md               # guardrails & briefs for the AI dev workflow
└── .gitignore
```

## Content source

Copy and structure are adapted from the current Shopify site's Products page
(value props, the "real cost of disorganization" stats, the 4-step process,
XLPE materials detail, and audience segments). See `ROADMAP.md` for what's next.
