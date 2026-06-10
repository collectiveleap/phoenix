# Phoenix: contract operations + typed client from behavior — Phase 1 (minimal runnable Bramble)

One of three per-phase notes (siblings: `BEHAVIOR-DRIVEN-CAPABILITY-phase2.md`,
`BEHAVIOR-DRIVEN-CAPABILITY-phase3.md`). **This phase is the only one on the critical path to
a runnable Bramble** — Phases 2–3 generalize the same principle and are not needed for this app.

## Root cause (shared across the three phases)

Phoenix derives most structure from behavior, but a few capability decisions branch on a **module role** —
a hardcoded two-value taxonomy (`'api' | 'web-ui'`) assigned by a **regex on the module's name**
(`scaffold.js:22-23`, `iu-planner.js:121`, default `:193`). The principle: *behavior supplies a module's
operations/capabilities; the architecture supplies the decomposition (topology) and dialect (representation);
neither should be inferred from a module's name.* This phase fixes the slice of that which blocks a runnable
Bramble: the **interface contract's operation set** (`api ⇒ CRUD`) and the **untyped generated client**.

## Evidence anchor (the Bramble runs)

- Laden Bramble (intended op-log design, `tmp/`, run `run-20260608-153034-faef56`): both modules generated;
  acceptance **failed** on `typecheck: 5` implicit-`any` in `_client.ts` **and** `cross-module-contract`
  (`update`/`remove` not implemented).
- Neutral time-travel spec (`tmp-neutral/`, run `run-20260608-222537-7d0869`): both generated; **same two**
  failures.
- No run has passed the gate, and none has been booted to the project's real bar.

---

## P1.1 — The interface contract's operation set is the provider's declared operations, not a fixed CRUD set.
**Outcome:** the operations checked at the gate (and emitted into the client) come from what the provider's
behaviors declare — an append-only store yields `list` + `append`, never `get`/`update`/`remove` it doesn't
have.
**Evidence of success:** the Bramble run's `cross-module-contract` check passes — no "does not implement
update/remove"; the generated client exposes only the store's real operations.
**Already shipped (build on, don't redo):** the cross-module-contract *check* and the interface-registry /
dialect machinery (`CROSS-MODULE-CONTRACT-DIAGNOSIS.md`, `INTERFACE-CONTRACT-OUTCOMES.md` — both in
`implemented/`). The check is exactly what surfaces this failure; the only gap is that the operation set fed
into it is a **CRUD template**, not behavior-derived.
**Fix locus:** the REST dialect's contract/client generation (`scaffold.js:33` + the registry that builds
contracts) must read the operation set from the module's declared capabilities. Carry a real `operations`
list on the IU contract (absent in `ius.json` today) and generate client + provider-conformance from it.

## P1.2 — The generated interface client typechecks (typed parameters, no implicit-`any`).
**Outcome:** the generated `_client.ts` is emitted with typed parameters (derived from the operation specs),
so it raises zero `TS7006` errors under the strict tsconfig Phoenix itself writes. A "do not edit" artifact
must never fail Phoenix's own typecheck gate.
**Evidence of success:** `tsc --noEmit` over the generated project reports 0 errors from `_client.ts`; the
acceptance typecheck gate passes. (May fall out of P1.1 if the contract carries typed operations — but it is
its own guarantee.)
**Fix locus:** the client emitter — type each operation's parameters from the operation spec.

---

## Exit criteria (verified in phoenix-bramble, not a Phoenix change)

The verify step below is **our work in the `phoenix-bramble` repo**, run against Phoenix's output — kept
here only as the phase's done-bar:

- `phoenix run` on the intended Bramble spec → acceptance **green** (P1.1 + P1.2 cleared), with **no env
  overrides and no hand-edited generated files**;
- a manual boot **round-trips**: the page serves at `GET /`, its own fetches list/append against the store
  (no 404), and an edit persists through a restart and replays on reload. (Ties to
  `STUB-FALLBACK-ACCEPTANCE-DIAGNOSIS.md` / `CROSS-MODULE-CONTRACT-DIAGNOSIS.md`: "verified" must mean works.)

## Provenance

Split from the combined `BEHAVIOR-DRIVEN-CAPABILITY-PHASED.md` (was `REST-CLIENT-CRUD-DEFAULT` R1/R2/R3 +
`MODULE-ROLE-PROXY` M2 operation-set half). Found via a differential-probing experiment on an
architecture-neutral Bramble spec; persistence design correctly tracked behavior while contract + client
typing did not. See siblings `…-phase2.md`, `…-phase3.md`.
