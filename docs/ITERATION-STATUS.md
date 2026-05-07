# Phoenix — Iteration Status

*Living document. Updated at the end of each iteration or before context-window resets. The most recent entry at the top is the source of truth for "what to do next."*

---

## Current state — 2026-05-06 (after iter 12 + verification + silent-fallback hardening)

### Where we are

Iteration 12 is committed. The Evaluation primitive exists in Phoenix for the first time. Twelve iterations on branch `claude/hungry-aryabhata-b78765`.

The 2026-05-06 stdlib run was initially recorded as "verified green" but a follow-up run on `node-typescript` exposed a silent-fallback bug: when `claude` CLI throws (ETIMEDOUT, auth, rate limit) inside `generateWithLLM`, Phoenix substituted stubs and the manifest still recorded `model_id: claude-cli/sonnet` as the provenance. The Web Experience IU on the `node-typescript` run hung for 64 minutes inside `claude`, fell back to a stub (15 lines, `{stub: true}` response), and the manifest lied about it. We discovered this only by visual inspection of generated file sizes.

That bug is now patched (silent-fallback hardening — see commit on this branch). The previous stdlib "green" is reclassified as suspect until re-verified with the new instrumentation in place.

### Branch state

```
380197c test: deletion-test instrumentation (visibility + realistic timeout)   ← iter 12 follow-up
2f03a82 feat: bring the Evaluation primitive into existence; deletion-test runner
cdd28f4 test: CLI-flow smoke + hard-fail user-input errors
a3d21a8 refactor: pull project-file generation onto RuntimeTarget
ed7521a feat: align JSON 404 responses across runtime targets
23eb445 test: three-way HTTP behavioral equivalence — Hono / stdlib / Express
bd21404 feat: node-typescript-express — third runtime target proves abstraction
0795cac refactor: pull generateModuleStub and generateServiceTests onto RuntimeTarget
5ddb299 refactor: pull generateServerEntry from scaffold.ts onto RuntimeTarget
22df98e refactor: pull stripImportPatterns from regen.ts onto RuntimeTarget
c446305 refactor: pull mandatoryImports from prompt.ts onto RuntimeTarget
a76edee test: functional equivalence between runtime targets via HTTP replay
5b6ae81 feat: prove durable/ephemeral split — second runtime target + diff harness
542ab61 feat: interface registry for cross-IU contract consistency  ← branch start
```

### What happened on 2026-05-06

**Run 1 — `node-typescript-stdlib`** (2547s ≈ 42.4 min): finished green at the test level. 4 spec clauses → 47 canonical nodes → 3 IUs planned, 1 eval resolved. Bootstrap phase emitted `spawnSync claude ETIMEDOUT` for 2 of 3 IUs (Tasks, Web Experience); regen was thought to have recovered. **However** — at the time we had no way to tell whether regen actually produced LLM output or fell back to stubs. The "green" is suspect.

**Run 2 — `node-typescript`** (Hono target): test process exited silently with no clear pass/fail in the terminal. Forensic check on the preserved temp dir uncovered the smoking gun:

- Projects IU: 4180 bytes / 97 lines, real generated CRUD, regenned 00:16:06 UTC
- Tasks IU: 7057 bytes / 224 lines, real generated CRUD, regenned 00:16:47 UTC (41s later)
- Web Experience IU: **437 bytes / 15 lines, a stub** returning `{stub: true, message: 'Not yet implemented'}`, regenned 01:20:52 UTC — **64 minutes after Tasks**

`claude` CLI hung for 64 min on the Web Experience prompt, eventually timed out, regen silently substituted a stub, and the manifest recorded `model_id: claude-cli/sonnet` as provenance. The system actively lied about who generated the file.

### Silent-fallback hardening (this iteration)

Three changes, ~30 lines:

1. **`RegenMetadata.fell_back?: boolean`** ([src/models/manifest.ts](src/models/manifest.ts)) — set per IU in `generateIU` ([src/regen.ts](src/regen.ts)) when stub substitution replaced LLM output. Absent (not `false`) when LLM succeeded or stubs were chosen up front.

2. **`cmdRegen` and `cmdBootstrap` exit non-zero on full fallback** ([src/cli.ts](src/cli.ts)) — when an LLM provider was configured but every IU's `fell_back` is `true`, exit 1 with a stderr message naming common causes (auth expiry, rate limit, network, ETIMEDOUT). Partial fallback still passes, since one transient IU hiccup shouldn't break the whole run.

3. **`onProgress('error', _)` writes to stderr instead of stdout** in both `cmdBootstrap` and `cmdRegen` — so subprocess parents (the deletion test, future supervisors) can capture the failure signal cleanly.

Plus a unit test in [tests/unit/regen.test.ts](tests/unit/regen.test.ts) that injects a throwing LLMProvider and asserts the manifest carries `fell_back: true`.

### Outstanding queued items

1. **Re-verify `node-typescript-stdlib`** with the new instrumentation. If `fell_back` is absent on every IU, the green is real. If any IU has `fell_back: true`, the previous "green" was partly stubbed.

2. **Run `node-typescript` and `node-typescript-express`** end-to-end. With the hardening in place, full-fallback hangs will exit non-zero rather than silently producing fake-provenance manifests. Each target is ~30-60 min wall-clock plus any LLM hiccup overhead.

3. **Pin the version-stable Claude CLI symlink** in docs/sanderson.md or SUCCESS-CRITERIA.md as the canonical CLI setup. Note the version pinning in `/Users/san/Library/Application Support/Claude/claude-code/X.Y.Z/...` and that auto-update breaks the symlink.

4. **Investigate the 64-min `claude` hang** as a separate concern. Whether it's a Phoenix-side timeout (we should add one to `generateWithLLM`'s spawnSync) or a `claude` CLI bug. A bounded timeout (e.g. 5 min per IU) would catch this much faster.

### Long-arc roadmap (codified in docs/SUCCESS-CRITERIA.md)

| Iter | Capability | State |
|---|---|---|
| 12 (DONE) | Evaluation primitive exists; deletion-test runner; SUCCESS-CRITERIA charter; sanderson manifesto | committed + verified green on `node-typescript-stdlib` (2026-05-06) |
| 13 (NEXT) | Production observation source + auto-suggested evals; canonicalizer integration of evals as durable inputs alongside clauses (Flavor B) | queued |
| 14 | Shadow mode for any current implementation (code, socio-technical workflow, or hybrid). The strangler primitive itself | queued |
| 15 | Eval coverage metric + progressive cutover gated by eval pass rate | queued |
| 16 | Current-implementation retirement criteria | queued |
| 17+ | Ensemble agents for scaling eval coverage growth | queued |

### Reference docs

- `docs/SUCCESS-CRITERIA.md` — canonical charter (deletion test, durable/ephemeral boundary, three principles, trajectory rule, long-arc roadmap)
- `docs/sanderson.md` — user's manifesto (throughlines, collective leap, strangler-as-socio-technical, Food on the Table)
- `PRD.md` — Phoenix's original PRD (still relevant, predates the eval work)
- `docs/ARCHITECTURE.md` — Phoenix's existing architecture description
- `~/.claude/plans/tidy-pondering-thompson.md` — iter-12 plan (kept current; updated whenever plan-mode is re-entered)

### Operating principles for future iterations

Codified in SUCCESS-CRITERIA.md, restated here for resume context:

- **Trajectory check** at the top of every iteration plan: Advances / Preserves / Off-trajectory
- **Sparse-grow eval principle**: don't author exhaustively; add evals on demand from incidents, observation, or spec changes
- **Strict durable/ephemeral boundary**: only `spec/` and `evals/` are durable; everything else regenerates
- **Production-as-truth**: evals are the oracle, not opinions and not the spec text alone
- **Plan-mode workflow**: plan first → ExitPlanMode for approval → execute → commit. User has been consistent about this.

### Operating environment notes

- macOS, zsh, working dir `/Volumes/My Shared Files/sandbox/phoenix/.claude/worktrees/hungry-aryabhata-b78765`
- pnpm v10 (NOT npm) — pnpm requires `pnpm.onlyBuiltDependencies: ['better-sqlite3', 'esbuild']` in package.json for native postinstall
- Node v24+ available at `/Users/san/.proto/shims/node`
- `claude` CLI symlink at `/opt/homebrew/bin/claude` → `/Users/san/Library/Application Support/Claude/claude-code/2.1.121/claude.app/Contents/MacOS/claude`
- `claude -p` mode requires `claude /login` (separate from desktop GUI auth)
- Spawning bash subshells from inside Claude Code agent context filters `ANTHROPIC_API_KEY` (security default), so the deletion test cannot be run end-to-end from within an agent — only the user's regular shell

### How to read this doc on agent resume

1. Read this file first.
2. Read `docs/SUCCESS-CRITERIA.md` (the charter).
3. Read `docs/sanderson.md` (the manifesto).
4. Read `~/.claude/plans/tidy-pondering-thompson.md` (the iter-12 plan).
5. Continue from "Next step on resume" above.

---

## Iteration log

### Iteration 12 — 2026-05-05/06 (committed in `2f03a82` + `380197c`)

**Trajectory:** Advances. Brings the Evaluation primitive into existence for the first time in the project; lays foundation for iters 13-16+.

**Delivered:**
- `docs/SUCCESS-CRITERIA.md` (charter)
- `docs/sanderson.md` (user's manifesto)
- `evals/todo-app.feature` (one bootstrap scenario, standard Gherkin)
- `src/eval-parser.ts` (@cucumber/gherkin wrapper)
- Revised `src/models/evaluation.ts` (subject + given/when/then steps + resolved fields optional)
- `runEvaluation` method on `Architecture` model
- web-api eval adapter with 5 step definitions (HTTP projection)
- cmdBootstrap parses evals + simple resolver populates EvaluationStore
- `tests/e2e/deletion-test.test.ts` (gated runner)
- Eval-parser unit tests (7)
- Updated existing eval-store unit tests (7)
- Iter 12 follow-up: deletion-test diagnostic dump + 30-min timeout + stdout streaming

**Verified:**
- Typecheck clean
- 425 unit/e2e tests pass + 5 properly skipped (3 deletion-test cases gated, 2 pre-existing functional-e2e gated)
- Forensic check: 0 lines of diff in `src/regen.ts`, `src/scaffold.ts`, `src/llm/prompt.ts`. Iter 12 is purely additive on the load-bearing pipeline.
- Skip path of deletion test verified (correct env-gated reasons logged)
- **Real-LLM deletion test verified green (2026-05-06)** for `node-typescript-stdlib` in 2547s. See "Verified green" section above for diagnostic detail (ETIMEDOUTs during bootstrap codegen recovered through regen).

### Iterations 1-11

See git log entries — each commit message contains its own trajectory check, deliverables, verification, and what-it-unlocks sections. Summary by category:

- **Iter 1-2** (`5b6ae81`, `a76edee`): structural diff + functional HTTP equivalence between two Hono runtime targets. Established the durable/ephemeral split.
- **Iter 3-6** (`c446305`, `22df98e`, `5ddb299`, `0795cac`): refactored five Hono/SQLite assumptions onto `RuntimeTarget` (mandatoryImports, stripImportPatterns, generateServerEntry, generateModuleStub, generateServiceTests). Pure preparation; no observable behavior change.
- **Iter 7** (`bd21404`): added `node-typescript-express` as third runtime. Forensic verified: zero edits to load-bearing files. Abstraction is load-bearing.
- **Iter 8** (`23eb445`): three-way HTTP behavioral equivalence test (cross-target functional). Same hand-curated todo-app modules in three frameworks → identical canonicalized HTTP responses.
- **Iter 9** (`ed7521a`): aligned 404 defaults across runtimes (JSON `{error: 'Not Found'}` everywhere).
- **Iter 10** (`a3d21a8`): pulled project-file generation (package.json, tsconfig, vitest config) onto `RuntimeTarget` for non-Node-runtime preparation.
- **Iter 11** (`cdd28f4`): CLI-flow smoke test + hard-fail user-input errors. Closed the gap where my own iter-10 baseline-capture had silently produced bogus output (stale dist + suppressed stderr).
