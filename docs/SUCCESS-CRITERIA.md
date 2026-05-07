# Phoenix — Success Criteria

This document is the charter. It states the headline outcome Phoenix must achieve, the strict durable / ephemeral boundary that supports it, the principles that guide design choices, and the rule every future iteration must answer to.

For the user-facing "why" — the deeper motivation behind these technical commitments — see [`sanderson.md`](sanderson.md).

---

## The Headline Outcome — The Deletion Test

> **For every supported combination of architecture and runtime target, the complete flow (using an LLM with all ephemeral assets deleted) from durable spec to running code passes the evals. The same set of evals used in any combination will prove correctness regardless of architecture and runtime target.**

This is the canonical correctness oracle for Phoenix. When the deletion test passes for a given `(architecture, runtime)` combination, Phoenix has empirically proven that the system can be regenerated from durable artifacts and behave correctly.

When the deletion test does *not* yet pass for a combination, that combination is either:
- Not yet implemented, or
- Failing in a specific evaluation (which is a real, locatable defect).

The deletion test is not aspirational. It is the gate.

### Verified passes

| Architecture | Runtime target | Date | Run time | Notes |
|---|---|---|---|---|
| `web-api` | `node-typescript-stdlib` | 2026-05-06 | 2547s (~42 min) | **Suspect — needs re-verification after silent-fallback hardening lands.** First green run, but predates `regen_metadata.fell_back` so we cannot tell whether it passed from real LLM output or stub fallback. The 2026-05-06 `node-typescript` run exposed the silent-fallback bug (Web Experience IU stubbed after 64-min `claude` ETIMEDOUT while manifest claimed `claude-cli/sonnet`). Same pattern may have hidden in this run. |

## The Durable / Ephemeral Boundary

Strict: only spec and evals are durable. Everything else regenerates from them.

| Path | Status | Notes |
|---|---|---|
| `spec/*.md` | **durable** — Specification primitive | Source of truth |
| `evals/*.feature` | **durable** — Evaluation primitive | Surface-agnostic Gherkin scenarios |
| `docs/SUCCESS-CRITERIA.md` (this file) | **durable** — Charter | Frames the contract |
| `docs/sanderson.md` | **durable** — Manifesto | User-facing "why" |
| All of `.phoenix/` | **ephemeral** | Canonical graph, IU plan, manifests, state, config — derived |
| `src/` (all of it) | **ephemeral** | Generated code + scaffold + runtime files |
| `package.json`, `tsconfig.json`, `vitest.config.ts`, `pnpm-lock.yaml` | **ephemeral** | Project config |
| `node_modules/`, `data/` | **ephemeral** | Install + runtime data |

The deletion-test reset deletes everything ephemeral and runs `phoenix init / bootstrap / regen` (real LLM, no stubs) from scratch.

## Fowler's Four Primitives

Per the Phoenix Architecture essays ([Phoenix Primitives](https://aicoding.leaflet.pub/3mjfruwwuck2d), [Evaluations Are the Real Codebase](https://aicoding.leaflet.pub/3mb526js42k26)), four artifacts are irreducible:

| Primitive | Where it lives in this repo |
|---|---|
| **Specification** | `spec/*.md` |
| **Evaluation** | `evals/*.feature` |
| **Context Boundary** | Implicit in IU boundary policies; encoded by the architecture's `evaluationSurface` |
| **Provenance** | `.phoenix/store/objects/` (durable as historical record; not preserved across deletion-test runs because it accrues, not survives) |

## Three Foundational Principles for the Eval System

These shape how the eval suite grows. They're extracted from converging sources: TDD, Lean Startup's validated learning, Charity Majors's "test in prod or live a lie," Chad Fowler's "Production Is a Compiler Input," and the user's direct experience monitoring login-funnel baselines at Food on the Table 2010-12.

### Principle 1: Evals grow incrementally, not exhaustively

The eval set is intentionally sparse. Subsequent evals enter when:
- Something fails (incident-driven)
- Production / workflow observation surfaces a stable behavioral pattern (observation-driven)
- A spec change introduces a new domain concept (spec-driven)

Authoring a comprehensive eval suite up-front is speculative work. The discipline is to add evals on demand.

### Principle 2: Production observation is an eval source

Static evals authored by humans (`origin: 'specified'`) are layer 1.

Layer 2 (queued, future iteration) inverts authoring: behavior is observed → patterns detected → candidate evals suggested in canonical / domain terms → human accepts → eval becomes durable.

The Evaluation model reserves `origin: 'observed'` for layer-2-generated evals.

### Principle 3: Evals are the cutover ratchet

Each accepted eval is a permanent constraint on future regenerations. Coverage of evals against the current implementation's observed-behavior surface IS the confidence-to-cutover metric — for the strangler pattern applied to code OR socio-technical OR hybrid current implementations.

## The Long Arc — Strangler-Pattern Roadmap

Phoenix's headline operational use case: safely progressively replace any current implementation — code, socio-technical workflow, or hybrid — with regenerated implementations, using durable evals as the cutover criterion.

| Iter | Capability | Strangler relevance |
|---|---|---|
| 12 | Evaluation primitive exists; deletion-test proves the closed loop on greenfield | Foundation. The eval shape supports every iteration below. |
| 13 | Production observation source; auto-suggested evals from observed patterns | Watching the current implementation's outcomes; precondition for characterization (code, manual workflow, or hybrid) |
| 14 | Shadow mode: dual-route, capture both current and new outcomes, surface divergences | The strangler primitive itself; works for code-shadow OR workflow-shadow |
| 15 | Eval coverage metric + progressive shift gated by eval pass rate | The cutover ratchet |
| 16 | Retirement criteria for the current implementation | The strangler completes |
| 17+ | Ensemble agents for scaling eval coverage growth | Scales the human-acceptance bottleneck |

Each iteration must serve this arc. The trajectory rule below is the mechanism that keeps that true.

## Trajectory Rule for Future Iterations

Every iteration plan from iter 12 onward opens with a **Trajectory check** section answering:

```
- Advances:        [yes — how it makes the deletion test more robust, broader, or stricter]
- Preserves:       [yes — how the iteration keeps the deletion test passing without changing it]
- Off-trajectory:  [yes — explicit justification for why the iteration is valuable despite not advancing or preserving the deletion test; requires explicit user approval]
```

If an iteration is "off-trajectory," that's allowed — but it must be named, not slipped in. Most iterations should "Advance" or "Preserve."

The deletion test is the canonical correctness oracle. The trajectory rule is the meta-rule that keeps every iteration accountable to it.

## What Phoenix's Substrate Commitments Are

These commitments fall out of `sanderson.md`'s collective-leap rationale:

1. **Plain text in version-controllable formats.** `spec/*.md`, `evals/*.feature`. The user can `tar` and email them. No proprietary database, no cloud-only artifact.
2. **Surface-agnostic and architecture-independent evals.** Evals describe domain behavior, not HTTP paths or CLI invocations. The same eval works whether the implementation is code, manual workflow, or hybrid.
3. **Durable artifacts belong to the user.** Spec and evals are owned at the edge. Everything ephemeral can be supplied by anyone — and swapped when alignment shifts.
4. **Local-first observation.** Future production-observation pipelines (iter 13+) must respect that telemetry doesn't leak the user's data to centralized platforms.

## Sources Cited

- Phoenix Architecture essays — Chad Fowler, [aicoding.leaflet.pub](https://aicoding.leaflet.pub)
  - [Evaluations Are the Real Codebase](https://aicoding.leaflet.pub/3mb526js42k26)
  - [The Phoenix Primitives](https://aicoding.leaflet.pub/3mjfruwwuck2d)
  - [Compile to Architecture](https://aicoding.leaflet.pub/3mgfsrk75ac2l)
  - [The Deletion Test](https://aicoding.leaflet.pub/3md5ftetaes2e)
  - [The Regenerative Grain](https://aicoding.leaflet.pub/3mfai4nqg6224)
  - [Production Is a Compiler Input](https://aicoding.leaflet.pub/3mjx4erlboc2l)
- "Test in prod or live a lie" — Charity Majors, Honeycomb
- The Lean Startup — Eric Ries (validated learning, organizational immune system, innovation accounting)
- Food on the Table production-baseline monitoring — direct user experience (2010-2012)
- Throughlines — user's framework for incremental evolution of socio-technical systems
- Collective Leap — user's framework for preserving agency at the edge
- Cucumber / Gherkin — natural-language Given/When/Then test syntax
- Phoenix VCS PRD: `PRD.md`
