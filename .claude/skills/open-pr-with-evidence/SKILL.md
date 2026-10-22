---
name: open-pr-with-evidence
description: Push an agent/* branch and open the PR with the standard evidence body — Done-when checklist, verification.md, reviewer verdict, hardware sign-off flag, changelog line. Use only after the reviewer returned APPROVE. Never targets main directly.
disable-model-invocation: true
---

# open-pr-with-evidence

Precondition: `review.md` on the branch says `VERDICT: APPROVE`, `verification.md` exists, tree is
clean, branch name starts with `agent/`. If any is false, stop and say which.

## Steps
1. `git push -u origin <branch>` (the hook blocks anything that targets `main`).
2. Build the body from the three files on the branch and the card. Title: `<App>: <card title>` (≤ 70 chars).
3. `gh pr create --base main --head <branch> --label agent --title "<title>" --body-file <tmpfile>`.
   If the `agent` label doesn't exist, create it once: `gh label create agent --color 5319E7`.
4. Return the PR URL.

## Body template (fill every section; keep it scannable — Sam skims)
```
Todoist: <card url>

## Done when
- [x] <criterion> — <how proven, one line>
- [ ] <criterion> — carved out: needs device test (see Todoist task <url>)

## Verification
<verification.md, verbatim>

## Review
<review.md, verbatim>

## Risk
High-risk paths touched: <none | list>
Hardware sign-off needed: <no | yes — exact steps>
Migration: <none | applied to dev (<file>, md5 <…>); prod apply = Sam: `python3 tools/db_apply.py <file> --env prod --approved`>

## Changelog (customer-visible)
<one line, or "internal only">

🤖 Generated with [Claude Code](https://claude.com/claude-code)
```
Add the session link trailer if the environment provides one.
