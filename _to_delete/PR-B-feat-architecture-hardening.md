## PR B (draft) — `feat/architecture-hardening` → `chore/architecture-review`

**Title:** feat(portal): architecture-review hardening — action guards, open redirect, quote error, orphan route, proposed migrations

Open as a **draft**, base = `chore/architecture-review` (retarget to `main` after PR A
merges). Every commit here is HIGH-RISK under CLAUDE.md §4 (auth, mutation semantics,
proposed migrations) and needs Sam's or Shem's sign-off. The commits are independent —
drop any one without affecting the others.

### Commit 1 — `fix(portal)`: gate paid/privileged server actions, close open redirect, check box query

| Finding | Change |
|---|---|
| **P-3** `lookupOrderDistanceAction` billed Google Distance Matrix *before* any role check; server actions are POST endpoints any signed-in user (customers included) can hit | `requireAdminOrError()` runs first; `distance.ts` fetch gets a 10 s `AbortSignal.timeout` |
| **P-5** `/auth/confirm?next=https://evil` redirected off-site after a valid link | only `/`-prefixed, non-`//` values honoured; everything else → `/` |
| **P-1** `priceQuote` ignored a failed `box` query and priced every boxed drawer as 1 copy | returns `{ok:false, error}` like the drawer query beside it |
| **P-2** the order page shows state/quote/box controls to admins only, but the actions and RPCs accept any staff user | `setOrderStateAction`, `setDrawerStateAction`, `quotePreviewAction`, `quoteFormAction`, `setQuoteStatusAction` and the four box actions now require admin — each gate is commented `review P-2`. **Decision needed:** if staff *should* do these, delete the gates and the page's `isAdmin` checks together instead |
| **P-9/P-10** private `requireAdmin()` copy in `actions.ts`; `/admin/employees` was the only admin tab without `requireAdminPage()` | shared `requireAdminOrError()` in `lib/require-admin.ts`; employees page gated like Customers/Organizations/History |

### Commit 2 — `chore(portal)`: remove the unreachable `/approve/[id]` route

Nothing links to it since PR #27 made label submission the approval; the design-ready
email links to the public `docs/approve` page (unchanged). Its History was also always
empty for customers (`get_drawer_changelog` guard is `created_by = auth.uid()`, i.e.
the tidyCAM operator). Removes the route, `ApprovalForm`, `History`, and the
`DrawerApproval`/`DrawerEvent` types + `formatDimensions` whose only consumer it was.
**Product decision (review §8 #2):** drop this commit if the logged-in approval screen
should come back — it then needs a customer-scoped changelog RPC and an inbound link.

### Commit 3 — `docs(planning)`: seven proposed migrations

Under `planning/proposed-migrations/` — deliberately **outside** `portal/supabase/migrations/`
so nothing applies them by accident. Each has why / verification / rollback in its header:

| file | finding |
|---|---|
| `01_link_only_confirmed_users.sql` | D-2 — `link_customer_on_auth` links only confirmed emails (invites still link on acceptance via `update of email_confirmed_at`) |
| `02_recompute_on_drawer_delete.sql` | D-3 — `AFTER DELETE` on `drawer` recomputes the order |
| `03_recompute_order_status_lock.sql` | D-5 — `select … for update` in `recompute_order_status` |
| `04_revoke_anon_on_claims_rpcs.sql` | D-6 — revoke `anon` on the 8 RPCs recreated by `20260812210000` (prod advisor confirms they're anon-executable today) |
| `05_public_rpcs_project_dimensions.sql` | D-11 — public RPCs stop returning `calibration_matrix`, `correction` (staff name), `reference_corners`, `calibration_quality`, `notes`, `ortho_view` |
| `06_drop_employee_select_policy.sql` | D-12 — `employee` no longer readable by every signed-in user |
| `07_drawer_order_id_index.sql` | D-17 — the missing `drawer(order_id)` index |

**Validated:** all seven applied inside one rollback-only `DO` block on the persistent
`dev` branch with behavioural asserts (unconfirmed sign-up doesn't link / confirmation
links; delete recomputes `production → delivered` + records the event; public RPCs strip
internal keys; anon loses the 8 RPCs; `employee` unreadable; index present). Result:
`ROLLBACK_OK`, and dev verified untouched afterwards. The block is committed as
`validate-rollback-only.sql`. (The branch test also caught that `drawer_id_key` can't be
dropped — five FKs depend on it — so 07 only adds the index.)

Promotion path is in `planning/proposed-migrations/README.md`: data-clone branch → apply
→ `status-backbone-branch-tests.sql` + advisor → move into `migrations/` under an
apply-time timestamp → `tools/db_apply.py --env prod --approved` → mirror to `dev`.

### Verification

- `tsc --noEmit` clean; `next build` green; pricing tests 36/36.
- Manual check after merge: as a **staff** (non-admin) user, Hold/Cancel/Generate quote/
  Organize should not be visible *and* a hand-crafted POST should land back on the order
  page with "Not authorized." As a customer, invoking the distance action must not reach
  Google (check the Maps console request count).
- Confirm in the Supabase dashboard that **Confirm email** is ON before/after applying 01.
