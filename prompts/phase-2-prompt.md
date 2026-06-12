# Implementation Prompt — Phase 2: Local Visibility, Brand-Hedged

## Role
You are a senior technical SEO specialist and front-end developer working on TidyTool's static site (thetidytool.com). Phase 1 (lean-manufacturer repositioning, proof section, case study page) is complete — verify this before starting; if Phase 1 elements are missing, stop and report.

## Business context
TidyTool: custom AI-designed, CNC-cut two-tone foam tool organizers, made in Logan, Utah. Primary buyer: CI engineers / 5S specialists at Northern Utah manufacturers. Secondary: technical college program directors. Service area: Cache Valley, Box Elder County, Northern Utah.

**CRITICAL CONSTRAINT — brand hedge:** A possible company rename is under consideration. Build ONLY portable assets in this phase. Explicitly FORBIDDEN: directory citation submissions, link-building outreach, press releases, paid brand assets, anything that compounds equity under the "TidyTool" name beyond the site itself. If a task seems to violate this, stop and flag it.

## Tasks

### Task 1 — LocalBusiness structured data
Add JSON-LD to the homepage `<head>`:
```json
{
  "@context": "https://schema.org",
  "@type": "LocalBusiness",
  "name": "TidyTool",
  "description": "Custom AI-designed, CNC-cut foam tool organizers and shadow boards for lean manufacturing, technical schools, and aviation.",
  "url": "https://thetidytool.com",
  "email": "TODO-EMAIL",
  "telephone": "TODO-PHONE",
  "address": { "@type": "PostalAddress", "addressLocality": "Logan", "addressRegion": "UT", "addressCountry": "US" },
  "areaServed": ["Cache Valley UT", "Box Elder County UT", "Northern Utah"],
  "slogan": "Built Tough. Built Custom."
}
```
Fill TODOs from repo/footer if present; otherwise leave marked and report. Validate with Google's Rich Results Test (or `npx structured-data-testing-tool`).

### Task 2 — Segment landing pages (brand-neutral content, portable)
Create two pages reusing the site's header/footer/design system. Each: unique title/meta, one H1, 500–800 words, quote-form CTA (link to homepage `#quote` or embed the same Tally form), breadcrumb link home.

**`/lean-manufacturing.html`** — Target query cluster: "5S foam tool organizers", "shadow board foam", "custom tool control foam", "kaizen foam inserts custom cut".
- H1 direction: "Custom Shadow-Board Foam for 5S Programs"
- Content blocks: (1) the problem — Sustain is the hardest S; tool control decays without visual enforcement; (2) how two-tone CNC-cut foam makes empty pockets self-announcing (visual management / poka-yoke); (3) process recap — photos/list → AI layout → CNC cut → drop-in install, no measuring by the client; (4) materials — XLPE closed-cell: waterproof, chemical-resistant, non-compressing; (5) tiers overview (Professional / Standard / Minimum — describe feature differences: carbon-fiber acrylic top layer, engraving, contrast base; do NOT publish prices); (6) Utah service note — on-site scan/design visits across Cache Valley and Northern Utah; (7) CTA.

**`/technical-schools.html`** — Target cluster: "tool accountability trade school", "OSHA tool control vocational", "tool inventory system trade program".
- H1 direction: "Tool Accountability for Trade Programs and Technical Colleges"
- Content blocks: (1) the problem — shared kits, student turnover, lost tools, OSHA accountability requirements; (2) shadow foam = instant end-of-class kit checks; (3) habit-building argument — students carry visual tool control into industry (lean employers expect it); (4) process + durability for daily student abuse (XLPE); (5) Utah service note; (6) CTA. Reference the case study page if it has owner-supplied content; otherwise link generically.

Writing rules: same voice as Phase 1 (plain, specific, no hype; banned: "game-changer", "revolutionize", "unlock", scarcity framing). Use lean vocabulary naturally — these pages must read as written by someone fluent in 5S, not an SEO.

### Task 3 — Site plumbing for multi-page
1. Create `sitemap.xml` listing homepage, both segment pages, case study page. Create/verify `robots.txt` referencing it.
2. Add canonical tags to all pages.
3. Add nav links to the new pages (desktop + mobile menu) without crowding — a "Solutions" or "Industries" grouping is acceptable if the nav pattern supports it; otherwise footer links suffice.
4. Add internal links: homepage segment cards ("Lean Manufacturing" → `/lean-manufacturing.html`, "Mechanic Schools" → `/technical-schools.html`).

### Task 4 — Homepage local-intent tuning
- Verify title/meta from Phase 1; ensure "Logan, Utah" and "custom foam tool organizers" both appear in the title.
- Ensure the service-area sentence ("serving Cache Valley, Box Elder County, and Northern Utah") exists in indexable body text, not just the footer.

### Task 5 — Google Business Profile checklist (deliverable document, not code)
Create `gbp-setup-checklist.md` for the owner (this is a human task — do not attempt to create the profile):
- Register under the **legal business entity name** (hedge-compliant), category "Manufacturer" (secondary: "Industrial Equipment Supplier"), service-area business (Logan + Cache Valley + Box Elder, no storefront address shown), hours, phone, website link, 5–10 install photos, services list (custom foam inserts, shadow boards, 5S tool control, on-site design consultation), and a first post. Include step-by-step instructions and the verification process.

## Constraints
- Static site, no build tooling, existing design system only.
- No fabricated facts, customer names, or metrics anywhere.
- No keyword stuffing: each target phrase appears where natural; reading quality wins ties.
- Brand-hedge rules above are hard constraints.

## Acceptance criteria
- [ ] JSON-LD validates with zero errors (TODO fields documented if unfillable).
- [ ] Both segment pages live, styled natively, 500–800 words, unique titles/metas, single H1 each.
- [ ] sitemap.xml + robots.txt + canonicals correct; all internal links resolve both directions.
- [ ] Homepage segment cards link to the new pages.
- [ ] GBP checklist document complete.
- [ ] grep confirms zero banned phrases and zero placeholder text in rendered output (except documented owner TODOs).

## Test procedure
1. Serve locally; check both new pages at 375px/768px/1440px.
2. `npx html-validate *.html` — no errors.
3. Validate structured data and sitemap XML syntax.
4. Crawl check: every `<a href>` on every page resolves (use `npx linkinator http://localhost:8000 --recurse` or equivalent).
5. Lighthouse SEO score ≥ 95 on all three pages; record scores.

## Output
Report: files created/changed, Lighthouse scores per page, validation results, owner TODO list (email/phone for schema, GBP execution).
