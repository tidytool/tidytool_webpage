# TidyTool web — system architecture (as built, 2026-09-10)

Companion to `architecture-review-2026-09-10.md`. Everything here is derived from the code
at `main` (`5ec8ec4`) and the prod migration history; nothing is aspirational. Diagrams are
Mermaid (render on GitHub, in VS Code, or at mermaid.live).

Numbers in the notes: 11 static pages, 17 portal routes + 4 server-action modules,
29 components, 54 migrations, 20 tables, ~95 SQL functions (of which ~70 are REST-exposed
RPCs), 1 edge function.

---

## 1. Context — who talks to what

```mermaid
flowchart TB
  classDef ext fill:#eff2f5,stroke:#dde3e8,color:#1e2a33
  classDef ours fill:#ffffff,stroke:#e8312a,color:#1e2a33,stroke-width:2px
  classDef data fill:#fdf0ee,stroke:#e8312a,color:#1e2a33

  visitor([Prospect]):::ext
  customer([Customer]):::ext
  staff([Staff / Admin]):::ext
  cam[tidyCAM<br/>iPad scan app]:::ext
  cad[tidyCAD<br/>desktop design app]:::ext

  subgraph GH[GitHub Pages · thetidytool.com]
    docs[docs/ static site<br/>marketing + /approve + /q + drawer.html]:::ours
  end
  subgraph VC[Vercel · app.thetidytool.com]
    portal[portal/ Next.js 15<br/>customer hub + admin CRM]:::ours
  end
  subgraph SB[Supabase project tkrrvpoupekrjqditupi]
    pg[(Postgres<br/>RLS + SECURITY DEFINER RPCs<br/>status backbone)]:::data
    auth[Auth<br/>email+password, invites]:::data
    store[Storage<br/>drawer-assets · lidar_scans]:::data
    fn[Edge fn notify<br/>Deno]:::data
    vault[Vault + pg_net]:::data
  end
  tally[Tally form LZoGyG]:::ext
  resend[Resend]:::ext
  discord[Discord webhook]:::ext
  gmaps[Google Distance Matrix]:::ext
  qb[QuickBooks<br/>TSV export only]:::ext

  visitor -->|reads, submits quote| docs
  docs -->|embed| tally
  tally -->|email notification| staff
  customer -->|QR / approval link, anon key fetch| docs
  docs -->|get_public_drawer · get_drawer_approval<br/>submit_drawer_approval · get_public_drawer_changelog| pg
  customer -->|login, tracker, labels| portal
  staff -->|/admin| portal
  portal -->|supabase-ssr client · RPCs under RLS| pg
  portal -->|getClaims / invites / set password<br/>service role only in server actions| auth
  portal -->|DXF zip proxy, previews| store
  portal -->|lookup miles| gmaps
  portal -.->|CustomerBreakdown TSV| qb
  cam -->|staff role · inserts order/drawer<br/>photos, point clouds| pg
  cam --> store
  cad -->|record_dxf_upload · set_drawer_stage<br/>claims/progress · log_design_revision| pg
  cad --> store
  pg -->|triggers · pg_net POST x-notify-secret| fn
  pg -->|_notify_discord_approval| discord
  fn -->|design_ready · approved · labels_submitted| resend
  resend --> customer
  vault -.->|secrets| pg
```

Notes
- The only two things the public can call without a session are the four capability-link
  RPCs (`get_public_drawer`, `get_drawer_approval`, `submit_drawer_approval`,
  `get_public_drawer_changelog`) and the Tally form. The drawer UUID is the capability.
- `notify` is reached only from Postgres (`pg_net`), never from the app; the app has no
  email code of its own.
- `qr_url` is a generated column — `https://thetidytool.com/q/?d={drawer_id}` — engraved into
  foam. `docs/q/index.html` is a permanent redirect shim to `drawer.html?d=`. Do not move it.

---

## 2. Portal — routes, actions, libraries

```mermaid
flowchart TB
  classDef route fill:#ffffff,stroke:#1e2a33,color:#1e2a33
  classDef client fill:#fff7e6,stroke:#a85c12,color:#1e2a33
  classDef action fill:#e7f6ec,stroke:#1e7e45,color:#1e2a33
  classDef lib fill:#eff2f5,stroke:#5b6870,color:#1e2a33
  classDef db fill:#fdf0ee,stroke:#e8312a,color:#1e2a33

  mw[middleware.ts<br/>session refresh; public = /login, /auth/*]:::lib

  subgraph CustomerRoutes["Customer routes"]
    home["/ dashboard (RSC)"]:::route
    login["/login (client)"]:::client
    setpw["/set-password (client)"]:::client
    confirm["/auth/confirm (route)"]:::route
    labels["/labels/[id] (RSC)"]:::route
    approveP["/approve/[id] (RSC) — orphan, no inbound link"]:::route
  end

  subgraph AdminRoutes["Admin routes — layout requires is_admin or is_staff"]
    aLayout["/admin layout"]:::route
    aHome["/admin pipeline"]:::route
    aQueue["/admin/queue"]:::route
    aOrders["/admin/orders"]:::route
    aOrder["/admin/orders/[id]"]:::route
    aDxf["/admin/orders/[id]/dxf (route)"]:::route
    aCust["/admin/customers ·admin·"]:::route
    aOrg["/admin/organizations ·admin·"]:::route
    aEmp["/admin/employees ·admin (RPC only)·"]:::route
    aHist["/admin/history ·admin·"]:::route
    aAcc["/admin/accuracy ·admin·"]:::route
  end

  subgraph ServerActions["Server actions (use server)"]
    act["admin/actions.ts (32 exports)<br/>CRM · orders · drawers · roles · order/drawer state"]:::action
    box["box-actions.ts"]:::action
    quote["quote-actions.ts<br/>priceQuote → save_quote"]:::action
    site["site-actions.ts<br/>address + miles"]:::action
  end

  subgraph Lib["lib/"]
    sClient["supabase/server.ts<br/>cookie client (RSC, actions, routes)"]:::lib
    bClient["supabase/client.ts<br/>browser client"]:::lib
    aClient["supabase/admin.ts<br/>service role — dynamic import in actions only"]:::lib
    authL["supabase/auth.ts getClaims()"]:::lib
    req["require-admin.ts requireAdminPage()"]:::lib
    types["types.ts (hand-written RPC row types)"]:::lib
    pricing["pricing/ config · engine · normalize · quickbooks<br/>(36 unit tests)"]:::lib
    labelsL["labels.ts DXF pocket parser"]:::lib
    dxf["dxf.ts"]:::lib
    dist["distance.ts (Google)"]:::lib
  end

  pg[(Supabase Postgres<br/>RPCs)]:::db
  authS[(Supabase Auth)]:::db
  store[(Storage)]:::db

  mw --> home & labels & aLayout
  home -->|get_my_drawers · get_my_label_status<br/>get_order_tracker ×N| sClient
  labels -->|get_drawer_labels| sClient
  labels -.->|LabelEditor: save/submit labels, corners| bClient
  approveP -.->|ApprovalForm: submit_drawer_approval| bClient
  login -.->|signInWithPassword · resetPasswordForEmail| bClient
  setpw -.->|updateUser| bClient
  confirm -->|verifyOtp / exchangeCodeForSession| sClient
  aLayout -->|is_admin · is_staff| sClient
  aHome -->|get_status_pipeline · get_admin_pipeline<br/>orphans · customers| sClient
  aHome -.->|StatusPipeline realtime status_event| bClient
  aQueue -->|get_work_queue| sClient
  aOrders -->|get_admin_orders| sClient
  aOrder -->|get_admin_order_detail · get_quotes_for_order<br/>pricing_config| sClient
  aOrder --> act & box & quote & site
  aDxf -->|is_staff · get_admin_order_detail| sClient
  aDxf --> store
  aCust & aOrg & aHist & aAcc --> req
  aCust --> act
  aEmp --> act
  aAcc -.->|CalibrationAccuracy realtime drawer| bClient
  act --> sClient
  act -->|invite · createUser · listUsers · updateUserById| aClient
  box & quote & site --> sClient
  site --> dist
  quote --> pricing
  quote -->|drawer · box · pricing_config reads| sClient
  sClient & bClient --> pg
  sClient --> authS
  aClient --> authS
  authL --> sClient
  req --> sClient
```

Notes
- Every mutation goes through an RPC that re-checks `is_admin()` / `is_staff()` in SQL; the
  page-level guards (`requireAdminPage`, layout redirect) are UX, not the security boundary.
- Four server actions (`invitePortalUser`, `createPortalLoginWithPassword`,
  `setEmployeePassword`, `addEmployee`) check the role locally *before* touching the
  service-role client. All others rely on the RPC guard — which is fine except where an
  action does paid work first (`lookupOrderDistanceAction`, review P-3).
- Component tree (edges that matter): `OrderContents → {BoxCard, DrawerBoxControls,
  DrawerQuickView → ScanViewer(three.js, lazy)}`, `QuotesSection → CustomerBreakdown`,
  `CustomersList → PortalAccess`, `OrderStateControls/EditOrderModal → Modal + ConfirmButton`,
  `OrdersTable → DesignProgress`, `page.tsx → OrderTracker`, `labels/[id] → LabelEditor`.

---

## 3. Data model (public schema, final state after `20260910175529`)

```mermaid
erDiagram
  organization ||--o{ customer : "organization_id"
  organization ||--o{ order : "organization_id"
  customer ||--o{ order : "customer_id"
  order ||--o{ drawer : "order_id (no index)"
  order ||--o{ box : "order_id (cascade)"
  box ||--o{ drawer : "box_id (set null)"
  order ||--o{ quote : "order_id (cascade)"
  quote ||--o{ quote_line_item : "quote_id (cascade)"
  drawer ||--o{ quote_line_item : "drawer_id (set null)"
  pricing_config ||--o{ quote : "config_id"
  drawer ||--o{ drawer_event : "drawer_id (no cascade; purge-guarded)"
  drawer ||--o{ drawer_label : "drawer_id (cascade)"
  drawer ||--o| drawer_progress : "drawer_id (cascade)"
  order ||--o{ status_event : "order_id (cascade)"
  drawer ||--o{ status_event : "drawer_id (cascade)"
  status_def ||--o{ status_transition : "domain, code"
  auth_users ||--o| customer : "auth_user_id (partial unique)"
  auth_users ||--o{ user_roles : "user_id"
  auth_users ||--o{ drawer : "created_by / claimed_by"

  order {
    uuid id PK
    text customer_name_email_phone
    text drawer_ids "load-bearing for tidyCAM"
    int total_price "cents"
    text computed_status "derived, stored"
    text manual_status "override"
    text state "active|on_hold|cancelled"
    text site_address
    numeric round_trip_miles
  }
  drawer {
    uuid id PK "client-generated by tidyCAM"
    json dimensions "width/height + calibration_matrix, correction, reference_corners…"
    drawer_status status "legacy enum, bridged"
    text stage "backlog→…→delivered"
    text state "active|on_hold|rework|cancelled"
    text customer_approval_status
    text design_preview_url
    text dxf_url
    int dxf_revision
    text tier
    int quantity
    text qr_url "generated: /q/?d=id"
  }
  customer {
    uuid id PK
    text email "unique lower()"
    uuid auth_user_id
  }
  user_roles {
    uuid user_id PK
    text role PK "admin|staff|user"
  }
  status_event {
    text domain "order|drawer"
    text field "stage|state|override|schedule"
    text kind "advance|return|correction|recompute|bridge|backfill|system"
    text from_status
    text to_status
    text source "tidycam|tidycad|portal|system|bridge|backfill"
    text idempotency_key "partial unique"
  }
  quote {
    int quote_number "sequence, unique"
    text status "draft|sent|accepted|declined|expired|void"
    int total_cents
    jsonb cost_breakdown "internal"
  }
  drawer_label {
    text pocket_key "unique per drawer"
    text label_text
    bool na
  }
```

Not shown (dead or vestigial): `employee` (1 row, readable by every signed-in user, referenced
by nothing), `drawer_backup_2026_05_02` (96 rows), `_archive_customer_2026_07_03` (20 rows),
view `order_capture_quality`, columns `drawer.capture_quality*` (written by
`set_capture_quality`, read by nothing in this repo).

---

## 4. Status backbone — the drawer state machine

```mermaid
stateDiagram-v2
  direction LR
  [*] --> scanned : tidyCAM insert (bridge)
  backlog --> scanned
  scanned --> backlog : return
  scanned --> design_queue
  design_queue --> designed : tidyCAD DXF upload (bridge)
  designed --> design_queue : return
  designed --> qc_passed
  designed --> awaiting_approval : preview published (bridge)
  qc_passed --> designed : return
  qc_passed --> awaiting_approval
  qc_passed --> approved : offline approval
  awaiting_approval --> approved : customer approves / submits labels (bridge)
  awaiting_approval --> designed : return
  awaiting_approval --> design_queue : return
  approved --> awaiting_approval : return (never fired automatically)
  approved --> in_production
  in_production --> cut
  in_production --> ready
  cut --> ready
  ready --> delivered
  delivered --> [*]

  note right of awaiting_approval
    state axis is independent:
    active | on_hold | rework | cancelled
    (changes_requested sets rework)
  end note
```

Order `computed_status` is **derived and stored** by `recompute_order_status()` from the
non-cancelled drawers, evented as `kind='recompute'`:

| rule | condition on active drawers | order status |
|---|---|---|
| R0 | none | received |
| R1 | all delivered | delivered |
| R2 | min stage ≥ ready | ready |
| R3 | any ≥ in_production | production |
| R4 | min ≥ approved | approved |
| R5 | any awaiting_approval | awaiting_approval |
| R6 | max ≥ design_queue | design |
| R7 | max ≥ scanned | scanning |
| R8 | otherwise | received |

Effective order status shown to customers = `coalesce(manual_status, computed_status)`;
`order.state` (hold/cancel) is a separate axis. Recompute fires on drawer INSERT/UPDATE of
`stage/state/order_id` — **not on DELETE** (review D-3).

Writers of `drawer.stage`: `set_drawer_stage` RPC (legal transitions from
`status_transition`, admin corrections), the bridge trigger (legacy `status` enum from
tidyCAM/tidyCAD, `customer_approval_status`, new `design_preview_url`), `mark_drawer_delivered`
(correction), and — because `drawer_update_staff` is a full-row policy — any direct UPDATE by a
staff session, which records no event (review D-4).

---

## 5. Approval + notification flow (as it runs today)

```mermaid
sequenceDiagram
  autonumber
  participant CAD as tidyCAD / publish_for_approval.py
  participant PG as Postgres
  participant FN as Edge fn notify
  participant RS as Resend
  participant C as Customer
  participant DOCS as docs/approve (anon)
  participant PORTAL as portal /labels/[id]
  participant DC as Discord

  CAD->>PG: log_design_revision(drawer, preview, dxf) [service role]
  PG->>PG: customer_approval_status='pending', revision+1, drawer_event design_uploaded/revised
  PG->>PG: bridge: stage → awaiting_approval (if < approved)
  PG-->>FN: pg_net POST {type: design_ready} (x-notify-secret from Vault)
  FN->>RS: email "Review & approve" → link www.thetidytool.com/approve/?id=…
  RS-->>C: design-ready email
  alt Customer follows the email link
    C->>DOCS: /approve/?id=drawer
    DOCS->>PG: get_drawer_approval · get_public_drawer_changelog
    C->>DOCS: Approve / Request changes
    DOCS->>PG: submit_drawer_approval (rate-limited 10/h/drawer, input caps)
  else Customer logs in and enters tool labels
    C->>PORTAL: /labels/[id]
    PORTAL->>PG: save_drawer_labels (autosave) … submit_drawer_labels
    PG->>PG: auto-approve: customer_approval_status='approved', labels_submitted event
  end
  PG->>PG: bridge: stage → approved (or state → rework on changes_requested)
  PG->>PG: recompute_order_status(order)
  PG-->>DC: _notify_discord_approval (Vault webhook)
  PG-->>FN: pg_net POST {type: approved | labels_submitted}
  FN->>RS: owner + customer confirmation emails
```

The two branches are both live and give the customer different instructions (email says
"review & approve", the portal says "submitting labels is your go-ahead"). They converge on
the same columns, so data stays consistent; the product story does not (review M-1).

---

## 6. Environments and the migration path

```mermaid
flowchart LR
  classDef env fill:#ffffff,stroke:#1e2a33,color:#1e2a33
  classDef tool fill:#eff2f5,stroke:#5b6870,color:#1e2a33

  repo[(portal/supabase/migrations/<br/>54 files · 1:1 with prod history by version+name)]:::tool
  apply["tools/db_apply.py<br/>--check · --env dev or prod · --approved<br/>byte-faithful history rows + PostgREST reload"]:::tool
  mcp[Supabase MCP apply_migration<br/>fallback; normalizes stored statements]:::tool

  subgraph prod[Supabase prod · tkrrvpoupekrjqditupi]
    ppg[(Postgres)]:::env
  end
  subgraph dev[Supabase persistent branch dev · gfkrebuioszsxanjdnsx]
    dpg[(Postgres, seeded test orders)]:::env
  end
  subgraph disp[Disposable branches]
    bpg[(clone-with-data only — schema-only replay breaks at 20260706000000)]:::env
  end

  vprod[Vercel Production<br/>app.thetidytool.com]:::env
  vprev[Vercel Preview deploys]:::env
  ghp[GitHub Pages · thetidytool.com<br/>docs/ pages carry both prod + dev keys; localStorage tt_dev opt-in]:::env

  repo --> apply --> ppg
  repo --> apply --> dpg
  repo -.-> mcp -.-> ppg
  vprod --> ppg
  vprev --> dpg
  ghp --> ppg
  ghp -.-> dpg
  repo -.->|create branch| bpg
```

Contract surfaces that other repos depend on (do not change without cross-repo coordination):
`drawer.qr_url` expression and `docs/q/`, the `/approve/?id=` URL + the four public RPC
signatures, `drawer.id` as capability token, `drawer_status` enum values, `status_def` codes,
`status_event.source` values, `record_dxf_upload` / `record_scan_correction` /
`revert_scan_correction` / `set_drawer_stage` / claims + progress RPCs / `set_capture_quality`
/ `set_order_customer_email` / box RPC signatures, `order.total_price` in cents,
`order.drawer_ids` text, and the `notify` payload `{type, …}` + `x-notify-secret`.
