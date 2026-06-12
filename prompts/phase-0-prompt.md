# Implementation Prompt — Phase 0: Critical Fixes

## Role
You are a senior front-end developer working on a static marketing website for TidyTool (thetidytool.com), a Logan, Utah business selling custom AI-designed, CNC/laser-cut two-tone foam tool organizers for lean manufacturing environments, technical schools, and aviation shops.

## Context
The site is a single-page static site (HTML/CSS/JS). Current visual identity: charcoal + high-visibility amber, Archivo and IBM Plex typefaces, tagline "Built Tough. Built Custom." Sections in order: hero, "Real Cost of Disorganization" stats, "How it works" process, "Why TidyTool" features, Materials, "Who It's For" segments, quote form, footer.

**The site's only CTA is broken**: the quote section displays a literal placeholder reading "Tally form goes here." This phase fixes that and the contact basics. Nothing else.

## Tasks

### Task 1 — Embed the Tally quote form
1. Locate the quote section (anchor `#quote`) in the HTML. Find the placeholder block containing the text "Tally form goes here" and the note referencing README.md.
2. Replace the placeholder with the Tally embed snippet. If a snippet exists in README.md or a config/env file, use it. If none exists anywhere in the repo, insert this standard Tally iframe embed pattern with a clearly marked TODO form ID and stop to report it:
   ```html
   <iframe data-tally-src="https://tally.so/embed/FORM_ID?alignLeft=1&hideTitle=1&transparentBackground=1&dynamicHeight=1"
     loading="lazy" width="100%" height="500" frameborder="0" marginheight="0" marginwidth="0"
     title="TidyTool Free Quote Request"></iframe>
   <script src="https://tally.so/widgets/embed.js" async></script>
   ```
3. Remove the dead `<a href="#">Request a Quote</a>` button in that section, or point it to the form anchor if it serves a mobile-scroll purpose.
4. The embed must not break the section's existing styling. Match container width to the surrounding content column.

### Task 2 — Contact and footer basics
1. Add to the footer: business location line "Logan, Utah" and a contact email link. Use `TODO-EMAIL@thetidytool.com` as a marked placeholder if no business email is found in the repo — flag it in your final report.
2. Verify every nav anchor (`#why`, `#how`, `#materials`, `#segments`, `#quote`, `#top`) scrolls to an existing element. Fix any broken anchors.
3. Verify the copyright year renders correctly (it currently shows 2026 — keep it dynamic via JS if the site already does this, otherwise static is fine).

## Constraints
- Do NOT redesign anything. No new sections, no copy changes outside the quote/footer areas.
- Do not add frameworks, build steps, or dependencies. Keep the site static.
- Preserve existing class names and CSS architecture.

## Acceptance criteria
- [ ] No placeholder text ("Tally form goes here", "Paste your Tally embed", lorem ipsum) remains anywhere in rendered output. Verify with: `grep -ri "placeholder\|tally form goes\|lorem" *.html`
- [ ] Quote form renders and is interactive (or, if FORM_ID is unknown, the TODO is clearly reported and the layout renders cleanly).
- [ ] All nav anchors resolve. No `href="#"` dead links remain.
- [ ] Footer contains location and contact email.

## Test procedure
1. Serve locally (`python3 -m http.server`) and load the page.
2. Check the quote section renders at 375px, 768px, and 1440px widths (no horizontal overflow, iframe resizes).
3. Click every nav link and CTA button; confirm each scrolls to the correct section.
4. Validate HTML: no new errors introduced (use `npx html-validate` or W3C validator).

## Output
Report: files changed, any TODOs left for the owner (Tally form ID, business email), and test results.
