# Phoenix: "verified" rests on a smoke test — declared behavioral/property evidence is neither generated nor evaluated — diagnosis, outcomes & evidence

## Headline

A module reaches `✔ app verified` while its **declared `evidence_policy.required`** lists
`unit_tests`, `property_tests`, `boundary_validation`, `static_analysis` — but the only test Phoenix
generates is a **16-line smoke test** (*"exports a Hono router"*), **no property tests exist at all**, and the
acceptance gate surfaces only `typecheck` + `cross-module-contract`. So "verified" asserts almost none of the
specified behavior: the spec is full of behavior-altitude clauses (given/when/then-style) and **none of them
becomes an assertion**. The actual behavior is covered only by hand.

## Evidence (run `run-20260610-151108-fae76c`, laden Bramble — boots + round-trips)

- **Declared policy** (both IUs, `.phoenix/graphs/ius.json`):
  ```json
  "evidence_policy": {"required": ["typecheck","lint","boundary_validation","unit_tests","property_tests","static_analysis"]}
  ```
- **What "unit_tests" actually is** (`src/generated/bramble-store/__tests__/bramble-store.test.ts`, 16 lines;
  the web-experience test is byte-identical in shape):
  ```ts
  it('exports a Hono router as default', () => {
    expect(bramble_store).toBeDefined();
    expect(typeof bramble_store.fetch).toBe('function');
  });
  ```
- **`property_tests` / `boundary_validation` files do not exist** — `find src -name '*.test.ts'` returns only
  the two smoke files.
- **The gate evaluated ~2 of the 6 declared types**: acceptance output showed only `✔ typecheck: clean` and
  `✔ cross-module-contract: all calls resolve` — no `lint` / `boundary_validation` / `unit_tests` /
  `property_tests` / `static_analysis` results appear.
- **Concretely unasserted, though all specified in `spec/`:**
  - Store: list in seq order; append → 201 with assigned seq; reject unknown `type` / non-object `payload`
    → 400; durability across restart; `?since` catch-up.
  - Web-ui: the `@`-picker; the `create-reference` (line with text) vs `add-existing` (empty/pending line)
    fork; cycle-refusal; the `[N]` incoming-reference badge; the backlinks panel; and every editing op
    (Enter/Tab/Shift-Tab/Backspace/…).
  - All of the above was verified **only manually** (the P1.3 boot + round-trip).

---

## Outcomes & evidence of success (Phoenix POV)

### E1. Generated tests assert the spec's behavior, not just the module's shape.
**Outcome:** each module gets behavioral tests derived from its spec clauses (the given/when/then content),
exercising the actual behavior — not only "exports a router." The smoke test may remain as a floor, not the
whole suite.
**Evidence:** the store's generated suite asserts append→201, unknown-type/non-object-payload→400, list
order, `?since`, and durability; removing any of those behaviors from the implementation (spec unchanged)
fails a generated test. Today every such mutation still passes.

### E2. The declared evidence policy is actually produced and evaluated — or the module isn't "verified."
**Outcome:** every type in `evidence_policy.required` is generated **and** run at the gate; a module missing
a required type (e.g. `property_tests`) cannot reach `✔ verified`, and the unmet types are named.
**Evidence:** the gate report lists each required evidence type with pass/fail; a run with no property tests
reports failure naming `property_tests`, instead of `✔ verified`. (No silent honoring of only
typecheck + contract.)

### E3. "verified" means the specified behavior is asserted.
**Outcome:** `✔ verified` requires the behavioral evidence the spec implies — extends
`STUB-FALLBACK-ACCEPTANCE-DIAGNOSIS.md` ("verified" must mean works) from "boots + a route" to "the
specified behavior is tested."
**Evidence:** the Bramble run does not report verified until the store round-trip + validation + persistence
and the web `@`-mention forks are covered by passing generated assertions.

### E4. Spec clauses trace to assertions.
**Outcome:** each behavioral spec clause maps to ≥1 generated assertion; coverage is measured against the
**spec**, not source lines.
**Evidence:** a clause→test map exists; an unasserted behavioral clause is flagged at plan/acceptance time.

---

## Fix locus (for the implementer)

- **Test generation:** generate behavioral `unit_tests` (and real `property_tests`) from the canonical
  clauses, not a fixed smoke template. The clauses are already canonicalized and behavior-altitude — they
  are the assertion source. Keep the smoke test as a floor.
- **Acceptance gate (harness):** evaluate **every** type in `evidence_policy.required`, surface each in the
  report, and refuse `✔ verified` when a required type is absent or unsatisfied — don't pass on
  typecheck + contract alone.
- **`evidence_policy` honesty:** a module must not *declare* evidence the pipeline won't produce. If
  `property_tests` can't yet be generated, it shouldn't sit in `required` as if satisfied.

## Provenance

Found in the runnable-Bramble loop after `BEHAVIOR-DRIVEN-CAPABILITY-phase1` landed and the app booted and
round-tripped (`implemented/`). The only generated tests were 16-line smoke tests per module; all real
behavior — the store round-trip + validation + persistence, and the web `@`-mention `create-reference` vs
`add-existing` fork, `[N]` badge, and backlinks — was covered solely by manual verification. Compounds
`STUB-FALLBACK-ACCEPTANCE-DIAGNOSIS.md` (`partial/`) and the project's BDD/TDD principle (every feat lands
with ≥1 test mapping onto a spec block). See `OBSERVABILITY-HARNESS-OUTCOMES.md` for the acceptance gate.
