# Phoenix — Iteration Status

*Living document. Updated at the end of each iteration or before context-window resets. The most recent entry at the top is the source of truth for "what to do next."*

---

## Current state — 2026-05-06 (after iter 12 + iter-12 instrumentation)

### Where we are

Iteration 12 is committed. The Evaluation primitive exists in Phoenix for the first time. Twelve iterations, twelve commits on branch `claude/hungry-aryabhata-b78765`. All static tests green (425 + 5 properly skipped). The deletion test is structurally complete and gates correctly; real-run verification is incomplete (see below).

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

### Outstanding immediate work — the deletion-test verification gap

**Status:** Test infrastructure complete and committed. Real-LLM run not yet verified green.

**What's been verified:**
- Skip path correct (3 cases skip when `PHOENIX_RUN_LLM_E2E !== '1'`)
- Test wires up correctly when env is set; LLM provider is detected; bootstrap and regen run
- Diagnostic instrumentation works: when evals fail, the test dumps IU plan, interface registry, server-endpoint probe results, and preserves the temp dir
- Found and fixed: vitest default reporter hides progress, per-test timeout was too short (6 min); commit `380197c` streams Phoenix CLI output through and bumps timeout to 30 min

**What's NOT yet verified:**
- Whether Phoenix's LLM-driven regen actually produces working CRUD code that satisfies the bootstrap eval. This is the headline iter 12 outcome.

**Blocker that surfaced (now resolved):** The `claude -p` print-mode binary requires its own login (`claude /login`) separate from Claude Desktop's GUI session. Without it, Phoenix's `claude-cli` provider silently fell back to stubs. The user ran `claude /login` and `claude -p` is now working.

**Next step on resume:**

```sh
cd /Volumes/My\ Shared\ Files/sandbox/phoenix/.claude/worktrees/hungry-aryabhata-b78765

# Single-target run first to verify the wiring (~10-20 min):
PHOENIX_RUN_LLM_E2E=1 ./node_modules/.bin/vitest run \
  tests/e2e/deletion-test.test.ts -t "node-typescript-stdlib"

# If green, run all three (~30-60 min):
PHOENIX_RUN_LLM_E2E=1 ./node_modules/.bin/vitest run tests/e2e/deletion-test.test.ts
```

You'll see streaming output like `[node-typescript-stdlib] phoenix bootstrap (LLM canonicalization — slow)…` followed by Phoenix's own `⏳`/`✔`/`✖` markers per IU. Don't Ctrl-C unless 25+ minutes pass with no movement.

**On green run:** post the output. I'll record the timestamp + observed token cost in this doc and append a "verified green" note to docs/SUCCESS-CRITERIA.md.

**On red run:** the diagnostic dump preserves the temp dir and prints the failure reason + IU plan + endpoint probes + cat commands. Paste the dump and we diagnose. Three likely causes are listed in the test's diagnostic block.

### Outstanding queued follow-ups (post iter 12)

These were surfaced during iter-12 verification and worth landing before iter 13:

1. **Silent-fallback hardening** (`cmdRegen`, `regen.ts:generateIU`): when LLM throws inside `generateWithLLM`, Phoenix silently falls back to stubs and the error message goes to stdout (which `execSync` swallows). Three small changes:
   - Record `regen_metadata.fell_back: true` in the manifest when stubs replaced LLM output, so the deletion test can `expect(manifest...fell_back).toBe(false)` before even running evals
   - Have `cmdRegen` exit non-zero when *every* IU fell back (suggests a config / auth problem, not an LLM hiccup)
   - Route `onProgress(_, 'error', _)` to stderr so subprocess parents capture it
   - ~30 lines, mostly in regen.ts + cli.ts

2. **Pin the version-stable Claude CLI symlink** in docs/sanderson.md or SUCCESS-CRITERIA.md as the canonical CLI setup. Note the version pinning in `/Users/san/Library/Application Support/Claude/claude-code/X.Y.Z/...` and that auto-update breaks the symlink.

### Long-arc roadmap (codified in docs/SUCCESS-CRITERIA.md)

| Iter | Capability | State |
|---|---|---|
| 12 (DONE) | Evaluation primitive exists; deletion-test runner; SUCCESS-CRITERIA charter; sanderson manifesto | committed; manual verification pending |
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

**NOT verified (the immediate gap):** real LLM-driven deletion test passing. Manual user run required. See "Outstanding immediate work" above.

### Iterations 1-11

See git log entries — each commit message contains its own trajectory check, deliverables, verification, and what-it-unlocks sections. Summary by category:

- **Iter 1-2** (`5b6ae81`, `a76edee`): structural diff + functional HTTP equivalence between two Hono runtime targets. Established the durable/ephemeral split.
- **Iter 3-6** (`c446305`, `22df98e`, `5ddb299`, `0795cac`): refactored five Hono/SQLite assumptions onto `RuntimeTarget` (mandatoryImports, stripImportPatterns, generateServerEntry, generateModuleStub, generateServiceTests). Pure preparation; no observable behavior change.
- **Iter 7** (`bd21404`): added `node-typescript-express` as third runtime. Forensic verified: zero edits to load-bearing files. Abstraction is load-bearing.
- **Iter 8** (`23eb445`): three-way HTTP behavioral equivalence test (cross-target functional). Same hand-curated todo-app modules in three frameworks → identical canonicalized HTTP responses.
- **Iter 9** (`ed7521a`): aligned 404 defaults across runtimes (JSON `{error: 'Not Found'}` everywhere).
- **Iter 10** (`a3d21a8`): pulled project-file generation (package.json, tsconfig, vitest config) onto `RuntimeTarget` for non-Node-runtime preparation.
- **Iter 11** (`cdd28f4`): CLI-flow smoke test + hard-fail user-input errors. Closed the gap where my own iter-10 baseline-capture had silently produced bogus output (stale dist + suppressed stderr).
