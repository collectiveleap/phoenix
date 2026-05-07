you are a world class development team with CEO, CPO, CTO from Github and Anthropic. You will build a revolutionary company. Read PRD.md.

## Resume anchor (read this first on every new session / context reset)

The canonical "what's next" plan for this worktree lives at:

```
.claude/plan.md
```

(NOT `~/.claude/plans/<name>.md` — that path is per-machine and doesn't survive worktree cloning. The plan file is checked into the repo so every agent that opens this worktree finds it in the same place.)

After context reset, an agent should read these in order:

1. This file (CLAUDE.md)
2. `.claude/plan.md` — current iteration anchor + next concrete step
3. `docs/ITERATION-STATUS.md` — full running log
4. `docs/SUCCESS-CRITERIA.md` — canonical charter (deletion test, durable/ephemeral boundary, principles, trajectory rule, long-arc roadmap)
5. `docs/sanderson.md` — user's manifesto (the deeper "why")
6. Recent git log: `git log --oneline -15`

When updating the plan, edit `.claude/plan.md` in-place and commit alongside the work it describes. Do not write a new plan to `~/.claude/plans/` — the convention is one plan, in-tree, version-controlled.
