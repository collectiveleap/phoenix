# Phoenix: runtime internal interface contracts — outcomes, evidence & the dialect seam

## Context

Phoenix governs three of four boundary quadrants (internal/external × static/runtime): internal-static
(`code.allowed_ius`, via the import graph), external-static & external-runtime (`side_channels`, env
contract, preflight). The empty quadrant — an **internal runtime interface** (a sibling module reached over
the wire, not via import) — had no contract, so a consumer could invent an address the provider doesn't
serve: the opus web-ui `fetch`ed `/operations` while the store mounted at `/bramble-store`, 404-ing its own
backend while both halves worked in isolation (`CROSS-MODULE-CONTRACT-DIAGNOSIS.md`).

This work promotes the interface registry to a first-class **interface contract** and applies the same
discipline Phoenix uses for external entities — **declare → generate-against → verify → invalidate** — to
the internal runtime edge.

### Architecture-neutral by construction (the dialect seam)

The four boundary operations generalize across transports; the *representation* does not. REST addresses
operations by `{method, path}` + `fetch(url)`; an all-in-browser P2P / no-REST target addresses them by
**name** (exported fn, RPC method, message topic, CRDT collection) — no URLs, no `/` paths. So the **core**
owns a transport-neutral contract (`InterfaceContract` = identity + named `operations` + `contract_hash`)
and the declare/verify/invalidate machinery, while every transport-specific concept lives behind an
**`InterfaceDialect` on `RuntimeTarget`** (alongside `moduleTemplate`/`promptExtension`). REST is the first
dialect (= the Bramble fix). A target with no runtime decoupling supplies no dialect and degrades to the
internal-static boundary.

## Outcomes & evidence of success

### C1. The consumer is bound to the contract — never an invented address.
**Outcome:** consumer calls are generated from the contract (a generated typed client) and any
mis-addressed call is deterministically repaired to a declared operation when resolvable.
**Evidence:** `restDialect.bindConsumer` rewrites `/operations` → `/bramble-store` (single provider / alias);
`generateClient` emits a typed wrapper over the declared operations. (`rest-dialect.test.ts`)

### C2. The contract is injected into consumer generation.
**Outcome:** the web-ui prompt lists each provider's declared operations via `dialect.describeForPrompt`,
with "use ONLY these declared operations."
**Evidence:** `buildPrompt` emits the dialect description for each sibling (REST: absolute routes).

### C3. A cross-module mismatch is caught at the gate, not shipped.
**Outcome:** the acceptance gate statically verifies every consumer call resolves to a declared operation;
an unresolved call fails the run (never `✔ verified`). Ties to `STUB-FALLBACK-ACCEPTANCE-DIAGNOSIS.md`.
**Evidence:** `checkInterfaceContracts` flags a web-ui calling an unserved address; a `cross-module-contract`
check is added to the acceptance result and folded into run `ok`. (`contract-check.test.ts`, run.ts)

### C4. (Headline) The generated app's UI talks to its backend.
**Outcome:** the running app round-trips an operation through the consumer's own calls and persists it — no
manual fix.
**Evidence:** the Bramble `/operations` vs `/bramble-store` case is now auto-repaired and gate-verified.

### Provider conformance.
**Outcome:** each provider must implement its declared operations (symmetric enforcement).
**Evidence:** `checkInterfaceContracts({checkProviders:true})` flags a provider missing a declared op.

### Contract-bearing edges + selective invalidation.
**Outcome:** the consumer→provider runtime dependency is a real graph edge; a change to a provider's
contract invalidates and regenerates its consumers.
**Evidence:** `planIUs` sets a web-ui IU's `dependencies` to its sibling api IUs (was always `[]`); a changed
provider `contract_hash` moves the consumer from completed→pending on resume. (`contract-invalidation.test.ts`)

### Architecture generality (the load-bearing proof).
**Outcome:** nothing transport-specific leaks into the core.
**Evidence:** a fake **non-REST topic dialect** (operations by name, no URLs) drives the same
`checkInterfaceContracts` + `bindConsumer` to the same outcomes. (`interface-contract-dialect.test.ts`)

## Fix locus / files
- `src/models/interface-contract.ts` — neutral `InterfaceContract`/`OperationSpec`/`OpRef`/`InterfaceDialect`.
- `src/models/architecture.ts` — `interfaceDialect` on `RuntimeTarget`.
- `src/architectures/dialects/rest.ts` — the REST dialect (routes, fetch client, extraction, repair).
- `src/scaffold.ts` — registry builds contracts via the dialect; emits the typed client.
- `src/llm/prompt.ts` (C2), `src/regen.ts` (C1 bind + consumed-contract recording).
- `src/harness/contract-check.ts` + `src/harness/run.ts` (C3 + provider conformance, wired into the gate).
- `src/iu-planner.ts` (edges), `src/harness/resume.ts` + `src/models/manifest.ts` (invalidation).

## Provenance
The final gap after the generation arc: the module generates (OP1–OP5) and boots, but the internal runtime
boundary was unmodeled. See `CROSS-MODULE-CONTRACT-DIAGNOSIS.md` (the bug),
`STUB-FALLBACK-ACCEPTANCE-DIAGNOSIS.md` (verified-means-works), and the PRD provenance-edge /
selective-invalidation thesis (§0, §7). The dialect seam keeps a future P2P/no-REST target a first-class path.
