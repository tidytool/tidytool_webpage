# FEATURE — Landing Page Conversion Redesign

**Status:** Proposed — awaiting Sam's sign-off on headline + form changes (high-risk items)
**Surface:** `docs/index.html` (+ new `docs/privacy.html`)
**Goal:** Raise qualified quote-request conversions. Razor for every change: *if it doesn't increase qualified opt-ins, cut it.*

## Brief

The current page leads with the product ("Shadow boards for your exact tools...") and buries
social proof in section 7 of 8. New flow: **customer pain → how we solve it → proof → act.**
Primary CTA language changes from "Get a Fast Quote" (sounds cheap, over-promises speed) to
**"Get Started"** — the real conversion is scheduling a design consultation call, not an
instant price.

## New section order

| # | Section | Change |
|---|---------|--------|
| 1 | Hero | Rewrite: pain-led headline, promise subheadline, proof photo, single primary CTA |
| 2 | Proof band | **Moved up from §7.** Waddoups quote + install photos + case-study link |
| 3 | How it works | Keep 3 steps, tighten copy |
| 4 | Why it works | **Merge** "Real Costs" + "Built for Lean" + "Why TidyTool" + "Materials" into one condensed section |
| 5 | Who it's for | Keep (it's the "pick a lane" segment router) — trim to 4 tight cards |
| 6 | Get Started (form) | Keep checklist + promise line; reframe copy around scheduling the consult call |

**Cuts:** stat strip (features styled as stats, adds no proof), the CNC/XLPE repetition
(currently explained 3× each), mid-page CTA band (replaced by proof band CTA).

## 1. Hero

Pain-led headline. Options for Sam to pick (or edit):

- **A.** "How much time does your team lose hunting for tools?" / sub: "TidyTool shadow boards make every missing tool visible at a glance — custom foam, cut for your exact tools."
- **B.** "A missing tool stops the whole job." / sub: "Custom-cut foam shadow boards make what's missing obvious in seconds — so your team spends time working, not searching."
- **C.** "Stop losing tools. Stop losing time." / sub: "Laser-cut foam organizers built for your exact tools — see what's missing at a glance, every shift."

Hero image: `images/installs/shadow-board-drawer-tools-seated.jpeg` (already the OG image —
it visually proves the promise). Compress/resize for fast load; keep LCP under control.

CTAs: primary **"Get Started →"** (anchor `#quote`). Keep "See How It Works" as ghost
secondary or drop it — recommend keeping, it serves not-ready-yet visitors.

## 2. Proof band (new position, directly under hero)

- Waddoups pull quote ("...10 times better... students are putting them back intuitively and
  naturally — I haven't told them to do it") with name + Bridgerland Technical College.
- The 3 install photos as a compact gallery row.
- Case-study card/link stays with this block.
- **Content gap:** one named customer is thin for prime position. Action item (offline):
  collect 1–2 more quotes from existing installs. The band ships with what we have.

## 3–5. Middle sections

- "How it works": keep as-is, minor copy tightening. Rename step-1 copy so "onsite scan"
  reads as zero-effort for the customer.
- "Why it works" (merged section): 3–4 cards max — pain framing from "Real Costs" (downtime,
  audit gaps, walked-off tools, eroded care) paired with the mechanism (two-tone contrast,
  poka-yoke fit, XLPE durability, digital tracking). One mention of XLPE, one of CNC. Keep
  the $13B FOD stat + sources — it's real proof for the aviation segment.
- "Who it's for": keep all 4 cards, this is the HubSpot "pick a lane" step. Move it **after**
  the merged why-section so pain → proof → mechanism → segment fit → act.

## 6. Get Started section + form

Section copy reframes around the call: heading like **"Get started — schedule your free
design consultation."** Keep the 4-item objection checklist and the ✓ promise line.

Form (Tally — currently 5 required fields: name, email, phone, project description,
"How did you hear about us?"):

- 5 fields is at the advice's limit and all-required adds friction.
- Recommend: make **"How did you hear about us?" optional** (or drop it) — it qualifies
  nothing and is the likeliest abandonment point. Name/email/phone/project stay required;
  phone is essential since the goal is a call.
- ⚠️ **High-risk (conversion path): Sam edits the Tally form himself or explicitly approves.**

## Global CTA rename

"Get a Fast Quote" / "Get a fast quote" / nav "New Customer" → **"Get Started"** everywhere
on the page. Footer "Get a Quote" link → "Get Started". Page `<title>`/meta keep "free quote"
for SEO intent — only visible CTA labels change.

## Legal

Add `docs/privacy.html` (plain-language privacy policy: what the form collects, that Tally
processes it, contact email) and link it from the footer. Low-risk, additive.

## Definition of done

- [ ] Renders on mobile + desktop; hero image compressed, no CLS
- [ ] All anchors resolve; form reachable and submits
- [ ] No console errors; brand tokens only
- [ ] Sam approved: headline choice, CTA rename, any form edits
- [ ] ROADMAP.md updated

## Risk levels

- **Needs Sam's sign-off:** headline (pick A/B/C), form field changes, CTA rename (it's the conversion path).
- **Ships without gate:** proof-band move, section merge/cuts, privacy page, image compression.
