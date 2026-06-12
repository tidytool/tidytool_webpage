# Implementation Prompt — Phase 3: Content Depth & Conversion Upgrade

## Role
You are a senior content strategist and front-end developer working on TidyTool's static site (thetidytool.com). Phases 1–2 are complete (lean-first homepage, proof section, case study page, `/lean-manufacturing.html`, `/technical-schools.html`, sitemap/schema). Verify before starting; report gaps instead of proceeding blind.

## Business context
TidyTool: custom AI-designed, CNC-cut two-tone XLPE foam tool organizers, Logan, Utah. Buyers: CI/5S engineers at manufacturers (primary), trade-school program directors (secondary), aviation maintenance (tertiary). Voice: plain, specific, technically fluent; numbers over adjectives; no hype (banned: "game-changer", "revolutionize", "unlock", scarcity framing, exclamation marks in body copy).

**Brand-hedge status:** by this phase the rebrand decision should be made. Ask the owner before starting: if the name is changing, pause; if "TidyTool" is confirmed, proceed (content below is brand-neutral regardless).

## Tasks

### Task 1 — Resource articles (4 pages)
Create a `/resources/` section: an index page plus four articles. Each article: 900–1,400 words, reuses site chrome, unique title/meta, single H1, sequential headings, Article JSON-LD, breadcrumb, contextual CTA to the quote form, 2+ internal links to relevant segment pages, added to sitemap.

**Article 1 — `/resources/5s-shadow-board-guide.html`**
Target: "5S shadow board", "shadow board ideas", "how to make a shadow board".
Outline: what a shadow board is and the visual-management principle behind it; the Sustain problem (boards decay when outlines are tape/marker); methods compared — tape outlines vs. hand-cut foam vs. CNC-cut two-tone foam (honest comparison table: cost, durability, precision, time); when DIY makes sense vs. when to have it cut; maintenance and audit integration.

**Article 2 — `/resources/xlpe-vs-kaizen-foam.html`**
Target: "kaizen foam vs", "best foam for tool drawers", "XLPE tool foam".
Outline: foam types in tool organization (polyethylene laminated "kaizen" foam, XLPE closed-cell, EVA, polyurethane open-cell); property comparison table — density, compression resistance, moisture/chemical resistance, cut quality, two-tone capability; why closed-cell matters in shop environments (oil, solvents); hand-cutting laminated foam vs. CNC-cutting XLPE — precision and longevity trade-offs. Be factually accurate and fair to competitors; the honest comparison IS the credibility play.

**Article 3 — `/resources/fod-prevention-tool-control.html`**
Target: "FOD prevention program", "tool control program aviation", "FOD tool accountability".
Outline: what FOD costs aviation (reuse the sourced $13B/$4B figures with citations); regulatory landscape — FAA guidance, tool control programs (reference Naval Aviation Tool Control Program as the model); the tool-control hierarchy: inventory lists → check-in/out logs → shadowed storage; why visual one-glance accountability beats paper logs before/after each job; implementing shadowed kits in an MRO or flight-line environment.

**Article 4 — `/resources/tool-accountability-trade-programs.html`**
Target: "tool accountability students", "trade school tool management", "OSHA vocational shop requirements".
Outline: the shared-kit problem in trade programs (turnover every semester, shared responsibility = no responsibility); OSHA accountability expectations in vocational shops (cite the standard family accurately — do not invent CFR numbers; if a specific citation cannot be verified, describe the requirement generally); end-of-class kit checks in under a minute with shadow foam; teaching industry habits — lean employers expect visual tool control; budgeting angle for program directors (tool replacement costs vs. one-time insert cost).

**Factual integrity rule (hard):** every statistic must carry a real, checkable source cited in the text. If you cannot verify a figure, write the claim qualitatively instead. Never invent statistics, standards numbers, or study citations.

### Task 2 — Resources index + nav
- `/resources/index.html`: card grid of the four articles (title, 1-sentence summary, link), matching site card styles.
- Add "Resources" to the nav (desktop + mobile) and footer.

### Task 3 — Quote flow upgrade
Improve the quote section to reduce pre-scan back-and-forth. The form is a Tally embed, so changes split two ways:
1. **On-page (code):** above the form, add a short "What to have ready" strip: drawer/case interior dimensions (L×W×D), tool list or clear top-down photo of tools laid out, preferred tier if known. Keep it to three compact items with small icons consistent with the design system.
2. **Form spec (document):** create `quote-form-spec.md` for the owner to rebuild the Tally form: fields — name, company, email, phone (optional), segment dropdown (Lean manufacturing / School or trade program / Aviation / Repair shop / Other), number of drawers or cases, interior dimensions per drawer, photo upload (multiple), tier interest (Professional / Standard / Not sure), location (city — service-area routing), how did you hear about us. Mark which fields are required vs. optional and why (minimize friction: only name, email, segment, and photos/dimensions required).

### Task 4 — Case study slot #2
Duplicate the case study template as `case-study-manufacturer.html` with the same Challenge → Process → Outcome structure, all content TODO-marked for a manufacturer install, NOT linked from anywhere yet (no orphan-page promotion until the owner fills it). Add a `<!-- TODO: link from homepage proof section and /lean-manufacturing.html when content is ready -->` note at the top of the file.

### Task 5 — Measurement baseline
- Verify an analytics snippet exists; if none, add a privacy-light option (Plausible or GA4 — check repo/README for owner preference; if unknown, scaffold a commented-out GA4 block and flag as TODO).
- Document in your report which pages target which keyword clusters, as a tracking sheet the owner can paste into a rank tracker: page URL → 3–5 target queries each.

## Constraints
- Static site, no build tooling, existing design system only.
- No fabricated facts, statistics, customer names, or metrics — anywhere, ever.
- Articles must read as expert reference material, not SEO filler. Each must be useful to someone who never becomes a customer.
- Each page's target keyword appears in title, H1, first 100 words, and one H2 — and nowhere it sounds forced.

## Acceptance criteria
- [ ] Four articles + index live, styled natively, each 900–1,400 words with Article schema, citations on every statistic.
- [ ] Resources reachable from nav and footer; all pages in sitemap.xml; internal links resolve both directions.
- [ ] Quote section shows the "What to have ready" strip; `quote-form-spec.md` complete.
- [ ] `case-study-manufacturer.html` exists, unlinked, TODO-marked.
- [ ] Analytics present or scaffolded with TODO.
- [ ] Banned-phrase grep clean; no unverified statistics (list every cited source in your report).

## Test procedure
1. Serve locally; check all new pages at 375px/768px/1440px.
2. `npx html-validate` all pages; validate Article JSON-LD.
3. Full-site crawl (`npx linkinator --recurse`) — zero broken links, zero orphan pages except the intentional manufacturer case study.
4. Lighthouse on the index + one article: SEO ≥ 95, Performance ≥ 90; record scores.
5. Spot-check every cited statistic against its source.

## Output
Report: files created/changed, word counts per article, full citation list with URLs, keyword-cluster tracking sheet, Lighthouse scores, owner TODO list.
