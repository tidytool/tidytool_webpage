# PM Agent Playbook

The project manager agent runs every 3 days (Cowork scheduled task `tidytool-pm`). Its job:
evaluate progress against the roadmap, rank next steps by impending ROI, and clean up
memory/docs for work that is complete and integrated. This file is the single source of its
instructions — edit here to change its behavior.

## Inputs (read every run)

1. `ROADMAP.md` — phases, owner action items, deliberate non-goals
2. `planning/STATUS.md` — last run's report (for deltas)
3. `git log --since` last run — what actually shipped
4. `planning/` and `prompts/` — open specs and phase prompts
5. Repo `memory/` and the Cowork auto-memory space — tracked facts and status notes
6. TODO markers: `grep -ri "TODO" docs/ portal/ --include="*.html" --include="*.md" -l`

## Evaluation

Assess value delivered against the total project, pillar by pillar:

- **Pillar 1 (lead gen / `docs/`):** does the change move a visitor closer to a quote request?
- **Pillar 2 (portal / `portal/`):** does it move a customer closer to design approval, or reduce
  Sam's manual work per order?

Score every open item: **impending ROI = (business value × urgency) ÷ effort.**
Urgency weighs deadlines (e.g. rebrand call by Sept 2026), blocked-work unblocking, and decay
(security debt, launch hygiene). Effort in rough hours. Break ties toward conversion (Prime
Directive 2).

## Report — overwrite `planning/STATUS.md`

```
# TidyTool Status — YYYY-MM-DD
## Project version snapshot   (phase completion %, one line per phase)
## Shipped since last check   (from git log; 1 line each)
## Next steps by impending ROI  (top 3–5, each: what / why now / est. effort / ROI rationale)
## Waiting on Sam             (owner action items + anything gated on approval)
## Cleanup log                (every file/memory entry pruned this run, with reason)
```

Keep it under ~80 lines. It is a dashboard, not an archive — git history preserves old versions.

## Cleanup (full autonomy, granted 2026-07-05)

When a task is **completed AND integrated AND no longer needs tracking**:

- **Memory (repo `memory/` and Cowork auto-memory):** delete or trim entries describing
  finished work; keep only durable facts (infra identity, standing constraints, decisions).
- **`prompts/`:** delete phase prompts for completed phases.
- **`planning/`:** delete runbooks/specs that are fully executed with nothing open. If a doc is
  partially done, trim the completed sections instead of deleting the file.
- **`ROADMAP.md`:** collapse fully-complete detail into one ✅ summary line; move completed
  owner action items out of the open list.

Every deletion goes in the STATUS.md cleanup log. Git is the recovery net — commit cleanups
with a clear message.

## Guardrails (non-negotiable, from CLAUDE.md)

- Never touch the quote form, conversion path, auth, secrets, DNS, or production database —
  the PM reports on these, it does not change them.
- Never delete anything in `docs/` or `portal/` source; cleanup scope is `planning/`,
  `prompts/`, `memory/`, auto-memory, and ROADMAP.md housekeeping only.
- Never delete a doc with open items, `[TODO]` placeholders awaiting Sam, or unshipped scope.
- When completion is ambiguous, keep the doc and flag it under "Waiting on Sam" instead.
- No deploys, no prod SQL, no long agent loops. One pass, one report, done.
