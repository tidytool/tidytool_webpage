# tidyCAM launch coordination — server-side gating & storage tightening

**From:** tidyCAM mobile pre-launch review (2026-07-05) · **Status:** Proposed — needs
backend owner review before applying · **Applies to:** Supabase project `tidytool`
(`tkrrvpoupekrjqditupi`)

Per the decided ownership model (BACKEND-analysis §9.5): **migrations live in this repo;
tidyCAM consumes, never migrates.** This doc is the mobile side's request list, with
ready-to-review SQL. Nothing here has been applied.

## Context

tidyCAM is heading to an invite-only TestFlight launch. The mobile review found that all
access gating was client-side (bypassable with the public anon key). The mobile app has
now shipped a client-side approval gate (UX only — it checks `app_metadata.approved`,
optional `profiles.approved` fallback, and signs unapproved sessions out). **The
authoritative wall must be RLS**, same principle as FEATURE-profiles: "the anon key ships
in page source, so RLS is the entire wall."

Also relevant: the mobile app no longer bundles `SUPABASE_DB_URL` (it previously shipped
the Postgres connection string inside the IPA — removed 2026-07-05, see item 4).

## 1. Server-side approval gate (launch-blocker — now MANDATORY)

> **Decision 2026-07-05:** signups stay **enabled** (see §3). With open signup, this
> RLS gate is the *only* wall: anyone can create an authenticated account with the
> public anon key, so approval MUST be enforced in Postgres, not just the app. This
> is no longer optional hardening — without it, open signup = open backend.

**Recommendation: `app_metadata.approved` + an `is_approved()` RLS helper.** Zero schema
change, admin-only writable (`user_metadata` is user-writable and must never be trusted),
and it matches what the mobile client already checks. Alternative considered:
`user_roles` membership (the `is_admin()` pattern) — also fine; pick one and both
surfaces will follow.

Draft migration:

```sql
-- Approval gate: JWT app_metadata.approved (set only by admin/service role)
create or replace function public.is_approved()
returns boolean
language sql stable security definer
set search_path = public
as $$
  select coalesce(
    (auth.jwt() -> 'app_metadata' ->> 'approved')::boolean,
    false
  ) or public.is_admin();
$$;

revoke all on function public.is_approved() from public, anon;
grant execute on function public.is_approved() to authenticated;

-- Gate the app tables: approval required in addition to ownership.
-- (Repeat the pattern for each drawer/order policy.)
alter policy "drawers select" on public.drawer
  using (public.is_admin() or (created_by = auth.uid() and public.is_approved()));
alter policy "drawers update" on public.drawer
  using (public.is_admin() or (created_by = auth.uid() and public.is_approved()))
  with check (public.is_admin() or (created_by = auth.uid() and public.is_approved()));
-- drawer INSERT + order select/insert/update: same added conjunct.
```

Approving a user (service role / SQL editor):

```sql
update auth.users
set raw_app_meta_data = coalesce(raw_app_meta_data, '{}'::jsonb)
    || '{"approved": true}'::jsonb
where email = 'invitee@example.com';
```

Note: after approval the user must re-login (or refresh the session) so the JWT picks up
the claim — acceptable for invite-only.

## 2. Storage policy tightening (the known debt, BACKEND-analysis §4.2)

`20260703220000_baseline_storage_policies.sql` deliberately preserved the broad
`drawer-assets` policies because "tightening can affect tidyCAM uploads." **Verified from
the tidyCAM live code path** (`SupabaseOrderService`): uploads go to
`drawer-assets` with key `{drawerUuid}/orders/{orderId}/photo_{ts}.{ext}` and to
`lidar_scans` with key `{drawerUuid}/orders/{orderId}/model_{ts}.{ext}`. Both satisfy the
tight UUID-prefix / `model_` regex policies, and Supabase sets `owner` to the
authenticated uploader. **The broad policies can be dropped without breaking tidyCAM:**

```sql
-- Remove the broad bucket-only policies that neutralize the scoped ones.
drop policy if exists "auth upload drawer-assets" on storage.objects;
drop policy if exists "auth update drawer-assets" on storage.objects;

-- Close the cross-tenant read: drawer_assets_select currently has no owner check.
drop policy if exists "drawer_assets_select" on storage.objects;
create policy "drawer_assets_select" on storage.objects
  for select to authenticated
  using ((bucket_id = 'drawer-assets'::text)
    and (owner = auth.uid())
    and (name ~ '^[0-9a-f-]{8}-[0-9a-f-]{4}-[0-9a-f-]{4}-[0-9a-f-]{4}-[0-9a-f-]{12}/.*'::text));
```

⚠️ Caveats to verify before applying:
- The portal/QR pages read drawer photos via **public bucket URLs**, not authenticated
  listing — public-object URL access is unaffected by SELECT policies. Confirm no portal
  code does authenticated `storage.from('drawer-assets').list/download` of *other users'*
  objects (admin flows should go through service role or an `is_admin()` disjunct —
  add `or public.is_admin()` if needed).
- Pre-existing objects uploaded before owner tracking may have `owner is null`; if any
  are still read via authenticated download, add a backfill or an admin path first.
- Test on a branch with a TestFlight build (upload photo + model, view drawer detail)
  before prod.

## 3. Auth dashboard actions (no migration)

- **Signups: LEAVE ENABLED** (decision 2026-07-05). New accounts are allowed; the
  invite-only guarantee is enforced by the §1 approval gate (unapproved accounts can
  authenticate but reach no data), NOT by blocking account creation. Consequence: §1 is
  a hard launch-blocker — see the note there.
- The live mobile app currently exposes **no in-app signup UI** (the `allowSignup` flag
  lives only in dead `lib/pages/` code; the shipped `LoginScreen` has no create-account
  button). Accounts are created via the portal / API today. Adding in-app self-registration
  is a separate, optional mobile task.
- Consider enabling leaked-password protection while in the dashboard (§4.6, still open).

## 4. Rotate the database password (urgent, independent of the above)

Until 2026-07-05 the mobile app bundled `SUPABASE_DB_URL` — the full Postgres connection
string including the DB password — inside every build (`.env` is a Flutter asset). Any
IPA/simulator build that left Sam's machine carries it. The mobile repo now keeps that
URL in a gitignored, non-bundled `.env.release`, and its release precheck **hard-fails**
if the bundled `.env` ever contains it again. Remaining action: **rotate the database
password** (Project Settings → Database) and update `.env.release` on the build machine
(and the Session Pooler URL if used).

## Sequencing

1. Item 4 (password rotation) — now; nothing depends on it.
2. Item 1 (approval gate) — before first invite. **Mandatory** now that signups stay
   open (§3). Mobile client is already compatible.
3. Item 2 (storage tightening) — before first invite, after branch test with tidyCAM.
4. Item 3 — no action (signups stay enabled); optionally enable leaked-password protection.

## Open question surfaced by the 2026-07-05 live advisor review

~35 `SECURITY DEFINER` admin RPCs (`admin_bulk_delete_*`, `admin_create_*`,
`admin_update_*`, `get_admin_*`, etc.) are `EXECUTE`-able by the **`authenticated`** role,
not just admins. If each does not re-check `is_admin()` internally, any signed-in user
(and, with open signup, any member of the public) could call them via `/rest/v1/rpc/...`
to read or destroy other customers' data — potentially a larger hole than the storage one.
**Backend owner: please confirm these all gate on `is_admin()` or revoke EXECUTE from
`authenticated`.** (Advisor: lint 0029.)
