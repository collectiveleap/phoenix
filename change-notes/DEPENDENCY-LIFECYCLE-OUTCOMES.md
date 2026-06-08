# Phoenix: preflight gates the run on a Phoenix-installed dependency — diagnosis, outcomes & evidence

## Headline

`phoenix preflight` (and `phoenix run`, which preflights first) **hard-fails in a fresh workspace because
the TypeScript compiler is absent** — aborting before any generation. But `tsc`/`typescript` is a **declared
devDependency of the chosen architecture** that Phoenix installs itself at the provision step (B1). So
preflight gates the run on a dependency that (a) doesn't exist until later in the same lifecycle and (b) is
Phoenix's job to install, not the user's. The remediation it prints — `npm i -D typescript` — is exactly the
hand-install the environment contract says is a Phoenix gap, not an environment requirement.

**Core defect (one level up):** preflight conflates two requirement *classes* and gates on both as one flat
pass/fail — **host-supplied prerequisites** (runtime, package manager, provider; the host must provide
these, Phoenix can't install them) vs **architecture-derived dependencies** (typescript, hono, native deps;
these *emerge from the architecture choice* and are mostly installable by Phoenix). Only the first class
belongs in preflight. The typechecker is the second class, installable, and is already enforced downstream.

## Evidence (verified, fresh workspaces)

- `phoenix preflight` fails solely on `typechecker`:
  ```
  ✔ runtime: Node 24.11.1
  ✖ typechecker: TypeScript compiler not found … → Install TypeScript (npm i -D typescript) …
  ✔ package-runner: pnpm available
  ✔ llm-provider: claude-cli/sonnet (from auto-detect)
  Preflight failed — fix the above before running.
  ```
- `phoenix run --dry-run` shows the same failure.
- Current code: `cmdPreflight` (`cli.ts`) never reads `config.architecture`; `cmdRun` reads it but leaves
  `arch = null` when unset and proceeds; nothing defaults the architecture. `preflight()` already carries a
  `typecheckerProvisioned` escape hatch, but the callers don't feed it correctly. The architecture binding is
  legitimately lazy (you can `init` + author/inspect a spec — `ingest`/`canonicalize`/`plan` — without
  choosing a target), so preflight cannot assume it is bound.

## Audit of the existing dependency checks

| Check | Verdict |
|---|---|
| preflight `runtime`, `package-runner`, `llm-provider` | **Correct** — non-installable host prerequisites; keep. |
| preflight `typechecker` | **Incorrect + superseded** — an installable, Phoenix-provisioned dep; provision installs it and the acceptance typecheck verifies it. Remove from preflight. |
| `typecheckerProvisioned` option (`preflight.ts`) | **Redundant** — a band-aid for the above; delete once the check is gone. |
| preflight `native-build` (C toolchain) | **Correct when the arch is bound** (host-supplied, can't be installed); but `cmdPreflight`'s manual `--native` flag is an **incorrect** stand-in for reading the bound architecture. |
| `cmdPreflight` not reading `config.architecture` | **Incorrect** — can't classify any architecture-derived check; diverges from `cmdRun`. |
| provision (install arch deps), acceptance typecheck, regen `probeTypechecker` | **Correct** — the real install + verify steps; the typechecker's true enforcement point. |

## Outcomes & evidence of success

*(Current behavior kept: the architecture may be unbound at preflight; nothing is defaulted. A dependency is
checked at the step that owns it, only when the binding makes it knowable.)*

### DC1. Installable architecture dependencies are not preflight-gated.
**Outcome:** deps the architecture declares as installable (typescript, hono…) are installed at provision and
verified at the typecheck/acceptance step — never blocking preflight.
**Evidence:** a cold run with no TypeScript installed reaches generation with no hand-install; a provision that
fails to install/build them fails at the acceptance typecheck naming the cause.

### DC2. Only non-installable host prerequisites gate preflight unconditionally.
**Outcome:** runtime, package manager, and provider remain the unconditional preflight gates (current
behavior, kept) — Phoenix cannot install these, so the host must supply them.
**Evidence:** a missing package manager / provider / runtime fails preflight; the check is identical with or
without an architecture bound.

### DC3. The C-toolchain check is asserted only when the bound architecture declares native deps.
**Outcome:** the C-toolchain (host-supplied) is required only once a bound architecture declares `nativeDeps`;
when no architecture is bound, it is not asserted at preflight and is deferred to the native-build step.
**Evidence:** a bound native architecture with no compiler fails preflight naming the toolchain; an unbound or
non-native one demands no compiler; in the unbound case a missing compiler fails at native build instead.

### DC4. The preflight typechecker check and `typecheckerProvisioned` are removed as superseded.
**Outcome:** preflight no longer checks the typechecker; provision (install) + the acceptance typecheck
(verify) are the sole enforcement.
**Evidence:** no `typechecker` line in preflight output; a genuinely missing/broken `tsc` surfaces only
post-provision, as a Phoenix install/build failure.

### DC5. Standalone `phoenix preflight` derives its conditional checks from the bound architecture.
**Outcome:** `cmdPreflight` reads `config.architecture` (like `cmdRun`) and derives its architecture-conditional
checks (e.g. native-build) from the bound arch, rather than a manual `--native` flag.
**Evidence:** `phoenix preflight` with a native architecture in config checks the C toolchain without
`--native`; with no architecture bound, it asserts neither the toolchain nor the typechecker.

## Fix locus

- `src/harness/preflight.ts`: remove the `typechecker` check and the `typecheckerProvisioned` option (DC1/DC4);
  keep runtime / package-runner / provider; keep `native-build` but driven by the bound arch's `nativeDeps`.
- `src/cli.ts` `cmdPreflight`: resolve `config.architecture` and derive `requireNativeBuild`/`minNodeMajor`
  from it (DC5); drop reliance on `--native`.
- `src/cli.ts` `cmdRun`: drop the now-removed `typecheckerProvisioned` argument; keep `requireNativeBuild`
  from `arch.runtime.nativeDeps`.
- Tests (`tests/unit/preflight.test.ts`): no typechecker gate; runtime/pm/provider still hard-fail; native
  check only when a native arch is bound.

## Provenance

Found driving a fresh-workspace `phoenix run`: every cold run aborted at preflight on the absent TypeScript
compiler before any generation. Refined through the lifecycle lens — dependencies emerge from the
architecture choice, the binding is legitimately lazy, and preflight must check only what the host must
supply, when that is knowable. Extends `ENVIRONMENT-CONTRACT-OUTCOMES.md` (Part A vs B1).
