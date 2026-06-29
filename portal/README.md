# TidyTool Portal

The authenticated customer account hub: customers sign in, see their drawers, and
approve foam designs. Next.js (App Router) + Supabase.

This is a **separate deployable** from the marketing site in `docs/`. See the repo
root `CLAUDE.md` for the working agreement (the static site stays vanilla; this app
is where a framework is allowed).

## Stack

- **Next.js 15** (App Router, React Server Components, TypeScript)
- **Supabase** auth (email magic link) via `@supabase/ssr`
- No UI library — brand tokens in `src/app/globals.css` mirror the marketing site

## Local setup

```bash
cd portal
cp .env.example .env.local   # fill in the anon key (it's public / RLS-bounded)
npm install
npm run dev                  # http://localhost:3000
```

## Supabase Auth configuration

In the dashboard, **Authentication → URL Configuration**:

- **Site URL:** `http://localhost:3000` for local dev; set to the deployed origin
  (e.g. `https://app.thetidytool.com`) in production. No wildcards allowed here.
- **Redirect URLs** (wildcards allowed — use `**`, since a single `*` won't cross `/`):
  add `http://localhost:3000/**`, plus your production and any preview origins. This list
  must include the `/auth/confirm` destination or sign-in links are rejected.

**Email templates (optional):** the recommended server-side flow uses a `token_hash`
link. To enable it, edit **Authentication → Emails → Magic Link** so the link is:

```html
<a href="{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=email">Sign in</a>
```

This is **optional** — `/auth/confirm` also handles the default template's PKCE `?code=`
flow, so login works either way. Edit the template when you want the canonical setup
(and do the same for the Invite template once sign-in goes invite/claim-only).

## How it fits the backend

- **Auth:** Supabase email magic link via `@supabase/ssr`. Identity is validated with
  `getClaims()` (current Supabase guidance — verifies the JWT rather than trusting the
  raw session; `getSession()` is never trusted server-side). Middleware
  (`src/middleware.ts`) refreshes the session and redirects anonymous users to `/login`.
  The key is read from `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, falling back to
  `NEXT_PUBLIC_SUPABASE_ANON_KEY`.
- **Dashboard (`/`):** calls the `get_my_drawers()` RPC (in
  `supabase/migrations/0001_get_my_drawers.sql`, **applied to production 2026-06-28**). It
  scopes a user to their drawers by matching `order.customer_email` to the auth email — a
  transitional bridge until the `customer` table is activated with a real `auth.users` link.
- **Approval (`/approve/[id]`):** reuses the existing, already-deployed RPCs that the
  vanilla `docs/approve/` page uses — `get_drawer_approval`, `submit_drawer_approval`,
  `get_drawer_changelog`. No backend change needed for the approval flow itself.

## Relationship to `docs/approve/`

The vanilla page in `docs/approve/` stays — it's the public, link-based approval flow
(token = drawer id, no login) you can email to a customer. This portal is the
**logged-in** experience: a customer signs in once and sees *all* their drawers, then
approves them inside their account. Both hit the same RPCs, so they stay consistent.

## Deploy (base version) — runbook

This app has a build step, so it is **not** served by GitHub Pages. Recommended host:
**Vercel** (native Next.js support, least config). Cloudflare Pages also works via the
`@cloudflare/next-on-pages` adapter, but it's more setup.

### 1. Deploy on Vercel

1. Vercel → **Add New → Project → Import** the `tidytool_webpage` GitHub repo.
2. **Root Directory: `portal`** (important — the app isn't at the repo root).
3. Framework preset auto-detects **Next.js**. Build command `npm run build`, output
   handled automatically.
4. **Environment variables:**
   - `NEXT_PUBLIC_SUPABASE_URL` = `https://tkrrvpoupekrjqditupi.supabase.co`
   - `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` = your publishable key (or
     `NEXT_PUBLIC_SUPABASE_ANON_KEY` as fallback)
   - `NEXT_PUBLIC_SITE_URL` = the deployed origin, e.g. `https://app.thetidytool.com`
5. Deploy, then add the custom domain **`app.thetidytool.com`** and point DNS (CNAME) at Vercel.

### 2. Supabase auth settings (dashboard)

- **Authentication → URL Configuration → Site URL:** `https://app.thetidytool.com`
- **Redirect URLs:** add `https://app.thetidytool.com/**` (keep `http://localhost:3000/**`).
- **Email:** configure custom SMTP (the built-in sender is rate-limited and unbranded), and
  optionally edit the Magic Link template to the `token_hash` form (see "Email templates" above).
- **Sign-ups:** the app is invite/claim-only (`shouldCreateUser: false`). Disable open
  signups, and onboard customers via **Authentication → Users → Invite** until the automated
  invite flow ships.

### 3. Wire the marketing site → portal

Once the portal URL is live, update `docs/customer-login.html` (currently a "coming soon"
page) to send customers to `https://app.thetidytool.com`.

### 4. Before public launch — required

- **Close the RLS hole:** the anon key can currently read every `drawer` and `employee` row
  directly (see ROADMAP "Supabase database hardening"). Lock this down first.
- **Remove `[TEST]` rows** seeded for development (nicknames prefixed `[TEST]`).
