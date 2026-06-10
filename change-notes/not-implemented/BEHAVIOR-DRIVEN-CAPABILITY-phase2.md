# Phoenix: model selection from behavior, not the role label — Phase 2 (off critical path)

One of three per-phase notes (siblings: `BEHAVIOR-DRIVEN-CAPABILITY-phase1.md`,
`BEHAVIOR-DRIVEN-CAPABILITY-phase3.md`). **Not needed for a runnable Bramble** — the intended
store is small and generated fine on sonnet. This phase matters for **atypical-but-still-2-tier** modules
(e.g. the neutral event-sourced store, which only completed on opus).

## Root cause (shared)

A few capability decisions branch on a name-matched `api`/`web-ui` role instead of behavior (see
`…-phase1.md` for the shared root cause). Here the decision is **which model generates the
module**: `resolve.js:195` maps `api ⇒ sonnet` (*"CRUD/API modules stay on the fast workhorse"*).

**See `MODEL-DEFAULT-COUPLING-DIAGNOSIS.md` — it already owns the model-selection axis** from the
`web-ui → opus` side (remove the blanket role→model *default*, keep the per-module selection *mechanism*).
This note does **not** restate that; it adds the complementary `api` side and one open question.

---

## P2.1 — Decide the model from the module's behaviors, not its name-matched role.
**Outcome:** model selection reads the module's behaviors (CRUD rows vs. reconstructs past states / folds a
log / enforces invariants), so a non-CRUD `api` module is not forced onto the fast workhorse. (Was
`MODULE-ROLE-PROXY` M1.)
**Open question this experiment surfaced** (for whoever takes `MODEL-DEFAULT-COUPLING`): a *model-neutral
default* (all modules → the single resolved model, e.g. sonnet) would have **re-broken the event-sourced
store**, which only completed on opus. So "remove the over-fit default" and "complex modules need the
capable model" are in tension — the resolution is a **behavior-derived** signal (module complexity /
invariants / state-reconstruction), not a name and not a flat default either way.
**Evidence of success:** the Bramble append-only/event-sourced store generates to completion with **no
`PHOENIX_LLM_MODEL_API` override**; a genuinely simple CRUD api module still gets the fast model; renaming a
module doesn't change which model generates it.
**Fix locus:** `resolve.js` `resolveModelsByRole` (`:195`) — drive from the behavior-derived
characterization; keep `PHOENIX_LLM_MODEL_API` as an override, not the only escape.

## Provenance

Split from the combined `BEHAVIOR-DRIVEN-CAPABILITY-PHASED.md` (was `MODULE-ROLE-PROXY` M1). Surfaced when the
neutral event-sourced store ran away on sonnet (the default for its name-derived `api` role) and only
completed once forced to opus. Complements `MODEL-DEFAULT-COUPLING-DIAGNOSIS.md`.
