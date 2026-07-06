# SMTP + notification emails runbook

Goal: customer lifecycle emails (design ready → "review your design"; approved →
"we're cutting") per `ARCHITECTURE.md` §3, plus custom SMTP so auth emails
(invites, magic links, resets) stop using Supabase's capped built-in sender.

**STATUS: LIVE (2026-07-05).** All steps below are done and the design-ready
email was smoke-tested end-to-end (Resend 200, delivered). Kept as reference.

- Edge function `notify` deployed (code: `portal/supabase/functions/notify/index.ts`).
  Auth = `x-notify-secret` shared secret; no-ops gracefully until secrets exist.
- Migration `20260708000000_notification_emails.sql` **applied to prod** (Sam
  approved 2026-07-05) — `_notify_customer_email` helper hooked into
  `log_design_revision` (design-ready email) and `submit_drawer_approval`
  (approved email). Best-effort, skips `[TEST]` drawers and missing emails.
- Gotcha for future changes: the Resend-verified domain is the subdomain
  `mail.thetidytool.com`. Sender is `tidy <tidy@mail.thetidytool.com>` via the
  `NOTIFY_FROM` function secret; a bare `@thetidytool.com` sender gets a 403.

## 1. Resend domain + DNS

You already have the Resend account + API key (in `portal/.env.local`).

- Resend → Domains → Add `thetidytool.com` (region closest to you).
- Add the records Resend shows at your DNS host (Squarespace): DKIM (TXT/CNAME),
  SPF for the `send` subdomain, and MX for bounces. Wait for "Verified".
- Recommended senders: `no-reply@thetidytool.com` (notifications) — the function
  defaults to this; override with the `NOTIFY_FROM` secret if you prefer `portal@`.

## 2. Supabase custom SMTP (auth emails)

Authentication → Emails → SMTP Settings:

- Host `smtp.resend.com`, port `465`, username `resend`, password = your Resend
  API key. Sender: `no-reply@thetidytool.com`, name "TidyTool".
- While you're in Emails: apply the token_hash templates from
  `portal-launch-runbook.md` §4 (Magic Link / Invite / Reset password).
- Bump the rate limit (Authentication → Rate Limits → emails per hour) — the
  built-in 2/hr cap no longer applies once custom SMTP is on; ~30/hr is plenty.

## 3. Edge function secrets

Edge Functions → `notify` → Secrets (or `supabase secrets set` from `portal/`):

- `RESEND_API_KEY` = your Resend key
- `NOTIFY_HOOK_SECRET` = a fresh random string (e.g. `openssl rand -hex 32`)
- Optional: `NOTIFY_FROM` (default `TidyTool <no-reply@thetidytool.com>`),
  `NOTIFY_REPLY_TO` (default `samochristensen@gmail.com` — replies come to you)

## 4. Vault secret (lets the DB call the function)

SQL editor, with the SAME value as `NOTIFY_HOOK_SECRET`:

```sql
select vault.create_secret('<the-secret>', 'notify_hook_secret');
```

## 5. Approve + apply the migration

Review `portal/supabase/migrations/20260708000000_notification_emails.sql`
(it modifies `submit_drawer_approval` — approval path, hence your gate), then
say the word and it gets applied via MCP, or apply via `supabase db push`.

Order doesn't matter much: until step 4's secret exists the DB helper no-ops;
until step 3's key exists the function no-ops. Nothing breaks part-way.

## 6. Smoke test

1. SQL editor (runs as postgres, which keeps execute rights):
   ```sql
   select public._notify_customer_email('<one-of-your-drawer-ids>'::uuid, 'design_ready', 'smoke test', 1);
   select status_code, content from net._http_response order by id desc limit 1; -- run ~5s later
   ```
   Expect 200 + `{"ok":true}` and the email in your inbox (your drawers carry
   your email). `{"skipped":...}` → step 3 missed; nothing in `net._http_response`
   → step 4 missed.
2. Approve a drawer end-to-end on the public approve page → Discord ping AND
   "we're cutting" email arrive.
3. Check the email isn't in spam; From shows `thetidytool.com`.

## Done when

tidyDesk uploading a design triggers a customer email automatically, approving
sends the confirmation, and invite/reset emails arrive from `thetidytool.com`.
