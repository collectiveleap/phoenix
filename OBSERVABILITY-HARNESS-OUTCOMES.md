# Phoenix: observable, self-managing toolchain — outcomes & evidence

**Goal:** A spec-to-running-app pipeline that executes **unattended**, where every failure is either
prevented or auto-handled and logged, and where a human can always see what's happening in seconds.
Build a plan that achieves every outcome below; each outcome's **Evidence** is its acceptance test.

This document is the distilled output of a real stress-test session: an external project ("Bramble")
was driven through the full Phoenix pipeline, and every place the toolchain was opaque or fragile was
recorded. The reference failures are listed in the Appendix and should become a regression suite.

**Framing.** Observability = sensors (Part 1). The harness = the controller that reads those sensors and
acts: *sense → classify → decide → act → record* (Part 2). The harness depends on the observability work —
without it, the harness degrades to fragile `ps`/`sample` process-archaeology. Part 3 is the end state.

**Build choice (for the implementer to decide):** an external supervisor that orchestrates the existing
`phoenix` CLI stages as managed subprocesses (lower risk, decoupled), or a built-in `phoenix run`
supervisor mode. Either is acceptable if the outcomes are met.

---

## Part 1 — Visibility outcomes

### O1. Every LLM call's lifecycle is reconstructable after the fact.
- A persisted record per call captures: stage, target module, attempt #, provider+model, prompt size,
  start, time-to-first-byte, end, bytes/tokens streamed, outcome (ok / timeout / error / empty), error text.
- From records *alone* you can classify any call as healthy, startup-stalled (no first byte), stream-stalled
  (first byte then silence), or returned-then-wedged — with no OS-process inspection.
- Records persist and are queryable after the run.

### O2. A call's health is visible in real time.
- While a call runs, a status surface updates at least every 5s with liveness (elapsed + bytes streamed).
- A stalled call is distinguishable from a merely-slow one within ~10s, without `ps`/`sample`/CPU%.

### O3. The typecheck/repair step is transparent and correct.
- Per module: records show whether typecheck ran, the command, exit code, error count, and per
  repair-iteration the error-count delta (converging or not).
- **Test:** remove the typechecker from PATH → the run reports "typecheck tool unavailable" as a hard
  failure and fires **zero** repair calls (never treats a tool failure as type errors).
- A capped or non-converging repair loop is reported as such.

### O4. Canonicalization is accurately and fully reported.
- **Test:** run rule-based → the header says rule-based (never mislabels as "LLM").
- Every LLM call canonicalization makes appears in the O1 records.
- Each clause's classification (context / requirement / …) is recorded with the reason it got that class.

### O5. The plan is inspectable and risk-flagged before any generation.
- Plan output lists every module: name, output path, role (web-ui / resource / …), and size (source-node count).
- The heading→module mapping is shown. **Test:** a spec with 4 subsections vs. 1 section reveals the
  resulting module count *before* generating.
- Modules above a configurable size/complexity threshold are flagged as generation risks (with an
  estimate) up front.

### O6. Provider/config selection is unambiguous.
- Every LLM-using command states the resolved provider+model and the *source* of that choice (config vs env).
- **Test:** set both an API key and the local CLI provider → a conflict warning is shown.

### O7. Scaffold writes are visible.
- Every file the scaffold writes/overwrites is listed.
- **Test:** hand-edit a scaffold-managed file, regen → the overwrite is reported, not silent.

---

## Part 2 — Control / harness outcomes

### O8. A run is unattended: stalls are detected and resolved without a human.
- **Test:** inject an artificial stall → it is killed within (timeout + heartbeat interval) **regardless of
  OS power-throttling**, then retried per policy, and the event is logged.
- Across a full run, no human action is needed to detect or kill a hung call.

### O9. The toolchain is verified before a run starts.
- A preflight reports pass/fail per assumption (runtime version, typechecker, package runner, provider
  reachable, native-build capability) with remediation.
- **Test:** hide the typechecker → the run aborts at preflight in seconds with a fix list, never opaquely
  mid-run.

### O10. Oversized work is caught at plan time, not mid-generation.
- **Test:** a deliberately huge module is flagged (and optionally split or gated) at plan time, instead of
  being discovered after a long hang.

### O11. Concurrent or messy runs can't corrupt output.
- **Test:** start a second run while one is active → it exits immediately with "already running (pid …)".
- **Test:** kill a run → zero orphaned provider/child processes survive.

### O12. "Build succeeded" means it actually runs.
- After generation an acceptance gate reports green/red on: whole-project typecheck clean, server boots,
  root route returns 200 (plus any defined health checks).
- **Test:** break a module → the gate reports failure with the failing check named; the run is **not**
  reported "done."

### O13. A run is resumable.
- **Test:** kill after module 1 of 3, relaunch → only modules 2–3 run; completed work is not regenerated.
- The journal reconstructs full run state (what ran, outcomes, timings).

### O14. Failure handling is policy-driven, not improvised.
- Timeout, max-retries, backoff, size cap, repair-iteration cap, and skip-vs-abort are configurable.
- **Test:** change a threshold in config → behavior changes with no code edit.
- A dry-run prints the policy that would apply at each stage.

### O15. One status surface answers "what's happening / is it stuck / how far along."
- A live view shows current stage, current module, per-call health, retries, outcomes, and progress/ETA,
  updating at least every 5s.
- **Test:** answer those three questions for an in-flight run using only that surface (no `ps`, no
  log-grepping).

---

## Part 3 — End-state outcome

### O16. The full pipeline runs unattended end-to-end, and every known failure mode is prevented or auto-handled.
- A single command takes spec → running, verified app (or a clearly-reported failure) with no human
  intervention.
- A **regression suite** reproduces each reference failure (Appendix) and demonstrates the harness prevents
  or auto-recovers from each, with a log entry.
- Mean-time-to-detect a stall is seconds, not tens of minutes.

---

## Appendix — reference failures (regression targets)

Concrete incidents from the stress-test session; each should become a regression test under O16:

1. **Phantom-error repair loop** — typechecker absent → "command not found" treated as type errors →
   wasted repair calls (~3× cost/module). (O3)
2. **Pipe-holding watchdog** — a timeout's background `sleep` held the result pipe open, blocking the
   caller for the full timeout on *every* call, including fast ones. (O8)
3. **Concurrent-run clobber** — two generation runs overwrote each other's output with stubs. (O11)
4. **Stream stall on large output** — a big module's generation stalled/timed out repeatedly; no progress
   signal distinguished slow from dead. (O2, O8, O10)
5. **Plan fragmentation** — one-module-per-heading silently split a single-page app into N modules;
   discovered only by inspecting plan internals. (O5)
6. **Silent config overwrite** — the scaffold rewrote `tsconfig.json` each run, wiping a hand edit. (O7)
7. **Done-but-broken** — generation "succeeded" but the modules never composed into a running app. (O12)
8. **Mislabeled stage** — canonicalization claimed "LLM" while running rule-based, and a warm-context
   probe call wedged the stage opaquely. (O4)
9. **Throttled watchdog** — OS power-throttling delayed/defeated `sleep`-based timers; fixed only by
   keep-awake + wall-clock polling. (O8)
10. **Resume gap** — a relaunched run re-did already-completed modules. (O13)

---

## How to use

Treat O1–O16 as acceptance criteria. A plan is complete when every **Evidence** test passes and the
Appendix regression suite is green. The single highest-leverage item is **O1 + O2** (per-call lifecycle
records + live health): most other outcomes become trivially diagnosable once each LLM call's lifecycle
is visible.

## Pointers (from the stress-test session, against the built `dist/`)

The relevant code touchpoints observed were: `dist/regen.js` (`generateIU` / `generateWithLLM` /
`typecheckFile` — the per-module generate→typecheck→repair loop, `MAX_RETRIES`), the claude-cli provider
(the layer that spawns `claude -p`), `dist/canonicalizer.js` + `dist/canonicalizer-llm.js`, `dist/cli.js`
(`cmdBootstrap`, regen/plan handlers, the unconditional scaffold step), `dist/scaffold.js`
(`generateScaffold` / `generateTsConfig` — rewrites `package.json`/`tsconfig.json` each run),
`dist/architectures/{web-api,node-typescript}.js` (module template + shared `db.ts`/`app.ts`). Map these
to `src/` in the new session.
