# Phoenix: behavior-driven capability & contract — phased (Phase 1 = minimal runnable Bramble)

Combines and supersedes the two prior notes (`MODULE-ROLE-PROXY-DIAGNOSIS.md` and
`REST-CLIENT-CRUD-DEFAULT-DIAGNOSIS.md`), re-cut into dependency-ordered phases. **Phase 1 is the minimal
set needed to get a runnable Bramble**; Phases 2–3 generalize the same principle to atypical modules and
non-web architectures and are **not on the critical path for this app**.

## Root cause (one paragraph)

Phoenix derives most structure from behavior, but a few capability decisions branch on a **module role**
that is a hardcoded two-value taxonomy (`'api' | 'web-ui'`), assigned by a **regex on the module's name**,
in architecture-agnostic code (`scaffold.js:22-23`, `iu-planner.js:121`, default `:193`). From that one
label flow: the generating **model** (`resolve.js:195`, `api ⇒ sonnet`), the **interface contract's
operation set** (`api ⇒ CRUD`), and even the **decomposition** (a hardcoded flat 2-layer web-ui→api graph,
`iu-planner.js:122-128`). Separately, the generated interface client is emitted **untyped**. The principle
across all of it: *behavior supplies a module's operations/capabilities; the architecture supplies the
decomposition (topology) and the dialect (representation); neither should be inferred from a module's name.*

## Evidence anchor (the Bramble runs)

- Laden Bramble (intended op-log design, `tmp/`, run `run-20260608-153034-faef56`): both modules generated;
  acceptance **failed** on `typecheck: 5` implicit-`any` in `_client.ts` **and** `cross-module-contract`
  (`update`/`remove` not implemented).
- Neutral time-travel spec (`tmp-neutral/`, run `run-20260608-222537-7d0869`, store forced to opus): both
  generated; acceptance **failed** on the **same two**.
- No run has passed the gate, and none has been booted to the project's real bar (boots + UI round-trips +
  persists + replays).

---

## Phase 1 — Minimal to a runnable Bramble  ⟵ DO THIS FIRST

**Scope:** the intended Bramble uses the standard web-ui→api topology and the REST dialect, and its store is
small (generated fine on sonnet). So Phase 1 needs **only** the contract + typing fixes — no model-selection
or topology generalization. These are the only two acceptance blockers for `tmp/`.

### P1.1 — The interface contract's operation set is the provider's declared operations, not a fixed CRUD set.
**Outcome:** the operations checked at the gate (and emitted into the client) come from what the provider's
behaviors declare — an append-only store yields `list` + `append`, never `get`/`update`/`remove` it doesn't
have. (Was `REST-CLIENT-CRUD-DEFAULT` R1/R2; `MODULE-ROLE-PROXY` M2, operation-set half.)
**Evidence of success:** the Bramble run's `cross-module-contract` check passes — no "does not implement
update/remove"; the generated client exposes only the store's real operations.
**Fix locus:** the REST dialect's contract/client generation (`scaffold.js:33` + the registry that builds
contracts) must read the operation set from the module's declared capabilities. Carry a real `operations`
list on the IU contract (absent in `ius.json` today) and generate client + provider-conformance from it.

### P1.2 — The generated interface client typechecks (typed parameters, no implicit-`any`).
**Outcome:** the generated `_client.ts` is emitted with typed parameters (derived from the operation specs),
so it raises zero `TS7006` errors under the strict tsconfig Phoenix itself writes. A "do not edit" artifact
must never fail Phoenix's own typecheck gate. (Was `REST-CLIENT-CRUD-DEFAULT` R3.)
**Evidence of success:** `tsc --noEmit` over the generated project reports 0 errors from `_client.ts`; the
acceptance typecheck gate passes. (May fall out of P1.1 if the contract carries typed operations — but it is
its own guarantee.)
**Fix locus:** the client emitter — type each operation's parameters from the operation spec.

### P1.3 — Verified end-to-end (the project's real bar), not merely gate-green.
**Outcome:** a `phoenix run` on the laden Bramble spec produces an app that **boots, serves the page, and
round-trips**: an edit persists through the store and replays on reload.
**Evidence of success:** booted server serves `GET /`; the page's own fetches list/append against the store
(no 404); typing appends an op visible on reload after a restart. (Ties to
`STUB-FALLBACK-ACCEPTANCE-DIAGNOSIS.md` / `CROSS-MODULE-CONTRACT-DIAGNOSIS.md`: "verified" must mean works.)

**Phase 1 exit criteria:** `phoenix run` on the intended Bramble spec → acceptance **green** *and* a manual
boot round-trips an edit and replays it on reload, with **no env overrides and no hand-edited generated
files**.

---

## Phase 2 — Capability (model) selection from behavior

Needed for **atypical-but-still-2-tier** apps (e.g. the neutral event-sourced store), **not** for the laden
Bramble (whose store is small and generated fine on sonnet).

**See `MODEL-DEFAULT-COUPLING-DIAGNOSIS.md` (a parallel note) — it already owns the model-selection axis**
from the `web-ui → opus` side: remove the blanket role→model *default*, keep the per-module selection
*mechanism*. This phase does **not** restate that; it adds the complementary `api` side and one open
question.

### P2.1 — Decide the model from the module's behaviors, not its name-matched role.
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

---

## Phase 3 — Decomposition & dialect generality (architecture-neutral)

Needed for **non-web architectures** (CLI, library, DXOS in-browser P2P, layered services). Not on the
critical path for this app.

### P3.1 — Module characterization is not a hardcoded, name-matched two-bucket proxy.
**Outcome:** a module's kind is derived from behavior and/or the architecture's own module-kind vocabulary —
not a global `'api' | 'web-ui'` regex on the name. (Was `MODULE-ROLE-PROXY` M3.)
**Fix locus:** `iu-planner.js:121` / `scaffold.js:22-23`.

### P3.2 — Decomposition is an arbitrary module graph supplied by the architecture, not a fixed 2-layer split.
**Outcome:** the partition into modules and the boundaries between them — *how many, how deep, what kind* —
is an architecture decision: no boundary (single-process CLI/library), a single consumer↔provider, N-tier
with a dual-role middle module, a general DAG, or symmetric peers (P2P). Today the planner produces only a
**flat 2-layer bipartite graph** — web-ui→api with api always leaves (`iu-planner.js:122-128`, the
`continue` for non-web-ui) — so layering, dual-role, no-boundary, and peer-symmetric are inexpressible;
fan-out is the only freedom.
**Fix locus:** `iu-planner.js:116-129` — let the architecture declare the topology; stop hardcoding the
web-ui→api edge.

### P3.3 — Interface dialect generality.
**Outcome:** the contract's operations (Phase 1) are represented per the architecture's **dialect** — HTTP
routes (REST), named calls (CLI/in-process), message topics / CRDT collections (P2P/DXOS) — and a target
with no runtime decoupling supplies no dialect and degrades to the internal-static (import) boundary.
**Evidence of success:** the same behavior-derived operation set drives a non-REST dialect to a coherent
contract with no HTTP/CRUD assumption. (Builds on the dialect seam in `INTERFACE-CONTRACT-OUTCOMES.md`.)

---

## Provenance

Re-cut from `MODULE-ROLE-PROXY-DIAGNOSIS.md` + `REST-CLIENT-CRUD-DEFAULT-DIAGNOSIS.md` (both folded in here)
after establishing that **Phase 1 alone unblocks a runnable Bramble** while M1/M3/topology are real but
off-critical-path gaps. Found via a differential-probing experiment on an architecture-neutral Bramble spec:
persistence design correctly tracked behavior (mutable → append-only log + fold as history-dependent
behaviors were added), proving behavior-driven inference already works — while model, contract, and
decomposition routed through a name-matched role. See also `WEBUI-WATCHDOG-STICKY-STALL-DIAGNOSIS.md`,
`PREFLIGHT-TYPECHECKER-DIAGNOSIS.md` (both fixed), `STUB-FALLBACK-ACCEPTANCE-DIAGNOSIS.md`,
`CROSS-MODULE-CONTRACT-DIAGNOSIS.md`, `INTERFACE-CONTRACT-OUTCOMES.md`.
