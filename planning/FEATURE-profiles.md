# Feature spec — Customer profiles, QR drawer pages, and design approval

**Status:** Proposed · **Owner:** Sam · **Date:** 2026-06-12
**Pricing decision:** Included free with every order. We charge for atoms (foam, engraving, redesigns), not bits.

## Goal

Give every customer a lightweight portal tied to their orders:

1. **QR drawer pages** — a QR code engraved into each drawer's foam resolves to a page showing that drawer's photo, layout, and tool list. Public read-only; owner can log in to manage.
2. **Design approval + label entry** — before we cut, the customer reviews the proposed layout, types the engrave label for each tool outline, and clicks Approve. The approval row (layout + final labels, timestamped) is our authorization to manufacture.

Order history and reorder shortcuts ride along nearly for free once the schema exists.

## Why it fits the business

- The engraved QR turns every drawer into a referral channel — every coworker who scans sees a TidyTool page with a "Get yours" CTA. Free-included is deliberate: charging would kneecap our best marketing asset.
- The approval record is an audit trail: nothing is cut without a timestamped customer sign-off on layout **and** labels. Protects against "that's not what I ordered."
- Long-term, "what belongs in this drawer" pages are one step from shop tool-accountability (scan at shift end, confirm nothing missing) — the future B2B product. The consumer profile stays free; shop/fleet inventory is where a paid tier could live someday.

## Architecture

No new infrastructure, no framework, no build step (per CLAUDE.md).

- **Hosting:** static pages on the existing site (GitHub Pages today; survives a move to Cloudflare Pages).
- **Backend:** Supabase (already in use for customer projects). Client is `supabase-js` loaded from CDN; all logic is vanilla client-side JS.
- **Auth:** Supabase magic links. We provision the user (email from the order) at order time — no passwords, first login "just works."
- **Security boundary:** the anon key ships in page source, so **Row Level Security is the entire wall.** Every table gets explicit policies (sketches below). No table without RLS enabled.
- **Storage:** Supabase Storage bucket for drawer/layout photos. Public-read bucket for photos shown on public drawer pages; owner-write only.

### QR permanence (critical)

QRs are engraved in foam and must work in 10 years.

- Encode a short stable URL on **our own domain**: `https://tidytool.com/q/{token}` (8-char unguessable token). Never encode a GitHub Pages URL, a Supabase URL, or anything tied to today's hosting.
- `/q/` is a redirect layer: on GitHub Pages, `q/index.html` reads the token from the path/query and redirects to `drawer.html?d={token}`. If the site is ever rebuilt, only the redirect layer must be preserved.
- Tokens are generated server-side at order processing and stored on the `drawers` row. Tokens are never reused or reassigned.
- **Brand-hedge note:** the rebrand call (~Sept 2026, per ROADMAP) affects the domain we engrave. Until the domain is settled, do not engrave QRs pointing at a tidytool.com URL — or engrave only for orders we're willing to keep redirecting. Cheapest hedge: register one neutral short domain (e.g. for `/q/` links only) that survives any rename.

### Page access model

| Page | Anonymous (scan) | Logged-in owner |
|---|---|---|
| `drawer.html` | Read-only: photo, layout, tool list, labels, "Get yours" CTA | Same + edit labels/notes, "reorder this drawer" (pre-filled quote form) |
| `account.html` | Redirect to login | Project/order list, pending approvals badge |
| `approve.html` | No access | Layout image + label entry form + Approve button |

## Data model (Supabase / Postgres)

```
customers        id (uuid, = auth.users.id), email, name, company, created_at
projects         id, customer_id → customers, status        -- quote|design|awaiting_approval|approved|cut|shipped
                 created_at, approved_at
drawers          id, project_id → projects, qr_token (unique, 8 chars), title,
                 layout_image_path, photo_path, is_public (bool, default true)
drawer_items     id, drawer_id → drawers,
                 outline_ref text,        -- "A", "B", … "AA" (matches callout on layout image)
                 detected_name text,      -- our prefill from the tool scan (nullable)
                 engrave_label text,      -- customer's final label
                 label_locked bool default false,
                 sort_order int
approvals        id, project_id → projects, customer_id, approved_at,
                 layout_image_path,       -- snapshot of exactly what was approved
                 labels_snapshot jsonb    -- frozen {outline_ref: engrave_label} at approval time
```

Backend (our side) writes via the **service role key** from local scripts — never from the website.

### RLS sketches

```sql
-- drawers: public read of public drawers; owner full read
create policy "public read" on drawers for select
  using (is_public = true);
create policy "owner read" on drawers for select
  using (project_id in (select id from projects where customer_id = auth.uid()));

-- drawer_items: readable wherever the parent drawer is readable;
-- owner may UPDATE engrave_label only while unlocked
create policy "owner label edit" on drawer_items for update
  using (not label_locked
         and drawer_id in (select d.id from drawers d
                           join projects p on p.id = d.project_id
                           where p.customer_id = auth.uid()))
  with check (not label_locked);

-- approvals: owner insert-only (no update/delete — it's an audit record)
create policy "owner approve" on approvals for insert
  with check (customer_id = auth.uid());
```

(Column-level: grant update only on `engrave_label` to authenticated, or enforce via a trigger that rejects changes to other columns.)

## Label entry + approval flow (MVP core)

This is the manufacturing-critical path.

1. **Processing (us):** scan tools, generate layout. Each outline on the layout image gets a callout letter: A, B, … Z, AA, AB, … Insert `drawer_items` rows with `outline_ref` and our best-guess `detected_name` as prefill.
2. **Notify:** customer gets an email (magic link) — "Your design is ready for review."
3. **Review (`approve.html`):** layout image at top; below it, one input per outline:

   ```
   Outline A   [ 3/8" Ratchet        ]   (prefilled from detected_name)
   Outline B   [ Torque Wrench       ]
   …
   Outline AA  [ <enter name>        ]   (blank if no prefill)
   ```

   - Live validation: max engrave length (set per font/outline size — store a `max_chars` if it varies per item), allowed character set (what the engraver supports), no empty labels at submit.
   - "Copy our suggestions" stays the default — customer only edits what's wrong. Lowest friction.
4. **Approve:** one button. Writes the `approvals` row with the labels snapshot, sets `label_locked = true` on all items, flips project status to `approved`, emails us.
5. **Rule: nothing is cut without an approvals row.** Changes after approval = new approval round (insert a new row; never mutate the old one).

Out of scope for MVP: drag-and-drop layout editing. The layout is a static image we upload; approval is a button. GUI editor is its own future project.

## Phased tickets

### Phase A — Foundation (backend, no site changes)
- [ ] A1. Create tables + RLS policies in Supabase; enable RLS everywhere.
- [ ] A2. Storage buckets (`layouts`, `photos`) with public-read/owner-write rules.
- [ ] A3. Processing-side script: provision auth user from order email; create project/drawer/items; generate `qr_token`.
- [ ] A4. QR generation script (token → PNG/SVG at engraving resolution).

### Phase B — Approval + labels (revenue-critical, do first on the site)
- [ ] B1. `approve.html`: magic-link auth, layout image, label form with validation, Approve action.
- [ ] B2. Email notify on design-ready and on approval (Supabase edge function or processing script).
- [ ] B3. Lock-on-approve + snapshot logic; "request changes" path (status back to `design`).

### Phase C — QR drawer pages
- [ ] C1. `q/` redirect layer + `drawer.html` public view (photo, layout, labeled tool list, "Get yours" CTA).
- [ ] C2. Owner mode: edit labels/notes post-delivery (does not touch locked manufacturing snapshot), reorder button → pre-filled quote form.
- [ ] C3. Decide + document the engraved domain (rebrand hedge above) **before the first QR is cut.**

### Phase D — Account page (cheap once A–C exist)
- [ ] D1. `account.html`: project list, statuses, pending-approval badge, links to drawer pages.

### Later / not now
- GUI drag-and-drop layout editor.
- Shop/fleet inventory (multi-user accounts, scan-to-audit) — the future paid tier.
- Customer photo uploads.

## Definition of done (per CLAUDE.md)

- Mobile-first — QR scans are ~100% phone traffic; drawer page must be excellent at 375px.
- No frameworks; `supabase-js` via CDN is the only new dependency (flagging per house rules — needs Sam's sign-off).
- Portal stays off the conversion path: an `account.html` link in the footer, nothing more.
- RLS verified by testing as anon + as a second customer before anything ships.

## Open questions

1. Engraving constraints: max label length and character set per outline size? (Drives validation rules — needs Sam's numbers.)
2. Engraved domain: tidytool.com, or a neutral hedge domain until the rebrand call?
3. Does "request changes" at approval loop through email/manual for now (suggest yes for MVP)?
4. Photo at fulfillment: who shoots the final drawer photo and uploads it — part of the packing checklist?
