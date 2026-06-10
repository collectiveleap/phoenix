# Phoenix: generation reliability — model selection, bounds & diagnosis — outcomes & evidence

## Context

The large Web Experience (inline-HTML SPA) module has failed to generate three distinct ways on the same
module (buffering → token ceiling → runaway/stall; see `LARGE-MODULE-GENERATION-DIAGNOSIS.md`). Each prior
fix tuned call-level mechanics; the module still doesn't build. This doc captures the **scoped, testable
outcomes** that move toward actually building it — distilled from that diagnosis plus new evidence below —
and deliberately defers the speculative parts until the evidence justifies them.

### Root finding (confirmed by direct test + external research)

`CLAUDE_CODE_MAX_OUTPUT_TOKENS` does **not** bound total `claude -p` output:

- **Direct probe (sonnet, this machine):** cap=256 → ~826 output tokens (3.2× over), ended
  `stop_reason: stop_sequence`; the diagnosis §C probe: cap=1500 → ~5998 tokens (4× over), `stop_sequence`.
- **Why (Anthropic docs):** the env var is a **per-request (per-turn)** cap, not a session cap
  (`code.claude.com/docs/en/env-vars`, `platform.claude.com/docs/en/build-with-claude/task-budgets`). The
  agent loop **auto-continues across turns** until the model produces a turn with no tool calls, injecting
  a continuation after a per-turn output limit (`agent-sdk/agent-loop`, gh `anthropics/claude-code#24159`).
  So total output is unbounded; the terminal `stop_reason` is the *last* turn's (`end_turn`/`stop_sequence`),
  which is why the `max_tokens`-keyed truncation detection (T2/T3) is **inert on claude-cli**.
- **The only documented loop bounds** are `max_turns` and `max_budget_usd` (both default *no limit*); plus the
  widely-recommended external **wall-clock timeout** (amux headless guide). On our CLI (2.1.160),
  `--max-budget-usd` is exposed; `--max-turns` is **not** a `-p` flag (`maxTurns` exists only internally).
- **Honest caveat:** the loudest community reports are the *inverse* symptom — output clamped *too small* at
  ~32K with `stop_reason: max_tokens` on Opus 4.6 (tied to the ~31,999 thinking budget; gh #29488, #24159,
  #10738). Our regime (sonnet, low caps, output *too large*, `end_turn`) is consistent with the documented
  architecture but not independently reproduced by any source. gh #25629 (hang after the final `result`
  event, stdout open, needs SIGKILL) matches our stall tail (version-pinned to 2.1.38).

### Implication

The env-var path is a dead end. Bounding must be **Phoenix-side** (wall-clock + byte), the most likely
*completion* fix is **a more capable model on the hard module**, and we still cannot tell **bloat vs.
genuine size** without **capturing the actual output** — which no current run does. The four outcomes below
make the problem testable, give us the model lever, fix a stale default, and bound + capture runaways.

---

## Outcomes & evidence of success (Phoenix POV)

### G1. A single module can be regenerated and inspected on demand.
**Outcome:** A developer can regenerate one named module in isolation — without a full `phoenix run` — and
see exactly what the model produced: the raw output (even on failure), its byte size, wall-clock duration,
and terminal stop reason. Reproducing the large-module behavior takes a minute, not a full pipeline.
**Evidence of success:**
- One command regenerates just `Web Experience` and writes the produced bytes to an inspectable path, even
  when the call was bounded or failed.
- It reports the call's output size, duration, and terminal stop reason.
- It skips ingest/plan/scaffold/acceptance — fast and repeatable.
*(Builds on the existing `phoenix regen --iu=<id>` path; the new part is capturing the raw output and the
size/duration/stop-reason readout.)*

### G2. The generation model is selectable per module.
**Outcome:** The model can be chosen per module — with a role-based default — so a high-capability model
handles the hard/large (web-ui) module while a faster, cheaper model handles the simple CRUD/API modules,
in a single run, without flipping a global switch.
**Evidence of success:**
- In one run, the web-ui module generates on Opus while API modules generate on Sonnet.
- Which model produced which module is visible in plan/run output and recorded per-module (journal/manifest).
- Selection is configurable (role default + explicit per-module override) and falls back to the resolved
  default when unset.

### G3. Provider model defaults are current, not stale.
**Outcome:** No provider silently generates with an out-of-date model; the default is the intended current
model and the resolved model is always surfaced so staleness is catchable.
**Evidence of success:**
- The anthropic provider default is a current model (today it is pinned to `claude-sonnet-4-20250514` ≈
  Sonnet 4.0, ~13 months old).
- The in-use model is printed at run/plan time (the existing O6 resolution readout) and is verifiably current.
- A test asserts the shipped defaults match the intended current IDs (the next drift fails CI, not a run).

### G4. Generation calls are bounded, and a runaway is captured and diagnosable.
**Outcome:** Every generation call is bounded by Phoenix's *own* wall-clock and output-size budgets
(independent of the provider's unenforced cap). A call exceeding a bound is stopped within the budget,
recorded as "exceeded generation bounds" with the cause, and its partial output is preserved — never a
20-minute unbounded runaway, never a silent retry-into-stub. The journal alone distinguishes bloat from
genuine size afterward.
**Evidence of success:**
- A call exceeding the byte or time budget is aborted within the budget (minutes, not 20+ min) and the
  partial output is written to an inspectable path.
- The journal records that call's byte timeline, duration, and terminal reason — reconstructable post-hoc
  with no live capture (closes the instrumentation gap that made this hard to debug).
- An over-bound module **hard-fails with a remediation** (not a stub) and is **not retried** (deterministic,
  like the existing truncation path).
- A bounds-exceeded call is distinguishable in the record from a stream-stall — different cause, different
  label.

---

## Sequencing toward building Bramble

- **G1 + G4 are the unblockers:** together they turn the opaque 20-min / 4-retry / stub failure into a fast,
  captured, inspectable artifact — the only thing that settles *bloat vs. genuine size*.
- **G2 is the most likely actual fix** (Opus on the one hard module) — validated *with* G1/G4, not blind.
- **G3 is hygiene** — cheap; do it alongside G2 since both touch model resolution.

## Deliberately deferred

- **Continuation / plan-split generation** (the L-series "L3"): only build it if G1/G4 show the module is
  *genuinely* too large for one call, not bloat. Until then it is speculative.
- **`--max-budget-usd` as a Claude-native backstop:** optional; G4's Phoenix-side bound is the primary
  mechanism (provider-agnostic and deterministic).

## Provenance

Distilled while finishing "Bramble," after the large Web Experience module failed a third way (runaway/stall)
and a strategic review asked which outcomes actually serve *building Bramble* vs. failure-hygiene. The root
finding was confirmed by a direct cap probe and a multi-source research pass (Anthropic docs +
`anthropics/claude-code` issues). See `LARGE-MODULE-GENERATION-DIAGNOSIS.md` (the failure),
`TOKEN-BUDGET-DIAGNOSIS.md` (T2/T3, inert here), `STUB-FALLBACK-ACCEPTANCE-DIAGNOSIS.md` (why this was
mislabeled "verified"), and `OBSERVABILITY-HARNESS-OUTCOMES.md` (the journal G4 extends).
