# Phoenix: large single-module generation via claude-cli — diagnosis, outcomes & evidence

## Headline

A large web-UI module (a full inline-HTML SPA) **repeatedly fails to generate in one claude-cli call.**
On the same module, three distinct failure modes have appeared across iterations:

1. **Buffering** — `claude -p` text mode emitted 0 bytes until done → watchdog read it as a startup stall
   (fixed: `PROVIDER-STREAMING-DIAGNOSIS.md`).
2. **Token ceiling** — output truncated at the 8192-token cap (fixed: `TOKEN-BUDGET-DIAGNOSIS.md`, default
   budget raised to 32000).
3. **Runaway → stall (this report)** — with streaming + the raised budget, the model generated a
   **runaway** (~58K tokens), the stream eventually went silent, and the call was watchdog-killed. Across
   **4 attempts** (durations **696s / 48s / 1163s / 1375s**) it never completed → fell back to a stub.

**Root finding (newly confirmed by direct test):** the budget Phoenix forwards to claude-cli,
`CLAUDE_CODE_MAX_OUTPUT_TOKENS`, **is not honored by `claude -p`.** So there is *no effective output cap*
on claude-cli generations — large modules run unbounded until they stall and are killed.

---

## Evidence

### A. The 4 failed attempts (run `run-20260607-162020-e25f74`, module "Web Experience", `promptBytes=9754`)

From `.phoenix/runs/<run>/events.jsonl`:

| attempt | callId | start | end | duration | journal first_byte |
|---|---|---|---|---|---|
| 0 | …c0025 | 16:24:40 | watchdog_kill | **696s** | none |
| 1 | …c0026 | 16:36:18 | watchdog_kill | **48s** | none |
| 2 | …c0027 | 16:37:10 | watchdog_kill | **1163s** | none |
| 3 | …c0028 | 16:56:39 | watchdog_kill | **1375s** | none |

- The live `phoenix runs` view (from the overwritten `state.json`) showed `bytesStreamed` climbing to
  **574,400** and then **static** for ~25s before the final kill — i.e. the stream produced a huge output
  then went silent (no terminal event), which the watchdog classified as a stream-stall.
- The two long attempts (1163s, 1375s) are the runaways; the 48s one is a fast (likely startup) stall —
  so the failure is **inconsistent** across attempts, but never a clean completion.

### B. Instrumentation gap (hampers debugging)

For these **generate** calls, `events.jsonl` contains only `call_start`, `watchdog_kill`, `generate_retry`
— **no `call_first_byte`, `call_progress`, or `bytesStreamed` events.** The byte/first-byte timeline
existed only in the live `state.json`, which is overwritten each tick. So **post-hoc you cannot see the
byte progression or time-to-first-byte from the journal** — exactly the data O1/O2 promise. (Contrast:
canonicalize emits rich `classification` events.) Fixing this is a prerequisite for debugging C below.

### C. `CLAUDE_CODE_MAX_OUTPUT_TOKENS` is not honored — direct test

The provider forwards the budget as an env var (`dist/llm/claude-cli.js`):
```js
// The CLI has no max-output-tokens flag; its output ceiling is the env var
// CLAUDE_CODE_MAX_OUTPUT_TOKENS. Forward the caller's budget there ...
const budgetEnv = options?.maxTokens ? { CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(options.maxTokens) } : {};
spawn(bin, args, { ..., env: { ...process.env, ...STARTUP_ENV, ...budgetEnv } });
```

Controlled test (cap set to **1500** tokens, large-output prompt):
```
CLAUDE_CODE_MAX_OUTPUT_TOKENS=1500 \
  printf '<prompt: output ONLY a complete ~400-line inline-HTML SPA>' | \
  claude -p --output-format stream-json --verbose --model sonnet --tools '' --no-session-persistence
```
Result:
- elapsed **85s**, raw stream-json **37,492 bytes**, extracted assistant text **15,214 bytes**.
- terminal **`stop_reason: stop_sequence`** (NOT `max_tokens`), `usage.output_tokens` ≈ **5998**.
- **The output (~5998 tokens) is ~4× the 1500-token cap.** ⇒ `CLAUDE_CODE_MAX_OUTPUT_TOKENS` did **not**
  cap the call.

Consequences:
- The real run's 32000 setting was equally ineffective → the Web Experience generation ran unbounded.
- Because the model stops on `stop_sequence`/`end_turn` rather than `max_tokens`, the truncation-detection
  (`isTruncationStopReason`, checking for `max_tokens`) **never fires** for claude-cli — so the budget
  machinery from `TOKEN-BUDGET-DIAGNOSIS.md` is inert on this provider.

### D. Stream-json overhead, and how big the runaway really was

From C: raw stream-json **37,492 B** for **15,214 B** of text ⇒ **~2.46× overhead**. Applying that ratio
to the real run's peak **574,400 B** stream ⇒ **~233 KB of actual code ≈ ~58K tokens** of output for one
module. A reasonable SPA for this spec is ~10–15K tokens, so the model produced **~4–6× more than needed**
— a genuine runaway, consistent with the unenforced cap (C).

### E. Contrast / scope

- Reference `todo-app` web-experience (~29 KB ≈ ~7K tokens) generates fine — under the runaway threshold.
- The other Bramble modules (CRUD resources, small outputs) generate fine.
- **Only the large single web-UI module fails** — and it fails because nothing bounds its output.

---

## Reproduction recipe

1. A `web-api/node-typescript` project with a spec containing a substantial `## Web Experience` web-ui
   section (a full inline-HTML SPA). `phoenix run`; watch `phoenix runs <id>` → the Web Experience
   generate call streams for many minutes to hundreds of KB, stalls, is killed, retried, → stub.
2. Direct cap test (claude-cli): run the `CLAUDE_CODE_MAX_OUTPUT_TOKENS=1500` command in §C; observe
   output ≫ 1500 tokens and `stop_reason: stop_sequence`. (Confirms the env var is not honored.)
3. Overhead measurement: `wc -c` the raw stream-json vs. the extracted `type:"text"` deltas → ~2.4–2.5×.

---

## Outcomes & evidence of success (Phoenix POV)

### L1. claude-cli output is actually bounded.
**Outcome:** the provider has a *working* output cap — either a verified env/flag that `claude -p` honors,
or a provider-enforced wall-clock/byte ceiling that aborts a call exceeding the budget.
**Evidence:** the §C test with a small cap yields output ≈ the cap with a truncation signal — not ~4× over.
A generation cannot run 20 minutes to hundreds of KB.

### L2. Hitting the cap is reported as truncation, for claude-cli too.
**Outcome:** when claude-cli output is bounded (L1), the over-budget condition is recognized (as
`TOKEN-BUDGET-DIAGNOSIS.md` T2/T3 intend) regardless of the provider's terminal `stop_reason` wording
(`stop_sequence` vs `max_tokens`).
**Evidence:** an over-budget claude-cli module hard-fails with a remediation, not a watchdog-kill + retry.

### L3. A large module is generated via chunking/continuation or split — not one monster call.
**Outcome:** Phoenix does not require a single call to emit a whole large SPA; it continues across calls or
the plan splits the module.
**Evidence:** a web-ui module emitting a 50–60 KB SPA completes (chunked/continued/split) and passes
acceptance — no 20-minute runaway.

### L4. Generate calls are fully journaled (debuggability).
**Outcome:** generate calls emit `call_first_byte`, `call_progress` (bytes), and `call_end` (with
`stop_reason`, `output_tokens`) to `events.jsonl` — not only to the ephemeral `state.json`.
**Evidence:** after a run, the byte timeline, time-to-first-byte, and terminal reason for any module are
reconstructable from the journal alone (no live capture needed). This is what made C/D hard here.

### L5. (Headline) The large web-UI module generates reliably via claude-cli.
**Outcome:** `phoenix run` with claude-cli produces a real, non-stub Web Experience module that boots a
working outliner.
**Evidence:** the run journal shows the module's call ending in a normal completion within a bounded time,
and the acceptance gate (with stub-fallback detection — `STUB-FALLBACK-ACCEPTANCE-DIAGNOSIS.md`) reports
verified.

---

## Fix options (for the implementer), in priority order

1. **Make the output cap real (L1/L2).** `CLAUDE_CODE_MAX_OUTPUT_TOKENS` is not honored by `claude -p`
   (§C). Find the mechanism that is, or — since the CLI has no max-tokens flag — impose a **provider-side
   wall-clock and/or byte budget** that aborts and reports a call exceeding it. This alone stops the
   20-minute runaways and the futile retries.
2. **Continuation or plan-split for large modules (L3).** The durable fix: never require one call to emit
   a whole large SPA. Generate shell + sections and compose, or continue across calls. Ties to
   `SPEC-SHAPE-FEEDBACK-OUTCOMES.md` and `TOKEN-BUDGET-DIAGNOSIS.md` T4.
3. **Journal generate-call lifecycle (L4).** Emit first_byte/progress/end events so this class of failure
   is debuggable from the journal, not by live capture.
4. **Recognize non-`max_tokens` stop reasons (L2).** claude-cli stops on `stop_sequence`/`end_turn`; the
   truncation logic keyed on `max_tokens` won't fire here.

## Provenance

The third distinct failure of the same large module while finishing "Bramble" (after the buffering
false-stall and the 8192-token ceiling). Newly added: the four-attempt trace, the exact provider
invocation, the §C test proving `CLAUDE_CODE_MAX_OUTPUT_TOKENS` is unenforced, the §D overhead/size
math (~58K-token runaway), and the §B journal gap. See `PROVIDER-STREAMING-DIAGNOSIS.md`,
`TOKEN-BUDGET-DIAGNOSIS.md`, and `STUB-FALLBACK-ACCEPTANCE-DIAGNOSIS.md` (why this failure was mislabeled
"verified").
