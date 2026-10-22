# Stage 1 install — tidytool_webpage agent team

Everything here is repo-relative. Copy the tree onto a branch in `tidytool_webpage` and open a PR
(Sam reviews it like any other). Nothing in this set runs on its own until you invoke it.

```
tidytool_webpage/
├── CLAUDE.md                      # REPLACES the current one (109 → ~110 lines, audited)
├── .worktreeinclude               # copies portal/.env.local into agent worktrees
└── .claude/
    ├── settings.json              # hooks: Bash guard, Stop + SubagentStop test gate
    ├── team.json                  # the one file the agents read for repo facts and limits
    ├── hooks/guard_bash.py        # deny push-to-main / force-push / prod db_apply / db pull / rm migrations
    ├── hooks/stop_gate.sh         # typecheck + tests must be green before a session may finish
    ├── agents/implementer.md      # opus, worktree-isolated, 80 turns
    ├── agents/reviewer.md         # opus, read-only, APPROVE/REVISE/ESCALATE + fix guide
    ├── agents/verifier.md         # sonnet, proves one criterion, writes evidence
    ├── agents/systems-engineer-lens.md   # opus, contract/consumer check
    ├── agents/dispatcher.md       # sonnet, the Todoist loop (Stage 2 runs it on a schedule)
    └── skills/
        ├── feature/SKILL.md               # /feature — Program Manager intake → Todoist cards
        └── open-pr-with-evidence/SKILL.md # push + PR body template
```

## Steps (≈ 20 minutes)

1. **Branch + copy.** `git checkout -b chore/agent-team-stage1`, copy the tree in, `chmod +x .claude/hooks/*`.
   Diff `CLAUDE.md` against the old one before committing — it drops the "How to propose work"
   section (replaced by the agent flow) and the stale "Phase 4 is next" paragraph.
2. **Smoke the hooks** (no Claude needed):
   ```
   printf '%s' '{"tool_name":"Bash","tool_input":{"command":"git push origin main"},"cwd":"'$PWD'"}' | python3 .claude/hooks/guard_bash.py ; echo "exit $?"   # expect exit 2
   echo '{"stop_hook_active":false}' | CLAUDE_PROJECT_DIR=$PWD bash .claude/hooks/stop_gate.sh ; echo "exit $?"              # expect exit 0 on a clean tree
   ```
3. **Open Claude Code in the repo** and run `/hooks` to confirm the three hooks loaded, `/agents` to
   see the five definitions. Try `@agent-reviewer review the diff of <any recent branch> against
   "Done when: typecheck passes"` — you should get the verdict shape, not prose.
4. **Todoist:** labels `agent-ready`, `needs-sam`, `blocked` and the filter "Sam — agent queue"
   (`assigned to: me & @needs-sam`) are created by this session; verify they exist.
5. **Label the first cards** `agent-ready` on the tidyPortal board. Good first candidates (already
   have Done-when blocks): "Portal: show order + drawer descriptions clearly (admin order page)" —
   the text-only half; "Portal: show photos attached to order/drawer descriptions" after its DB
   subtask; the DXF download fix; estimated delivery date (#23).
6. **First real run, Sam-driven:** in Claude Code, `dispatch` (the dispatcher agent by name) with
   WIP limit 1. Watch one card go Selected → In Progress → In Review and land a PR with the evidence
   body. Merge or request changes. That's Stage 1's exit gate (×3).

## Knobs you'll touch
- `.claude/team.json` → `limits.*`, `models.*`, `todoist.labels`. Change there, not in the agent files.
- `settings.json` hook timeouts (600 s) — raise if `next build` is slow on the mini.

## Not in this set (by design)
- The scheduled `claude -p` dispatcher under launchd (Stage 2) and the cloud routine for the portal.
- The `@claude` GitHub Action — `/install-github-app` in the repo when you want the review→fix loop.
- `planning/contracts/` consolidation — first task for the Systems Engineer lens; separate PR.
- Packaging as the `manifest-dev-team` plugin — after the files stop changing (Stage 2–3).
