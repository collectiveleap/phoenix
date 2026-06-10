# Phoenix: provider streaming & watchdog correctness — diagnosis, outcomes & evidence

## Headline

Large-output modules (e.g. a web-UI inline-HTML SPA) appeared to "hang" during generation under the
claude-cli provider and were watchdog-killed. **They never hung.** Root cause:

- **`claude -p` in default text mode emits zero bytes until the entire response is complete.** For a
  large output that takes minutes to generate, the call shows **0 bytes the whole time**.
- Phoenix's watchdog interprets "0 bytes / no first byte within the 60s startup budget" as a **startup
  stall** and kills an **actively-generating** call.

So this is two compounding **Phoenix-side** defects in the claude-cli path — not a claude bug, not the
spec, not the environment:

1. **Provider invocation** uses buffered text mode instead of a streaming output format.
2. **Watchdog** treats "0 bytes from a buffering provider" as a stall (false positive).

This also reconciles the entire prior history: every "Web Experience won't generate" failure — the
pre-harness 720s/1500s `out=[]` timeouts *and* the harness's 60s kills — was the same thing: claude was
generating the whole time, buffering all output, and every watchdog killed it before the buffered text
flushed at completion. Smaller modules (CRUD resources) "succeeded" only because their output finishes
inside the budget.

## Decisive evidence (isolation, outside Phoenix, same shimmed `claude`)

```
# 1. trivial prompt — returns immediately
printf 'Reply with exactly: OK' | claude -p --model sonnet --tools '' --no-session-persistence
#   → 2s, "OK"

# 2. large-output prompt, DEFAULT text mode — looks hung
printf '<prompt: output ONLY a complete ~300-line inline-HTML SPA>' \
  | claude -p --model sonnet --tools '' --no-session-persistence
#   → 0 bytes for 150s, then killed

# 3. SAME large prompt, stream-json — streams from the start
printf '<same prompt>' \
  | claude -p --output-format stream-json --verbose --model sonnet --tools '' --no-session-persistence
#   → FIRST BYTE at 2s, 14 KB streamed over 100s, still producing
```

The only variable that changes the outcome is `--output-format stream-json`.

---

## Outcomes & evidence of success (Phoenix POV)

These are preconditions that make the harness's O1/O2/O8 (per-call lifecycle, live health, stall
detection) report **true** signals. With a buffering provider, O1's `first_byte` never fires, so O8
misfires.

### S1. The provider streams generation output incrementally.
**Outcome:** the claude-cli provider invokes the CLI so output is emitted as produced (event/token
stream) — using `--output-format stream-json --verbose` (or equivalent) and parsing the stream — never
default text mode that buffers until completion.
**Evidence of success:**
- For a module that takes minutes to generate, the journal records `first_byte` within seconds (< ~10s)
  and a **monotonically rising `bytesStreamed`** throughout — not a single jump at the end.
- Regression: the reproduction above — default text mode yields 0 bytes/150s, `stream-json` yields first
  byte at ~2s. Phoenix must behave like the latter.

### S2. The watchdog never kills an actively-generating call.
**Outcome:** a call making real progress is classified healthy for as long as it streams; only genuine
silence is a stall. "Zero bytes so far" is a stall **only** when the provider can stream and has produced
nothing.
**Evidence of success:**
- A large-output module that streams steadily is **never watchdog-killed**, regardless of total duration
  (5+ minutes is fine).
- No `watchdog_kill` event ever fires against a call whose `bytesStreamed` is increasing.
- Regression: the web-UI SPA module that previously died at the 60s startup budget with 0 bytes now
  completes without a kill.

### S3. Genuine stalls are retried.
**Outcome:** a call the watchdog *does* kill (true stall) is retried up to the policy's max-retries, like
any other recoverable failure — stalls are on the retry path.
**Evidence of success:**
- The journal shows up to `maxRetries` attempts for a stalled call (today it shows exactly one — the
  defect: `maxRetries: 5` was loaded per `run --dry-run`, yet the killed call got a single attempt).
- An intermittent stall that clears on retry yields a completed module, not a stub.

### S4. Retry defaults tolerate the provider's known intermittency.
**Outcome:** the default retry policy for the claude-cli provider is high enough to ride out its known
intermittent startup behavior with no user config.
**Evidence of success:** a fresh project (no `policy` override in config) survives an intermittent startup
hang and still completes the module.

### S5. (Headline) A large-output web-UI module generates end-to-end via claude-cli, unattended.
**Outcome:** under `phoenix run` with the claude-cli provider, a `node-typescript` web-UI module (a full
inline-HTML SPA) generates to completion with no user workarounds (no spec-trimming, no budget-tuning, no
shimmed flags).
**Evidence of success:**
- `phoenix run` on a spec containing a web-UI section produces a **complete, non-stub** `web-experience`
  module and the acceptance gate passes.
- The journal shows that module streaming from ~2s to completion — confirming S1–S3 held in a real run.
- This is the single acceptance test that proves the whole chain: a spec with a large UI section → a
  booting app, hands-off.

---

## Fix locus

Small and localized: `dist/llm/claude-cli.js` builds args
`['-p','--model',<model>,'--tools','','--no-session-persistence']`. Add `--output-format stream-json
--verbose` and parse the JSON event stream for text deltas (each event also gives a natural
bytes-streamed heartbeat for O1/O2). The watchdog then treats rising `bytesStreamed` as health (S2), and
the retry policy treats a genuine `watchdog_kill` as retryable (S3). S1+S2 together resolve the
"large module hangs" failure; S5 is the end-to-end proof.

## Provenance

Diagnosed while finishing an app ("Bramble") under `phoenix run`. The harness made this *diagnosable* in
minutes — the journal's missing `first_byte` event plus the three-line `stream-json` isolation test pinned
it — it just had the wrong provider invocation underneath. See also `OBSERVABILITY-HARNESS-OUTCOMES.md`
(O1/O2/O8 are the sensors this relies on) and `ENVIRONMENT-CONTRACT-OUTCOMES.md` (separate setup concerns).
