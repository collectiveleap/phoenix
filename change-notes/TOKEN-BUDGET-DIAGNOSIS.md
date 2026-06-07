# Phoenix: output token budget for large modules — diagnosis, outcomes & evidence

## Headline

After the streaming fix (see `PROVIDER-STREAMING-DIAGNOSIS.md`) a large web-UI module streamed cleanly
but still failed to generate. Root cause:

- Module generation calls the LLM with a hardcoded **`maxTokens: 8192`** (`dist/regen.js:133/136/194`).
- A full inline-HTML web-UI module (the whole SPA) needs **more** than 8192 output tokens. The model
  generates up to the cap, **truncates**, and stops.
- The harness reads the post-cap silence as a **stream-stall**, kills the call, and **retries** — which
  is deterministically futile (every attempt hits the identical ceiling).

So the module is never completed: it is truncated at the token cap, the truncated code fails typecheck,
and after the retries exhaust it falls back to a stub.

This is the **legitimate** form of "module output is too large" — via the token budget, not the
output-buffering issue that was earlier (wrongly) blamed for the same symptom.

## Evidence

- **Hardcoded cap:** `dist/regen.js` — `callLLM(prompt, { …, maxTokens: 8192 }, …)` at lines 133 (template
  mode), 136 (freeform), 194 (repair).
- **The output froze at the cap:** across all four attempts the Web Experience call's `bytesStreamed`
  climbed `5981 → 32356` and then **stuck at exactly `32356 B`** until watchdog-killed. `8192 tokens ×
  ~3.95 chars ≈ 32360 B` — the freeze is the token ceiling, not a network stall.
- **Futile retries:** the run journal shows **4 attempts** for the module (`24 ok · 3 failed · 1 active`),
  each ending the same way — confirming the cap is deterministic, so retrying cannot help.
- **For contrast,** smaller modules (CRUD resources) and the reference `todo-app` web-experience (~29 KB,
  just under the cap) generate fine — they fit within 8192 tokens.

---

## Outcomes & evidence of success (Phoenix POV)

### T1. The output token budget fits the module being generated.
**Outcome:** module generation is not capped below what a module legitimately needs — `maxTokens` is
raised to (or scaled toward) the provider/model's real maximum (e.g. tens of thousands of tokens for
sonnet), or sized per module/architecture, so a normal web-UI module is not truncated.
**Evidence of success:**
- A module whose complete output is, say, 50–60 KB generates to completion (no freeze at ~32 KB).
- No generated module is silently truncated at a fixed byte ceiling.

### T2. A `max_tokens` truncation is recognized as truncation, not a stall.
**Outcome:** the provider parses the stream-json terminal event's `stop_reason`; when it is `max_tokens`,
the harness classifies the call as **completed-but-truncated (over budget)**, distinct from a stall.
**Evidence of success:**
- The journal records an outcome like `truncated`/`over_budget` (with `stop_reason: max_tokens`) for such
  a call — never `watchdog_kill`/`stall`.
- A truncated call is never killed as if silent; its real cause (hit the cap) is in the record.

### T3. A truncation is not retried; it is reported with the fix.
**Outcome:** hitting `max_tokens` is deterministic, so it is **not** retried. Instead the run reports the
module as "exceeds the output token budget" with an actionable remediation (raise the cap, or split the
spec section).
**Evidence of success:**
- The journal shows **one** attempt for an over-budget module, not N futile retries.
- The failure message names the cause and fix, e.g. *"Web Experience output exceeded the 8192-token
  budget — raise generate maxTokens or split the section."*

### T4. The plan/risk gate's output-size estimate has a real basis.
**Outcome:** the oversized-module flag (and the spec-shape feedback, F-series) can use a genuine *output*
size signal — a module whose expected output exceeds the token budget is flagged at **plan time**, before
generation burns attempts.
**Evidence of success:**
- A web-UI module specified to emit a large SPA is flagged as "likely to exceed the output token budget"
  at `plan`, with the same remediation as T3.
- This connects to (and gives an evidence basis for) `SPEC-SHAPE-FEEDBACK-OUTCOMES.md` F2 and the
  observability doc's O10 — which previously had only a *source-node-count* basis.

### T5. (Headline) A large web-UI module generates to completion.
**Outcome:** under `phoenix run`, a `node-typescript` web-UI module that emits a full inline-HTML SPA
larger than 8192 tokens generates completely (raised budget, or chunked/continued generation), passes
typecheck, and the acceptance gate boots it.
**Evidence of success:**
- `phoenix run` on a spec with a substantial web-UI section produces a **complete, non-stub** module whose
  byte size exceeds the old ~32 KB ceiling, and the acceptance gate passes.
- The run journal shows that module's call ending with a normal completion (`stop_reason: end_turn`), not a
  truncation or a kill.

---

## Fix options (for the implementer)

1. **Raise `maxTokens`** for module generation (`dist/regen.js`) to the model's real maximum, or make it
   configurable per architecture. Simplest; resolves T1/T5 directly.
2. **Honor `stop_reason`** in the provider's stream-json parse so the harness can tell truncation (T2)
   from a stall, stop futile retries (T3), and report the real cause.
3. **Continuation/chunking** for modules that exceed even a raised cap (continue the generation across
   calls), the most robust path for very large modules.
4. **Output-size estimate** at plan time (T4) so over-budget modules are flagged before generation.

## Provenance

Found validating the streaming fix on the "Bramble" app: with live observability (`phoenix runs`) and
streaming working, the run **diagnosed its own next failure in a single pass** — the Web Experience call
streamed healthy to exactly the 8192-token ceiling, froze, and was killed+retried 4×. This is the next
layer beneath the buffering issue. See `PROVIDER-STREAMING-DIAGNOSIS.md` (the fix that exposed this),
`SPEC-SHAPE-FEEDBACK-OUTCOMES.md` F2, and `OBSERVABILITY-HARNESS-OUTCOMES.md` O10.
