# WEBSITE-SAFETY.md — abuse resistance: rate limits, bots, and spam

Best practices for keeping the public surfaces safe from abuse, tailored to
this stack (static docs/ + Tally + Supabase + Next.js portal). Companion to
`planning/SUPABASE.md` (environments/migrations) — this file is about hostile
traffic. Last audited 2026-08-15 against prod's live Auth config; audit
findings implemented same day (see status below).

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

## Gaps found in the 2026-08-15 audit — status

Found in the 2026-08-15 read-only audit of prod's Auth config; implemented
2026-08-15 with Shem's sign-off (equal say per CLAUDE.md, agreed 2026-08-15).

1. **Close open signup — ✅ DONE** (prod + dev): `disable_signup: true`.
   Previously anyone could create a confirmed portal account instantly
   (`mailer_autoconfirm: true`, no CAPTCHA). Verified safe first: the portal is
   invite-only in code (`admin.inviteUserByEmail` in
   `portal/src/app/admin/actions.ts`; the login page "never creates a new
   account"), and admin invites bypass the signup endpoint, so nothing breaks.
   If self-serve signup is ever wanted: re-enable **plus** email confirmation
   (`mailer_autoconfirm: false`) **plus** CAPTCHA (item 2) — all three together.
2. **CAPTCHA on auth endpoints — deferred, on purpose.** With signup closed the
   remaining exposure (password-reset / magic-link email-bombing) is bounded by
   Supabase's 30/hr email rate limit. Revisit if signup reopens: Cloudflare
   Turnstile (free) via `security_captcha_enabled` + a small login-form widget.
3. **Password minimum 6 → 12 — ✅ DONE** (prod + dev). Existing passwords are
   unaffected until next change; new invites must meet 12.
4. **Rate-limit the anon write RPC — ✅ DONE**:
   `20260816032818_approval_rate_limit` caps `submit_drawer_approval` at 10
   customer submissions per drawer per rolling hour (errcode 54000, friendly
   message). Per-drawer, so IP-hopping doesn't evade it and one abused link
   can't affect other customers; the count runs under the drawer row lock, so
   concurrent calls can't race past it; staff events never count toward it.
   Tested on dev (cap trips on call 11; drawer state restored — note the 10
   labeled "RateLimit Test" events remain on dev drawer `27885e91…` because
   `drawer_event` is append-only by trigger, which is correct behavior).
   Applied to prod same day, parity OK 49/49. **Reuse this pattern for any
   future anon-callable write.**

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
