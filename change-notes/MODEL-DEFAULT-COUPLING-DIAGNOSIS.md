# Phoenix: the `web-ui → opus` default over-fits our situation — diagnosis & outcomes (do later)

## Headline

To make our one pathological large web-ui SPA generate (it ran away on Sonnet, completed on Opus), the
per-module model work (G2/OP) shipped an **opinionated default**: on `claude-cli`, every `web-ui` module is
sent to **Opus**. That bakes "our outliner needed Opus" into Phoenix as everyone's default — penalizing
specs (and the bundled examples) that generate fine on Sonnet. The *mechanism* (per-module model selection)
is generic and worth keeping; the *default* is the over-fit and should be removed.

## Evidence

- The default (`src/llm/resolve.ts`, `resolveModelsByRole`):
  ```ts
  if (providerName === 'claude-cli') {
    result['web-ui'] = 'opus';   // ← blanket: ALL web-ui modules, regardless of size
    result['api'] = 'sonnet';
  }
  ```
- Role is a **name heuristic**, not a real signal (`src/scaffold.ts:75`):
  `const isWebUI = /\b(web|ui|frontend|interface|page|dashboard)\b/.test(lowerName)` — keys off the section
  *name*, so `## Web Experience`/`## Dashboard` → Opus, while `## Editor`/`## Canvas` (also UIs) would miss
  the word list and stay on Sonnet. Neither "generic" nor "spec-says-web-ui" — just "name matches this list."
- **Regression for cases that didn't need Opus:** the reference `examples/todo-app` web-experience (~29 KB)
  generated fine on Sonnet (documented as under the runaway threshold; see
  `LARGE-MODULE-GENERATION-DIAGNOSIS.md` §E). With this default it now goes to Opus on claude-cli — slower,
  costlier, and subject to the 240 s first-content budget — for no benefit.
- Also coupled: `claude-cli`-only, hardcoded aliases `opus`/`sonnet`.

## What is generic (keep) vs over-fit (remove)

- **Keep (generic):** per-module/per-role model selection mechanism (G2); OP1 content-aware first-byte (a
  real bug fix); OP2's model-aware budget *keyed on the model* (Opus is genuinely slower to first content —
  a property of the model, not our app).
- **Remove (over-fit):** the blanket `web-ui → opus` default.

## Outcomes & evidence of success

### M1. The shipped default is model-neutral.
**Outcome:** `resolveModelsByRole` defaults to `{}` — all modules use the single resolved model (Sonnet)
unless the project opts in. No role gets a more expensive model by default.
**Evidence:** with no config/env, a web-ui module generates on the resolved default model; the drift/default
test asserts no built-in `web-ui → opus`.

### M2. Opus-for-web-ui is opt-in, per project.
**Outcome:** a project that needs Opus for its UI sets it in **its own** `.phoenix/config.json`
(`llm.modelsByRole: { "web-ui": "opus" }`) or `PHOENIX_LLM_MODEL_WEBUI=opus` — not in Phoenix's defaults.
**Evidence:** the outliner project carries this config; Phoenix core does not.

### M3. Bundled examples are unaffected.
**Outcome:** `examples/*` (todo-app) generate on Sonnet again — no surprise Opus cost/latency.
**Evidence:** running an example on claude-cli sends its web-experience to Sonnet (the resolved default).

### M4. (Optional, principled) Model escalation is signal-driven, not name-driven.
**Outcome:** instead of a name regex, escalate to a more capable model only for modules a real signal flags
as large — reuse the T4 plan-time "likely to exceed the output token budget" estimate
(`SPEC-SHAPE-FEEDBACK-OUTCOMES.md` F2 / `TOKEN-BUDGET-DIAGNOSIS.md` T4). Generic and self-adapting; no word
list, no blanket default.
**Evidence:** a module flagged over-budget at plan time is generated with the capable model automatically;
a small UI module is not.

## Fix options (priority order)

1. **Remove the blanket default (M1–M3).** `resolveModelsByRole` returns `{}` by default; keep config + env
   opt-in. Update the test that currently asserts `{ 'web-ui': 'opus', 'api': 'sonnet' }`. Add the opt-in to
   the outliner project's config (not Phoenix). Minimal, directly de-couples. **Recommended now.**
2. **Signal-driven escalation (M4).** Wire the T4 over-budget flag → capable-model selection, replacing the
   name heuristic for escalation. Larger; do only if automatic escalation is wanted back.

## Fix locus

- `src/llm/resolve.ts` (`resolveModelsByRole` default → `{}`).
- `tests/unit/per-module-model.test.ts` (the default-precedence test asserting the opus default).
- (M4 only) `src/iu-planner.ts` (T4 over-budget flag) → model pick in `src/regen.ts`.

## Provenance

Raised reviewing the per-module-model work (G2) and the Opus generation arc (OP1–OP5): defaulting all
`web-ui` modules to Opus on claude-cli was a fix for one large SPA generalized into a global default, which
over-specifies our situation into Phoenix and taxes specs/examples that generate fine on Sonnet. See
`GENERATION-RELIABILITY-OUTCOMES.md` (G2), `OPUS-WEBUI-GENERATION-DIAGNOSIS.md` (why Opus was tried), and
`LARGE-MODULE-GENERATION-DIAGNOSIS.md` (the Sonnet runaway that started it).
