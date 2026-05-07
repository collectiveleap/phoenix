# Phoenix — Plan File (resume anchor across context resets)

*This file (`.claude/plan.md`, in-repo, version-controlled) is the canonical "what's next" reference. After context reset, the agent should read this first, then `docs/ITERATION-STATUS.md`, then proceed. See [CLAUDE.md](../CLAUDE.md) for the full resume-order convention.*

---

## Quick orientation

**Repo**: `/Volumes/My Shared Files/sandbox/phoenix/.claude/worktrees/hungry-aryabhata-b78765`
**Branch**: `claude/hungry-aryabhata-b78765`
**Current iteration**: 12 + silent-fallback hardening + timeout fix. **First canonical verified-green deletion test on 2026-05-07 (3075s) for `web-api/node-typescript-stdlib`** — full closed loop validated, no stub fallback, eval passed. The ground under iters 13-17+ is now empirical, not aspirational.

**On resume, read these in order:**
1. This file (you're here)
2. `docs/ITERATION-STATUS.md` in the repo — running log + current outstanding work
3. `docs/SUCCESS-CRITERIA.md` — canonical charter (deletion test, durable/ephemeral boundary, three principles, trajectory rule, long-arc roadmap)
4. `docs/sanderson.md` — user's manifesto (the deeper "why": throughlines, collective leap, strangler-as-socio-technical)
5. Recent git log: `git log --oneline -15`

## What you're walking into

Iter 12 (Evaluation primitive) is committed. On 2026-05-06 we ran the real-LLM deletion test on two of three runtime targets:

- `node-typescript-stdlib`: 2547s green at the test level. Initially recorded as "verified green" — now reclassified as **suspect** because the test predates the silent-fallback fix and we cannot tell whether the green came from real LLM output or stubs.
- `node-typescript` (Hono): ran for ~3 hours, exited silently with no terminal pass/fail. Forensic check on the preserved temp dir found the silent-fallback bug red-handed: Web Experience IU stubbed after a 64-min `claude` ETIMEDOUT, manifest claimed `model_id: claude-cli/sonnet` anyway.

**Silent-fallback hardening shipped same day** on this branch. Three changes (~30 lines): `regen_metadata.fell_back?: boolean` recorded per IU; `cmdBootstrap` and `cmdRegen` exit non-zero on full fallback; `onProgress('error', _)` routed to stderr. Plus a unit test covering the new behavior.

## Next concrete step

Re-run the deletion test on `node-typescript-stdlib` first to validate the hardening and confirm or invalidate the previous "green":

```sh
PHOENIX_RUN_LLM_E2E=1 ./node_modules/.bin/vitest run \
  tests/e2e/deletion-test.test.ts -t "node-typescript-stdlib"
```

After the run, check the manifest at `<tmp-dir>/.phoenix/manifests/generated_manifest.json` and confirm no IU has `regen_metadata.fell_back === true`. If clean, the verified-green table in `docs/SUCCESS-CRITERIA.md` should drop the "suspect" qualifier.

## Queued follow-ups

1. **Run `node-typescript` and `node-typescript-express`** end-to-end. With hardening, full-fallback hangs exit non-zero rather than silently producing fake-provenance manifests.

2. ~~**Bound the per-IU LLM call timeout.**~~ DONE — but in the *opposite* direction the original plan assumed. The 2026-05-06 trust-gate-validated re-run revealed Web Experience IU is genuinely slow (>10 min of legitimate generation), not stuck. Bumped from 10 min to 20 min in `src/llm/claude-cli.ts:37`. Pending: re-run deletion test to confirm 20 min is enough.

3. **Iter 13 — production observation source + auto-suggested evals + canonicalizer integration of evals as durable inputs alongside clauses** (Flavor B from the iter-12 design discussion). The next big iteration on the strangler-pattern roadmap. Spec: see "Long arc roadmap" in `docs/SUCCESS-CRITERIA.md`.

4. **Pin the version-stable Claude CLI symlink** in docs/sanderson.md or SUCCESS-CRITERIA.md as the canonical CLI setup.

## Long-arc roadmap (from SUCCESS-CRITERIA.md)

| Iter | Capability |
|---|---|
| 12 (DONE + VERIFIED) | Evaluation primitive exists; deletion-test runner; charter + manifesto. **First canonical verified-green for stdlib target on 2026-05-07** (3075s, all IUs real LLM, eval pass). |
| 13 (NEXT) | Production observation source + auto-suggested evals; canonicalizer integration |
| 14 | Shadow mode for any current implementation (code or socio-technical) |
| 15 | Eval coverage metric + progressive cutover |
| 16 | Current-implementation retirement |
| 17+ | Ensemble agents for scaling eval coverage growth |

## Operating principles to preserve across resumes

- **Trajectory check** at top of every iteration plan: Advances / Preserves / Off-trajectory
- **Sparse-grow eval principle**: don't author exhaustively; add evals on demand
- **Strict durable/ephemeral boundary**: only `spec/` and `evals/` are durable
- **Production-as-truth**: evals are the oracle
- **Plan mode → ExitPlanMode → execute**: user has been consistent on this workflow
- **Do not pretend to verify what wasn't verified**: e.g., the iter-12 commit message explicitly says the deletion test was not run end-to-end during the iteration's work

## Operating environment notes

- macOS, zsh, working dir is the worktree path above
- pnpm v10 (NOT npm) — needs `pnpm.onlyBuiltDependencies: ['better-sqlite3', 'esbuild']` in package.json for native postinstall
- Node v24+ at `/Users/san/.proto/shims/node`
- `claude` CLI symlinked at `/opt/homebrew/bin/claude` (version-pinned; breaks on Claude Desktop auto-update)
- `claude -p` print mode requires its own `claude /login` (separate from desktop GUI auth)
- Spawning bash from inside Claude Code agent context filters credentials; the deletion test cannot be run end-to-end from within an agent — only from the user's regular shell
- Vitest reporter: default reporter doesn't show progress mid-test; deletion-test now streams via `stdio: inherit` to surface phoenix's own progress markers

## Files that matter

```
docs/
├── SUCCESS-CRITERIA.md     # canonical charter
├── sanderson.md            # user's manifesto
├── ITERATION-STATUS.md     # running log + current outstanding work
├── PRD.md                  # original Phoenix PRD
└── ARCHITECTURE.md         # Phoenix's existing architecture

evals/
└── todo-app.feature        # one bootstrap scenario (Gherkin)

src/
├── architectures/
│   ├── web-api.ts          # has runEvaluation adapter (5 step defs)
│   ├── node-typescript.ts
│   ├── node-typescript-stdlib.ts
│   └── node-typescript-express.ts
├── models/
│   ├── architecture.ts     # has runEvaluation method type
│   └── evaluation.ts       # split into durable + resolved layers
├── eval-parser.ts          # @cucumber/gherkin wrapper
├── store/
│   └── evaluation-store.ts # path stays under .phoenix/ (ephemeral resolved view)
└── cli.ts                  # cmdBootstrap parses evals + runs simple resolver

tests/
├── e2e/
│   ├── deletion-test.test.ts             # iter 12 gated runner
│   ├── cli-flow-smoke.test.ts            # iter 11
│   ├── cross-target-functional.test.ts   # iter 8
│   └── ... (others)
└── unit/
    ├── eval-parser.test.ts  # iter 12
    └── evaluation.test.ts   # updated for new model
```

## How to detect drift on resume

Run `git log --oneline -5`. If the top commit isn't `5044742 docs: add ITERATION-STATUS.md` (or whatever the verified-green commit becomes), the user has done work after this plan was written and it's stale. Read `docs/ITERATION-STATUS.md` for what's actually current — it's the source of truth for what's verified vs queued.
