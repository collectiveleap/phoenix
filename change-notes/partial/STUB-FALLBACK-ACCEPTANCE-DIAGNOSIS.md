# Phoenix: "verified" must fail on stub-fallback modules — diagnosis, outcomes & evidence

## Headline (high priority — undermines trust in every run)

A run reported **`✔ app verified` (outcome ok, acceptance ✔)** while one module had **silently fallen
back to a stub** because its generation failed. The acceptance gate's definition of "verified" does **not**
require that every module was actually generated — and a stub both **typechecks clean** and **serves a
route**, so neither the typecheck gate nor the boot/route gate can tell a stub from a real module.

Net: a Phoenix run can declare success while the app is partially non-functional. That breaks the core
"done means it works" guarantee.

## Evidence

- Run `run-20260607-162020-e25f74`: `stage: done · outcome ok`, `acceptance ✔ (typecheck: clean)`.
- Yet `src/generated/web-experience/web-experience.ts` is the **15-line stub**:
  ```ts
  import { Hono } from 'hono';
  const router = new Hono();
  router.get('/', (c) => c.json({ stub: true, module: 'Web Experience', message: 'Not yet implemented' }));
  export default router;
  ```
- Cause: the module had **4 watchdog-killed generation attempts**, then `dist/regen.js:70` ("fall back to
  stub on … transient LLM failures") wrote the stub. The stub-fallback is **not surfaced** to the run
  outcome or the acceptance gate.
- The stub is valid TypeScript → the typecheck gate passes. The stub also `export default`s a working Hono
  router → boot + `/health` would pass too. **No existing gate distinguishes a stub from a real module.**
- Note the asymmetry already in the code: an **over-budget** failure hard-fails with a remediation
  (`regen.js:57`, T3), but a **watchdog-kill → stub fallback** does not. So the very modules most likely to
  fail silently are the ones that slip through as "verified."

---

## Outcomes & evidence of success (Phoenix POV)

### V1. A module that fell back to a stub is recorded as a generation failure.
**Outcome:** when generation exhausts retries and substitutes a stub, the manifest/journal marks that
module as **stub-fallback / failed**, not "generated."
**Evidence:** `phoenix runs <id>` shows the module as failed (not ok); the manifest carries a
generation-status flag (e.g. `status: stub-fallback`).

### V2. "Verified" requires zero stub-fallbacks.
**Outcome:** the run's terminal outcome is **not "done/verified"** if any module is a stub-fallback, even
when typecheck and boot pass.
**Evidence:** a run where any module fell back to a stub reports failure and **names that module** —
never `✔ app verified`. The `run-20260607-162020` case (Web Experience stub) would report failure.

### V3. The acceptance gate detects stub modules.
**Outcome:** the acceptance gate explicitly checks that generated modules are real implementations, not
stub fallbacks — via the V1 status flag (preferred) or a recognizable stub marker.
**Evidence:** replacing any module with its stub fallback causes the gate to fail with
*"module X is a stub (generation failed)"* — independent of typecheck/boot passing.

### V4. (Headline) "verified" means every module is a real, working implementation.
**Outcome:** `✔ app verified` is emitted only when **all modules generated successfully** *and* typecheck
*and* (with `--runtime-checks`) boot + route checks pass.
**Evidence:** the Bramble run with a stub Web Experience reports failure; a run where all modules are real
and the app boots reports verified.

---

## Fix locus

- `dist/regen.js` (~line 70): when falling back to a stub, record a `stub-fallback`/`failed` status on the
  module result + manifest (don't silently substitute).
- `dist/harness/acceptance.js` + the run-outcome logic: treat any stub-fallback module as a gate failure;
  only emit "verified" when no module is a stub-fallback.

## Provenance

Found while finishing the "Bramble" app: the large Web Experience module failed to generate (4
watchdog-kills → stub), but `phoenix run` reported `✔ app verified`. See
`LARGE-MODULE-GENERATION-DIAGNOSIS.md` (why that module failed) and `OBSERVABILITY-HARNESS-OUTCOMES.md`
O12 (the acceptance gate this strengthens).
