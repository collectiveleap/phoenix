# Phoenix: making opus generate the large web-ui module — diagnostics, outcomes & evidence

## Context

The hard web-ui module (a large inline-HTML SPA) is assigned the **most-capable model** via
`PHOENIX_LLM_MODEL_WEBUI` (`dist/llm/resolve.js:194` — *"the hard module gets the most capable model"*;
`:199` reads the env var). Goal: get **opus** to generate the real module where sonnet ran away.

**First opus attempt failed** (`regen --iu="Web Experience"`, `PHOENIX_LLM_MODEL_WEBUI=opus`):
```
✖ Watchdog killed stalled call (Web Experience): Claude CLI killed by SIGKILL
   (1114 B · 46.1s · outcome:timeout · model:opus)
```
Opus emitted only **1114 B (the stream-json `system/init` envelope — no content)**, then was silent and
killed at **46.1s**. It never produced any code → stub fallback.

## Why it failed (precise)

1. **The 1114 B is envelope, not content** — the `{"type":"system","subtype":"init",…}` event. But the
   harness's byte counter counts it as "streaming," so the call is treated as *past first byte* and
   governed by the **stream-stall budget (45s)** rather than the startup budget.
2. **Opus's latency-to-first-CONTENT-token exceeds 45s** — it reasons before emitting output. During that
   thinking the text stream is silent.
3. ⇒ **stream-stall kill at 46s, mid-thinking, before any code.**

**Two opposite model failure modes** (neither completes the SPA under current budgets):

| Model | First content | Failure |
|---|---|---|
| sonnet | ~2s | **runs away** — ~58K tokens, 20+ min, no effective output cap (`LARGE-MODULE-GENERATION-DIAGNOSIS.md`) |
| opus | **>45s** (thinking) | **killed at 46s** by the stream-stall budget, before any content |

So model-swapping alone trades runaway for think-timeout. Making opus work needs harness changes
(content-aware progress + a model-aware first-content budget) and the same output-bounding the L-doc calls for.

---

## Diagnostics to run (to characterize opus and size the budgets)

These are the tests whose results populate the evidence below. Run with a **generous stall budget** so
opus is not killed before it starts.

- **D1 — opus time-to-first-CONTENT-token.** Generate the web-ui module with opus and stall budgets ≥ 180s;
  timestamp the **first assistant text delta** (not the `init` event). Output: `t(first content)`, and
  whether it ever arrives. → sets the required first-content budget.
- **D2 — post-thinking behavior.** Once content starts, does opus stream to a clean completion
  (`stop_reason: end_turn`) at a reasonable size, or run away like sonnet? Output: total output tokens,
  duration, terminal `stop_reason`.
- **D3 — output cap under opus.** `CLAUDE_CODE_MAX_OUTPUT_TOKENS` does **not** bound sonnet (proven in the
  L-doc). Does it bound opus? Set a small cap, measure output tokens + `stop_reason`.
- **D4 — content vs envelope bytes.** Confirm what fraction of the early byte count is the `init` envelope
  vs. text deltas (the 1114 B here was ~all envelope), to validate OP1.

Suggested first run (D1+D2 together), grounded in the existing override + budget config:
```
# config: { "policy": { "budgets": { "startupMs": 200000, "streamStallMs": 200000 } } }
PHOENIX_LLM_MODEL_WEBUI=opus  phoenix run         # or: regen --iu="Web Experience"
# watch `phoenix runs <id>`: when do CONTENT bytes (beyond ~1KB envelope) start? does it complete?
```

---

## Outcomes & evidence of success (Phoenix POV) — making opus work

### OP1. The watchdog measures CONTENT progress, not stream-json envelope bytes.
**Outcome:** `bytesStreamed` and stall detection count assistant **text deltas**; `system/init` and other
metadata events do **not** count as "streaming."
**Evidence:** a call that has emitted only the init envelope and no text deltas is classified as
**awaiting first content** (startup phase), not **stream-stalled**. (The opus `1114 B then silent` call
would be a startup-phase call, not a mid-stream stall.)

### OP2. The first-content budget tolerates the model's thinking latency (model-aware).
**Outcome:** the *time-to-first-content* budget is large enough for, or configurable per, the chosen model;
opus's thinking phase (measured in D1) is within budget by default.
**Evidence:** opus is **not** killed during its pre-content thinking; it proceeds to generate. The opus
default first-content budget is set from D1 (≥ measured think time + margin).

### OP3. Once content flows, a tighter stream-stall budget still applies.
**Outcome:** after the first content token, a genuine mid-stream silence is still caught by the (shorter)
stream-stall budget — so a real stall during generation is still killed.
**Evidence:** opus that thinks-then-streams completes; opus that thinks-then-dies-mid-stream is still
caught and reported.

### OP4. Opus output is bounded (no runaway) or chunked.
**Outcome:** opus generation is bounded by a working output cap or chunked/split, so it can't run away as
sonnet did.
**Evidence:** from D2/D3 — opus stops at a reasonable size with a clean `stop_reason`, or a provider-side
wall-clock/byte bound applies. (If D3 shows `CLAUDE_CODE_MAX_OUTPUT_TOKENS` is also unenforced for opus,
the bound must be provider-side — same conclusion as the L-doc.)

### OP5. (Headline) Opus generates the real web-ui module.
**Outcome:** `PHOENIX_LLM_MODEL_WEBUI=opus` produces a **real, non-stub** `web-experience` module that
typechecks and boots.
**Evidence:** the module is a full SPA (not the `{stub:true}` fallback); the journal shows opus
`init → thinking → content stream → clean completion`; the acceptance gate (with stub-fallback detection,
`STUB-FALLBACK-ACCEPTANCE-DIAGNOSIS.md`) reports verified.

---

## Fix locus (for the implementer)

- **Content-aware progress (OP1):** in the stream-json parse / watchdog, count text-delta bytes for
  liveness; do not let `init`/metadata events reset or satisfy the stall timer.
- **Two-phase, model-aware budgets (OP2/OP3):** a `firstContentMs` budget (large, model-aware — opus needs
  more) separate from `streamStallMs` (smaller, applies after first content). Default `firstContentMs` for
  opus from D1.
- **Output bound (OP4):** as in the L-doc — a provider-side wall-clock/byte cap and/or chunked generation,
  since `CLAUDE_CODE_MAX_OUTPUT_TOKENS` is unenforced.

## Provenance

From continuing the "Bramble" build: after sonnet ran away on the large web-ui module, opus was tried via
`PHOENIX_LLM_MODEL_WEBUI=opus` and failed oppositely — killed at 46s during its pre-content thinking by the
stream-stall budget, with the byte counter fooled by the stream-json init envelope. See
`LARGE-MODULE-GENERATION-DIAGNOSIS.md` (sonnet runaway / unenforced cap), `PROVIDER-STREAMING-DIAGNOSIS.md`
(stream classification), and `STUB-FALLBACK-ACCEPTANCE-DIAGNOSIS.md` (why the failure was masked as
"verified").
