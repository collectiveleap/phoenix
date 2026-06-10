# Phoenix: decomposition & dialect from architecture, not module name — Phase 3 (off critical path)

One of three per-phase notes (siblings: `BEHAVIOR-DRIVEN-CAPABILITY-phase1.md`,
`BEHAVIOR-DRIVEN-CAPABILITY-phase2.md`). **Not needed for a runnable Bramble** (which uses the standard
web-ui→api + REST shape). This phase matters for **non-web architectures** — CLI, library, DXOS in-browser
P2P, layered services.

## Root cause (shared)

Capability/structure decisions branch on a name-matched `api`/`web-ui` role instead of behavior or
architecture (see `…-phase1.md`). Here the over-reach is the **decomposition itself**: the role is a
hardcoded two-bucket name regex, and the planner hardwires a single topology. The principle: *behavior
supplies a module's operations; the **architecture** supplies the decomposition (topology) and the dialect
(representation); neither comes from a module's name.*

---

## P3.1 — Module characterization is not a hardcoded, name-matched two-bucket proxy.
**Outcome:** a module's kind is derived from behavior and/or the architecture's own module-kind vocabulary —
not a global `'api' | 'web-ui'` regex on the name. (Was `MODULE-ROLE-PROXY` M3.)
**Fix locus:** `iu-planner.js:121` / `scaffold.js:22-23`.

## P3.2 — Decomposition is an arbitrary module graph supplied by the architecture, not a fixed 2-layer split.
**Outcome:** the partition into modules and the boundaries between them — *how many, how deep, what kind* —
is an architecture decision: no boundary (single-process CLI/library), a single consumer↔provider, N-tier
with a dual-role middle module, a general DAG, or symmetric peers (P2P). Today the planner produces only a
**flat 2-layer bipartite graph** — web-ui→api with api always leaves (`iu-planner.js:122-128`, the
`continue` for non-web-ui) — so layering, dual-role, no-boundary, and peer-symmetric are inexpressible;
fan-out is the only freedom.
**Fix locus:** `iu-planner.js:116-129` — let the architecture declare the topology; stop hardcoding the
web-ui→api edge.

## P3.3 — Interface dialect generality.
**Outcome:** the contract's operations (Phase 1) are represented per the architecture's **dialect** — HTTP
routes (REST), named calls (CLI/in-process), message topics / CRDT collections (P2P/DXOS) — and a target
with no runtime decoupling supplies no dialect and degrades to the internal-static (import) boundary.
**Evidence of success:** the same behavior-derived operation set drives a non-REST dialect to a coherent
contract with no HTTP/CRUD assumption. (Builds on the dialect seam in `INTERFACE-CONTRACT-OUTCOMES.md`, in
`implemented/`.)

## Provenance

Split from the combined `BEHAVIOR-DRIVEN-CAPABILITY-PHASED.md` (was `MODULE-ROLE-PROXY` M2 decomposition half
+ M3). The decomposition limits were confirmed in the planner: `iu-planner.js:122-128` gives every web-ui
module a dependency on its service's api modules and `continue`s for api modules so they are always leaves —
a fixed flat 2-layer bipartite graph. See siblings `…-phase1.md`, `…-phase2.md`.
