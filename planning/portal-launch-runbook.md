# Portal launch runbook — Vercel + Supabase auth config

Goal: take `portal/` from "builds on Vercel" to live at `app.thetidytool.com` with
invite-only customer login. Est. 1–2 hours of dashboard work. Items marked **[Sam]**
need dashboard/DNS access; nothing here changes code.

## 1. Vercel project **[Sam]**

- Project → Settings → General: **Root Directory = `portal`**, Framework Preset = Next.js
  (already set per the rebuild commit — verify).
- Settings → Environment Variables — **Production and Preview point at different
  databases** (decision 2026-08-13, see `planning/SUPABASE.md`): Production = the
  live DB; every Preview (any non-main branch) = the persistent dev branch, so no
  preview build can ever touch prod data.
  - **Production scope:**
    - `NEXT_PUBLIC_SUPABASE_URL` = `https://tkrrvpoupekrjqditupi.supabase.co`
    - `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` = prod `sb_publishable_...` key
      (Supabase → Settings → API Keys). Preferred over the legacy anon JWT.
    - `NEXT_PUBLIC_SITE_URL` = `https://app.thetidytool.com`
    - `SUPABASE_SECRET_KEY` = prod `sb_secret_...` key
  - **Preview scope:**
    - `NEXT_PUBLIC_SUPABASE_URL` = `https://gfkrebuioszsxanjdnsx.supabase.co`
    - `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` =
      `sb_publishable_mNYeuBuPF6KMI6Z1JTgw3g_BXtugiya` (dev; public by design)
    - `NEXT_PUBLIC_SITE_URL` = leave **unset** — the code falls back to the
      per-deploy `VERCEL_URL`, so invite links land on the preview itself.
    - `SUPABASE_SECRET_KEY` = dev branch `sb_secret_...` key (Supabase →
      branch "dev" → Settings → API Keys)
  - Dev-branch auth redirect allowlist is already configured (2026-08-13):
    localhost + the Vercel preview wildcards.
  - **[Sam] PENDING (2026-08-13):** the Preview-scope values above are not yet
    set — until they are, previews still point at prod. Setting them is the
    only step left to turn on the dev environment.
  - **Policy:** dev (previews + the dev DB) is for **employees only** — never
    hand a preview URL or dev login to a customer. Customers only ever see
    `app.thetidytool.com`.

## Commercial-launch checklist (before the first paying customer)

- **Upgrade Vercel to Pro.** The free Hobby plan is licensed for personal,
  non-commercial use; a commercial customer portal needs Pro (~$20/mo). The
  empty "Manifest Systems" team on Shem's Vercel account is a natural home if
  we also want to move off a personal account then (project transfer keeps
  domains/deploys); until that day, keep that team empty so it never bills.
- Marketing site: the planned Cloudflare Pages migration (README) also settles
  GitHub Pages' non-commercial-hosting clause for `docs/`.
- Deploy `main` and confirm the build passes and `/login` renders.

## 2. Domain **[Sam]**

- Vercel → Project → Settings → Domains → add `app.thetidytool.com`.
- At the DNS host for `thetidytool.com`: add `CNAME app → cname.vercel-dns.com`
  (Vercel shows the exact record). Wait for the cert to issue.
- Domain rule from the roadmap: everything stays on `thetidytool.com` through any
  rebrand, so `app.` is safe to engrave/print.

## 3. Supabase Auth URL configuration **[Sam]**

Authentication → URL Configuration:

- **Site URL:** `https://app.thetidytool.com` (no wildcards allowed here).
- **Redirect URLs** (wildcards use `**`, a single `*` won't cross `/`):
  - `https://app.thetidytool.com/**`
  - `http://localhost:3000/**` (keep for dev)
  - `https://tidytool-webpage-portal-*-samochristensens-projects.vercel.app/**` (previews, optional)

Login breaks silently (links rejected) if the `/auth/confirm` destination isn't
covered by this list.

## 4. Email: custom SMTP + templates **[Sam]**

- **Custom SMTP** (Authentication → Emails → SMTP Settings): Supabase's built-in
  sender is capped (~2 emails/hour) and lands in spam — not launchable. Use e.g.
  Resend/Postmark with a `thetidytool.com` sender (`portal@` or `no-reply@`),
  which needs their DNS records (SPF/DKIM) added too.
- **Templates** (Authentication → Emails): point links at the server-side confirm
  route. For **Magic Link**, **Invite user**, and **Reset password**:

  ```html
  <a href="{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=email">Sign in</a>
  ```

  (use `&type=invite` for the invite template and `&type=recovery` for reset —
  `/auth/confirm` routes recovery/invite to `/set-password`). This is the canonical
  token_hash flow; the route also tolerates the default PKCE `?code=` links.

## 5. Auth policy settings **[Sam]**

Authentication → Sign In / Up (naming varies slightly):

- **Disable open signups** ("Allow new users to sign up" → off). The portal is
  invite/claim-only; the login page already passes `shouldCreateUser: false`, this
  closes the API-level path too.
- **Enable leaked-password protection** (Authentication → Passwords) — HaveIBeenPwned
  check; matters now that password login shipped. Set minimum length ≥ 10 while there.

## 6. Data prep (before inviting real customers)

- Delete the 4 `[TEST]` drawer rows (`nickname ilike '%[TEST]%'`) — dev seeds.
- Invite flow per customer: Authentication → Users → **Invite user** with the same
  email that's on their `order.customer_email` (matching is case-insensitive). They
  click the invite → `/set-password` → land on their dashboard.

## 7. Wire the marketing site

- `docs/customer-login.html` currently says "coming soon" — replace the hero copy
  with a **Sign in** button linking `https://app.thetidytool.com/login` (keep the
  quote CTA for non-customers). Low-risk `docs/` change, can ship any time after
  the domain is live.

## 8. Launch smoke test

1. Invite a test address you control → email arrives from `thetidytool.com` sender.
2. Invite link → `/set-password` → set password → dashboard loads with that
   customer's drawers (or the empty state).
3. Sign out → sign in with email+password.
4. "Forgot password" → recovery email → `/set-password` works.
5. An un-invited email cannot sign up or sign in.
6. Open a drawer → approval page loads, changelog renders; submit a test
   "changes requested" and confirm the Discord notify fires.
7. Mobile width pass on `/login` and dashboard.

## Done when

Customer can go QR/site → login → dashboard → approve, entirely on
`thetidytool.com` domains, with invite-only auth and hardened RLS (0002 applied
to prod 2026-07-03).
