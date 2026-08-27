# Employees tab — evaluation + upgrade plan (2026-08-26)

Scope: `/admin/employees` (page.tsx, EmployeesList.tsx, admin/actions.ts,
lib/supabase/admin.ts, auth/confirm route, set-password page, migrations
20260715191252 + 20260715191910) plus live prod data.

## Verdict

The create-user workflow WORKS end to end, proven in production:
emileehamilton33@gmail.com invited 2026-07-17 → confirmed → signed in
2026-07-22 with staff. Auth email goes through Resend custom SMTP (live
2026-07-05), so the built-in 2/hr cap doesn't apply. Security layering is
sound: admin layout gate + requireAdmin() in server actions + is_admin()
re-checked inside SECURITY DEFINER RPCs; service-role key server-only.

## Flow today

Grant staff by email → RPC returns "no auth user" → "Invite them & grant
staff" button appears → inviteUserByEmail (redirect /auth/confirm?next=
/set-password) → grant_staff_role → user sets password, signed in as staff.
Expired-link recovery: /login "Email me a link" (resetPasswordForEmail).

## Reliability findings (severity order)

1. HIGH — invite is error-driven: adding a new employee requires a failed
   grant first, and the raw RPC error shows alongside the friendly hint.
   Fix: first-class "Invite employee" action; suppress raw errors.
2. HIGH — lost/expired invite: re-inviting hits "already registered", code
   swallows it, NO new email goes out. No resend/copy-link on the page.
   Fix: Resend invite (recovery email) + Copy invite link (admin.generateLink).
3. MED — no pending-invite visibility (invited_at/confirmed not returned by
   admin_list_users). Can't tell if an invite was accepted.
4. MED — no temp-password handoff on this tab; createPortalLoginWithPassword
   already exists on Customers tab — reuse it.
5. LOW — typo'd emails create permanent accounts (no validation, no delete
   in UI). Prod already has test clutter: admin@admin.com, paul@jams.com,
   sam2@thetidytool.com.
6. LOW — no audit trail (granted_by/granted_at) on user_roles.

Note: 'admin' role is not manageable from the UI by design — SQL only.

## Tiers

- Tier 1 (~half day, UI only): first-class invite, friendly errors, email
  validation + confirm echo, auto-dismiss notices, modal instead of confirm().
- Tier 2 (~1 day, small migration — needs Sam sign-off): pending badge via
  invited_at/confirmed in admin_list_users; resend invite; copy invite link;
  temp-password action; delete never-signed-in accounts; purge test accounts.
- Tier 3 (~1-2 days): names, sorting/pagination, audit columns + display,
  ban/disable, admin-role UI w/ last-admin guard, Playwright e2e of invite loop.

Full report artifact: https://claude.ai/code/artifact/75a627cd-76d1-468f-bca4-7701a5e01c97
