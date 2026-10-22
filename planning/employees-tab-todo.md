# Employees tab — deferred TODO (as of 2026-08-27)

Parking lot from the employees-tab work (audit → PR #32 → PR #33) and Sam's
feature-suggestion review. Deliberately not in scope yet; pull items into a
round when ready. Left UNCOMMITTED alongside PR #33 so the approved head
stayed byte-identical — fold into the next docs commit.

## From PR #33 review (accepted at shop scale, revisit later)

- [ ] Harden the "already registered" error matching in `addEmployee` /
      `setEmployeePassword` — match Supabase error codes instead of message
      regex (brittle but precedented today).
- [ ] Consider guarding `setEmployeePassword` against resetting OTHER
      admins' passwords (or at least logging it) — inherent to admin resets,
      accepted for now.
- [ ] Convention: migrations that ADD/RENAME REST-exposed functions should
      note the PostgREST reload in their header and be applied with
      `tools/db_apply.py --reload-postgrest` (PR #33's migration needed the
      reload run separately).

## Tier 2 leftovers (from the original audit)

- [ ] Resend invite / Copy invite link per row (`admin.generateLink`) — the
      deliverability escape hatch; today recovery is "Email me a link" on
      the sign-in page.
- [ ] Delete never-signed-in accounts from the UI (typo'd invites).
- [ ] Purge prod test accounts: admin@admin.com, paul@jams.com,
      sam2@thetidytool.com (no roles, no sign-ins that matter).

## Feature backlog (industry-standard, filtered to shop size)

- [ ] Employee profiles: display name + phone, shown in Employees rows, the
      work queue's "claimed by", and History. Decide: link or retire the
      legacy unlinked `public.employee` table (Jan scaffold: name/phone/
      catchphrase, no auth linkage).
- [ ] Suspend / offboard: Supabase ban (`banned_until`) blocks sign-in while
      preserving history — the correct alternative to revoke-only.
- [ ] Role-change audit: write grant/revoke (staff + admin) into the
      existing History log with actor + timestamp.
- [ ] Per-employee work view: what each person has claimed / completed
      (queue already records `claimed_by`; data exists in drawer events).
- [ ] Truthful last-activity: portal last sign-in + last tidyCAD claim.
- [ ] MFA for the admin accounts (Supabase MFA) — best security upgrade for
      a two-admin shop.
- [ ] Permissions-matrix card on the Employees tab (what staff vs admin can
      do) — one static card, prevents confusion.
- [ ] Playwright e2e of invite → set-password → sign-in → staff view.

Skipped on purpose at this size: PTO/scheduling/payroll/org-chart HR suite,
SSO/SCIM directory sync.

## Housekeeping

- [ ] ROADMAP.md not yet updated for employees rounds 1 + 2 — fold into the
      next docs commit together with this file.
