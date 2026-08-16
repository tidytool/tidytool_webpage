# WEBSITE-SAFETY.md — abuse resistance: rate limits, bots, and spam

Best practices for keeping the public surfaces safe from abuse, tailored to
this stack (static docs/ + Tally + Supabase + Next.js portal). Companion to
`planning/SUPABASE.md` (environments/migrations) — this file is about hostile
traffic. Last audited 2026-08-15 against prod's live Auth config.

## Threat model — what abuse looks like here

The site takes money nowhere and holds no card data, so the realistic threats
are: **junk/bot portal accounts**, **spam through the anon-callable RPCs**
(approval submissions land in the DB, Discord, and customer email), **quote-form
spam** (wastes Sam's follow-up time), and **email-sending abuse** (auth emails
sent from our domain hurt deliverability). Capability links (unguessable drawer
UUIDs) are the auth model for public pages — their secrecy matters.

## Already in place (don't regress these)

- **Anon reads are RPC-only and filtered** — no blanket `SELECT` grants on
  tables (`20260703160834_harden_anon_reads`); the public changelog RPC returns
  only the four customer-facing event types.
- **Anon writes are bounded** — `submit_drawer_approval` caps name (120) and
  note (2,000 chars) after trim (`20260814214000`), and double-approval is
  rejected.
- **Leaked-password protection is ON** (HIBP check) for portal accounts.
- **Auth email rate limits at Supabase defaults** — 30/hr each for emails, OTP,
  and verifications; 150/hr token refresh.
- **Dev is fenced** — `?env=dev` needs a per-browser `localStorage.tt_dev`
  opt-in, and dev has no `pg_net` so it can never email customers.
- **Secrets hygiene** — publishable keys only in page source; secret keys never
  committed (see SUPABASE.md).

## Gaps found in the 2026-08-15 audit — recommended, needs Sam's sign-off

Auth settings are high-risk changes per CLAUDE.md, so these are recommendations,
not applied. In priority order:

1. **Close open signup.** Prod currently has `disable_signup: false` **and**
   `mailer_autoconfirm: true` — anyone can create a confirmed portal account
   instantly, no email verification, no CAPTCHA. Bot accounts see no customer
   data (dashboard scoping is by matching `order.customer_email`), but junk
   accounts pollute `auth.users`, and signup emails burn our sending
   reputation. The portal is invite-driven today, so the cheap fix is
   **turn `disable_signup` on** (invites still work). If self-serve signup is
   ever wanted instead: require email confirmation (`mailer_autoconfirm: false`)
   **and** enable CAPTCHA.
2. **Enable CAPTCHA on auth endpoints** (`security_captcha_enabled`) —
   Supabase supports Cloudflare Turnstile (preferred — free, invisible) or
   hCaptcha. One dashboard toggle + a small portal login-form change
   (`@marsidev/react-turnstile` or plain widget). Do this at the latest when
   signup opens; it also protects password reset and magic-link endpoints from
   email-bombing a victim's inbox.
3. **Raise password minimum from 6 to 12** — current floor is weaker than the
   HIBP check deserves. No effect on existing passwords until changed.
4. **Rate-limit the anon write RPC at the DB level.** Auth endpoints have
   Supabase's limiter, but `/rest/v1/rpc/submit_drawer_approval` has none — a
   scripted loop with a leaked drawer link could append `drawer_event` rows and
   ping Discord until manually stopped. Cheapest robust fix, no new infra: a
   check inside the RPC —
   `if (count of drawer_event rows for this drawer in the last hour) >= 10 then
   raise 'Too many submissions — please try again later.'`
   Per-drawer, so one abused link can't be stopped by IP-hopping and can't
   affect other customers. Same pattern for any future anon-callable write.

## Standing practices for new work

**Any new anon-callable RPC** must ship with all four of:
1. capability-token gating (unguessable id as the argument — never enumerable),
2. output filtering (return columns/rows a customer may see, nothing more),
3. input caps on every text argument (22001 + friendly message, per
   `20260814214000`), and
4. a write-rate cap if it writes (see gap 4).
Never re-grant broad table access to `anon` to "fix" a page — add a narrow RPC.

**Quote form (Tally):** enable Tally's built-in CAPTCHA on the form if spam
submissions appear — it's a form setting, zero code here. Keep the `mailto:`
fallback links (added 2026-08-14) — the address is already public on the site,
so scraper exposure is unchanged.

**Capability links:** treat drawer/approve URLs like passwords — never put them
in sitemaps, analytics events, public repos, or screenshots in marketing
material. They already don't appear in `sitemap.xml`; keep it that way.

**Don't add friction to conversion.** Prime directive 2 still wins: no CAPTCHA,
login, or challenge on the marketing pages or in front of the quote form's
first paint. Abuse controls belong on *write* endpoints and *auth* endpoints,
not on reading the brochure.

## When the site moves to Cloudflare (planned)

GitHub Pages can't set custom headers or do edge filtering. The planned
Cloudflare Pages migration unlocks, in order of value:
- **Bot Fight Mode / WAF managed rules** — free tier, one toggle, filters
  known-bad crawlers before they hit the site.
- **Edge rate-limiting rules** on `thetidytool.com` paths.
- **Security headers** (CSP, `X-Frame-Options`, referrer policy) — today only
  achievable via meta tags. Note this covers the *site* only; the browser talks
  to `*.supabase.co` directly, so Supabase endpoints are **not** behind
  Cloudflare — DB-level limits (above) remain the real control there.

## Monitoring — knowing when it's happening

- Discord approval notifications double as an anomaly signal: a burst of
  notifications for one drawer = someone is hammering the RPC (gap 4 caps the
  damage at the DB).
- Cheap periodic check (fits the existing tooling):
  `select count(*) from drawer_event where created_at > now() - interval '1 day'`
  and the same for `auth.users` — a spike in either is the earliest bot signal.
- Supabase dashboard → Auth → Users, sorted by created-at, shows junk signups
  at a glance while signup remains open.
