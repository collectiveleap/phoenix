# Phoenix environment contract — outcomes & evidence

**Core principle (from review):** Phoenix **regenerates everything from scratch**. The user owns only the
**spec** and the **architecture selection**. Therefore:

- The **environment contract is minimal**: it provides only the runtime prerequisites of the *selected*
  architecture — nothing project-specific that Phoenix itself generates.
- **Anything project-specific** (install dependencies, write and order all generated files, build native
  deps, generate `package.json`/`tsconfig`, etc.) is **Phoenix's regenerate-from-scratch responsibility**,
  not the environment's and not the user's.
- Under this contract there should be **no hand-edited files**. If Phoenix ever reports "kept a hand-edited
  file," that is a signal the contract was violated — not a feature.

This doc was first drafted from manual fixes applied while driving a real app ("Bramble") through
`phoenix run`. On review, most of those "fixes" were the author doing **Phoenix's job by hand** — i.e.
contract violations, not environment requirements. The sections below separate the genuine (minimal)
environment contract from the Phoenix responsibilities those workarounds actually pointed at.

---

## Part A — The environment contract (minimal, per selected architecture)

The environment must provide **only** the runtime prerequisites that the *supported, selected*
architecture depends on. Nothing more.

### A1. A supported runtime is present.
- **Outcome:** the selected architecture declares its runtime requirement (e.g. Node ≥ 22); the environment
  provides it; preflight verifies it.
- **Evidence:** preflight fails fast with the required version if the runtime is too old; passes otherwise.

### A2. A package manager is present.
- **Outcome:** a supported package manager (pnpm/npm/…) exists so Phoenix can install the architecture's
  declared dependencies. (The *install* is Phoenix's job — see B1.)
- **Evidence:** preflight reports which package manager it will use; fails with remediation if none.

### A3. The selected LLM provider's CLI is installed.
- **Outcome:** the provider chosen in config (e.g. `claude-cli`) has its CLI installed and locatable. A
  normal install places it on PATH.
- **Evidence:** preflight's provider check passes when the CLI is installed; fails with an install hint when
  it is not.
- **Note (from this session):** on the test machine `claude` existed only inside the macOS `.app`, not on
  PATH — a non-standard install. The environment side of this is simply "the CLI is installed." The robust
  *location* and the *optimal invocation flags* are Phoenix's job — see B4.

### A4. A C toolchain is present **only if** the selected architecture uses native dependencies.
- **Outcome:** the environment provides a C compiler **iff** the architecture's declared deps include a
  native module. If the architecture has no native deps, this requirement does not exist.
- **Evidence:** preflight requires a compiler only for native-dep architectures; for a pure-JS architecture
  it does not.
- **Strong recommendation:** the `node-typescript` architecture should use Node's built-in `node:sqlite`
  (Node ≥ 22) instead of `better-sqlite3`. That removes the native dependency entirely, which removes the
  C-toolchain requirement from the contract **and** removes the native-build responsibility (B2). This is
  the cleanest resolution of the "should the SQLite build be part of the environment?" question:
  **don't depend on a native module in the first place.**

That is the entire environment contract. Everything below is Phoenix's responsibility.

---

## Part B — Phoenix's regenerate-from-scratch responsibilities (NOT environment, NOT user)

These are the items my manual workarounds pointed at. The correct outcome in each case is that **Phoenix
does it**, as part of regenerating from scratch — the user does nothing.

### B1. Phoenix installs the architecture's declared dependencies.
- **Workaround that was wrong:** I ran `pnpm add hono @hono/node-server better-sqlite3 zod …` by hand. That
  edited `package.json`, which is what later tripped the "kept 1 hand-edited file ⚠" warning.
- **Outcome:** Phoenix generates `package.json` *and* installs its declared deps as part of the run, so
  per-module typecheck and the acceptance boot both have them — with no user `add`/`install`.
- **Evidence:** in a fresh checkout, `phoenix run` reaches a clean acceptance boot with the user only
  providing spec + architecture; the user never edits `package.json`; no "hand-edited file" warning fires.

### B2. Phoenix builds (or avoids) native dependencies it declares.
- **Workaround that was wrong:** I ran `pnpm rebuild better-sqlite3` by hand because the package manager
  blocked the native build script, so the binding wasn't compiled → "Could not locate the bindings file" →
  no boot.
- **Outcome:** if the selected architecture declares a native dep, Phoenix ensures it is built (allowlist +
  build) as part of the run; or — preferred — the architecture avoids native deps (A4) so there is nothing
  to build.
- **Evidence:** with a build-script-blocking package manager, `phoenix run --runtime-checks` either builds
  the native dep automatically or the acceptance gate fails with "native dependency `<x>` not built — run
  `<cmd>`" — never an opaque bindings error. With the `node:sqlite` architecture, no build step exists.

### B3. Phoenix writes its own shared files before it typechecks modules that import them.
- **Workaround that was wrong:** I pre-copied `src/db.ts` and `src/app.ts` because the scaffold writes them
  only at the END (after per-module typecheck), so every module's typecheck failed on `cannot find
  '../../db.js'` → wasted repair iterations.
- **Outcome:** Phoenix's generation writes the architecture's shared files **before** generating/typechecking
  the modules that import them. Internal ordering only; zero user action.
- **Evidence:** generating a single module in a fresh project resolves the shared `db.js`/`app.js` imports
  with no user pre-placement; no repair iteration ever fires on "cannot find module '../../db.js'".

### B4. Phoenix locates and invokes the provider CLI optimally.
- **Workaround that was partly wrong:** I put a `claude` shim on PATH that (a) made the binary resolvable and
  (b) added `--strict-mcp-config --no-chrome` + `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`. Part (a) is an
  environment concern (A3 — the CLI should be installed). Part (b) — the **flags** — is Phoenix's job; a user
  should never shim invocation flags.
- **Outcome:** the provider locates the installed CLI robustly (PATH → configurable path → known install
  locations) and invokes it with startup-minimizing flags + non-essential-traffic disabled, so cold-boot
  stays under the startup-stall budget.
- **Evidence:** with the CLI installed (A3) but no user shim, the provider runs generations with first-byte
  latency under the startup budget; the spawned command includes the MCP-skip flags and traffic-disable env;
  the binary path is overridable via config for non-standard installs.

### B5. Phoenix owns its generated output directory.
- **Workaround that was a one-off:** I moved a previous run's `src/generated/*` aside because whole-project
  `tsc` choked on stale modules from an **earlier, different architecture** I had run by mistake. In normal
  single-architecture regenerate-from-scratch this situation does not arise.
- **Outcome:** regenerate-from-scratch cleans/owns the generated output, so switching architectures or
  re-running never leaves foreign stale files; the acceptance typecheck is scoped to what Phoenix generated.
- **Evidence:** running, then switching architecture and re-running, leaves no stale generated files; the
  acceptance gate never fails opaquely on files Phoenix did not generate.

### B6. Phoenix generates whatever the spec demands (no user trimming to fit a tool limit).
- **Workaround that was wrong (and misdiagnosed):** I trimmed the Web Experience spec, believing a large
  *output* module couldn't generate. The journal later proved the real cause was the intermittent **#45269
  startup hang** (the Store's prompt was *larger* and succeeded), fixed by **retries** — not output size. So
  the trim was unnecessary, and an "output-size gate" is not evidence-backed.
- **Outcome:** Phoenix regenerates whatever the spec demands; if a module is genuinely large, Phoenix handles
  it internally (e.g. chunking) — the user does not trim the spec to fit a tool limitation.
- **Evidence:** a large module specified by the spec is generated to completion without the user reducing
  scope. (Reliability of the underlying calls is the harness's job — see the harness doc; e.g. default
  `maxRetries` should be high enough to ride out the known-intermittent startup hang.)

---

## Out of scope for this doc

- **Spec-shape feedback** (was "E7"): Phoenix planning one module per `##` heading silently fragmented a
  single-page app, and an H1 intro with normative content became its own module. This is **not** an
  environment or toolchain concern — it is a *new capability*: **Phoenix giving the author feedback that
  their spec's shape will not generate well** (e.g. "this section will become N modules; a single-page app
  usually wants one"). It belongs with the spec-authoring/feedback work, not here.

---

## Summary

The environment contract is **small and per-architecture** (Part A): runtime, package manager, provider
CLI, and a C toolchain *only if* the architecture uses native deps (which the `node:sqlite` recommendation
removes). **Everything else is Phoenix regenerating from scratch** (Part B): install deps, build/avoid
native deps, order its own file writes, locate+invoke the provider well, own its output dir, and generate
whatever the spec demands. The litmus test the review supplied: **if a "requirement" is the user doing
something Phoenix should regenerate, it is not an environment contract — it is a Phoenix gap.**
