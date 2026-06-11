# Phoenix: generated behavior test reuses the module's shared-file import path without re-basing for the `__tests__/` subdirectory — diagnosis, outcomes & evidence

## Headline

The newly-landed **behavioral test generator** emits the test into a `__tests__/` subdirectory but gives it
the **same relative import for shared files** (`../../db.js`) that the *module* uses — without accounting for
the test being **one directory deeper**. So the import resolves to a nonexistent path, the test fails to
typecheck, per-module **`evidence(...)` fails**, and acceptance fails. A correct, 26-case behavior suite is
sunk by an off-by-one in one import path.

## Evidence (run `run-20260610-180348-6ba1ff`, laden Bramble, from scratch)

- Acceptance failure:
  ```
  ✖ evidence(Bramble Store): failed typecheck
  ✖ evidence(Web Experience): failed typecheck
  ✖ typecheck: 1 type error(s)
  ✔ cross-module-contract: 2 module(s) — all calls resolve
  ```
- The single error:
  ```
  src/generated/bramble-store/__tests__/bramble-store.behavior.test.ts(3,31):
    error TS2307: Cannot find module '../../db.js' or its corresponding type declarations.
  ```
- Path math — the generator reused the **module's** import depth for a file one level deeper:
  - module `src/generated/bramble-store/bramble-store.ts` → `import … from '../../db.js'` = `src/db.js` ✔
  - test   `src/generated/bramble-store/__tests__/bramble-store.behavior.test.ts` →
    `import { runMigrations } from '../../db.js'` = `src/generated/db.js` ✘ (needs `../../../db.js`)
- The test's *sibling* import is correct for its depth — `import mod from '../bramble-store.js'` (line 2)
  resolves fine. So **only the shared-file import (`db.js`, and any `app.js`) was not re-based** for the
  `__tests__/` nesting; module-relative imports were.
- The suite itself is otherwise good (227 lines, 26 cases mapping to spec clauses: `list→200 array`,
  `append→201`, positive-integer + strictly-increasing seq, ascending order, echoes type/payload, accepts
  `link`/`add-existing`/`create-reference`, …). Only the import path is wrong.

## Outcomes & evidence of success (Phoenix POV)

### I1. A generated test resolves its imports from the test file's own location.
**Outcome:** every import in a generated test is computed relative to the **test file's directory**
(`…/__tests__/`), not copied from the module's directory; shared modules (`db`, `app`) and the
module-under-test all resolve.
**Evidence:** `tsc --noEmit` reports 0 errors from the generated `*.behavior.test.ts`; the import to the
shared db module resolves to `src/db.js`.

### I2. Per-module `evidence(typecheck)` passes for a freshly-generated module with behavior tests.
**Outcome:** the new per-module evidence check (which surfaced this) passes once the test typechecks.
**Evidence:** `evidence(Bramble Store)` and `evidence(Web Experience)` both report ok; overall `typecheck`
is clean.

### I3. (Headline) A from-scratch app with behavioral tests reaches `✔ verified`.
**Outcome:** the Bramble run, with the 26-case store behavior suite, passes acceptance — no manual fix to a
generated test path.
**Evidence:** `phoenix run` on the laden Bramble spec ends `outcome ok`; the behavior suite runs green.

## Fix locus (for the implementer)

- The **behavior-test emitter**: compute shared-file import specifiers from the test file's path (one level
  deeper than the module, in `__tests__/`) — e.g. `../../../db.js` — rather than copying the module's
  specifier. Better: import shared modules via a **depth-independent specifier** (a path alias / tsconfig
  `paths` entry, or a package self-import) so nesting depth can't make this wrong again.
- Distinct from `DEPENDENCY-LIFECYCLE-OUTCOMES.md` / the B3 "write shared files before typechecking modules"
  ordering work: here `db.ts` exists and the module imports it fine; the bug is purely the **test's path
  computation** for the subdirectory.

## Provenance

Surfaced on the first from-scratch run after behavioral-test generation landed (the
`GENERATED-EVIDENCE-SMOKE-ONLY-DIAGNOSIS.md` outcomes E1/E2 began appearing — a real 26-case store suite plus
per-module `evidence(...)` evaluation). The suite is correct except its shared-file import is off by one
directory level because the test lives in `__tests__/`. See also `BEHAVIOR-TESTS-WEBUI-MISSING-DIAGNOSIS.md`
(the web-ui module still has no behavior suite at all).
