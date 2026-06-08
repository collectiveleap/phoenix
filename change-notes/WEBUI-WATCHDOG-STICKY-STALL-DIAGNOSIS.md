# Phoenix: the watchdog kills web-ui generation mid-stream — "startup-stalled" is latched and never cleared by streamed output — diagnosis, outcomes & evidence

## Headline (the large web-ui module never generates → stub fallback → no app)

The Web Experience (large opus web-ui) module **never generates**: the watchdog marks its call
`startup-stalled` after a slow first-token, and then **never clears that state even as the call streams
~63 KB of real output**, killing it mid-stream. Every retry dies the same way, so the module exhausts its
attempts and falls back to a 439-byte stub — the app cannot exist.

This is **not** a true startup hang (those were the subject of `OPUS-WEBUI-GENERATION-DIAGNOSIS.md` /
`LARGE-MODULE-GENERATION-DIAGNOSIS.md`, rideable by retries). Here the call **recovers and produces the
SPA**, but the watchdog has latched `startup-stalled` and kills it anyway — so retries cannot help.

## Evidence (single run `run-20260608-124654-6ebc26`, generate stage)

- **8 generation attempts** for Web Experience, all killed; final one SIGKILLed → stub fallback:
  ```
  ✖ Web Experience: Watchdog killed stalled call (Web Experience): Claude CLI killed by SIGKILL
  ```
  Resulting `src/generated/web-experience/web-experience.ts` is the 439-byte
  `{ stub: true, message: 'Not yet implemented' }` router.
- **Per-attempt lifecycle** (from the run journal ticks):
  - ~0–60 s: `healthy`, stuck at **1134 B** (prompt echo / initial buffer — no model tokens yet).
  - flips to **`startup-stalled`** still at 1134 B (first stall tick observed at 101 s into an attempt).
  - **The decisive anomaly:** in the long attempts output *does* arrive — bytes climb
    **1134 B → 58631 B → 58971 B → 63015 B** (~63 KB of real generated SPA) — yet the state stays
    **`startup-stalled` the entire time**, and the call is killed at ~239 s.
    ```
    ⏳ Web Experience — 209s, 1134B,  startup-stalled
    ⏳ Web Experience — 214s, 58971B, startup-stalled   ← output streaming, still "startup-stalled"
    ⏳ Web Experience — 217s, 63015B, startup-stalled   ← 63 KB produced, still killed
    ⏳ Web Experience — 239s, 58971B, startup-stalled
    ```
- So the watchdog state is **(a) mis-named** — it kills mid-stream, not at startup — and **(b) sticky**:
  once latched, monotonically growing output bytes never reset it to `healthy`. The call most likely to
  succeed (the one that got past first-token and is writing the SPA) is the one that gets killed.

## Why retries don't save it

The harness rides out *startup* hangs by retrying (env-contract B6 / #45269). That works only if a retried
call that *starts producing output* is allowed to finish. Here it isn't: every attempt that reaches the
streaming phase is still flagged `startup-stalled` and killed. Retrying a kill-on-success loop just burns
8 attempts and lands on the stub.

---

## Outcomes & evidence of success (Phoenix POV)

### W1. Output growth is liveness — a call whose output is still growing is never killed as stalled.
**Outcome:** the watchdog re-evaluates stall **every tick against delta-bytes**; any tick where output
bytes increased resets the liveness clock. A call streaming output is `healthy` by definition, regardless
of how slow its first token was.
**Evidence:** replaying the Web Experience byte trace (1134 → 58631 → 58971 → 63015) keeps the call
`healthy` from the first byte-increase onward and it is allowed to complete; no kill fires while bytes grow.

### W2. The stall state is not latched.
**Outcome:** `startup-stalled` is a *current* assessment, not a sticky flag; it can return to `healthy` on
the next tick that shows progress.
**Evidence:** a call that is idle for the threshold then resumes output transitions `startup-stalled →
healthy` on the next byte-increase tick (unit test over the watchdog state machine).

### W3. The large web-ui module generates to completion.
**Outcome:** the Web Experience module generates a real implementation (not a stub) in a normal run,
without the user trimming the spec (env-contract B6).
**Evidence:** `phoenix run` on the Bramble spec produces a non-stub
`src/generated/web-experience/web-experience.ts` (real SPA, not the `Not yet implemented` router);
`phoenix runs <id>` shows Web Experience as generated, not stub-fallback.

### W4. (First-token budget) Slow first-token alone does not trip a kill prematurely.
**Outcome:** the first-token / startup budget for a large web-ui module is large enough that a slow start
is tolerated; the kill is reserved for genuine no-progress (no byte growth for the threshold), per W1.
**Evidence:** an attempt that produces its first tokens after the old ~60 s mark is not killed; only a call
with zero byte growth across the full window is killed, with a message naming it a no-progress stall.

---

## Fix locus (for the implementer)

- The watchdog stall detector: drive the stall decision from **per-tick output-byte delta**, not a latched
  startup flag. If `bytes(now) > bytes(prev)`, the call made progress this tick → reset the stall clock and
  set state `healthy`. Only kill after N consecutive ticks of **zero byte growth**.
- Reserve `startup-stalled` for the genuine pre-first-byte case (bytes still at the initial buffer size);
  once bytes exceed the initial buffer, a stall is a *mid-stream* stall measured the same delta-bytes way —
  never a sticky carry-over of the startup state.
- Consider a larger first-token budget for `web-ui` role modules (W4), but W1 (output-as-liveness) is the
  load-bearing fix — it makes the first-token budget far less sensitive.

## Provenance

Found re-standing-up "Bramble" through a fresh `phoenix run` after the preflight-typechecker fix landed
(`PREFLIGHT-TYPECHECKER-DIAGNOSIS.md`). The Bramble Store (api) module generated cleanly; the Web
Experience (web-ui, opus, ~16.5k tok est.) module was killed across all 8 attempts despite streaming ~63 KB
of output, and fell back to a stub. Refines `OPUS-WEBUI-GENERATION-DIAGNOSIS.md` and
`LARGE-MODULE-GENERATION-DIAGNOSIS.md` (those addressed getting first-token / output volume; this addresses
the watchdog killing a call that *already* recovered and is streaming). The run correctly reported
`outcome failed` rather than `✔ verified` — the `STUB-FALLBACK-ACCEPTANCE-DIAGNOSIS.md` fix is holding.
