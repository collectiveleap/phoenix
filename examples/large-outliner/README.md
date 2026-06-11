# large-outliner — a reproducible large-module fixture (#24)

This example exists to **reliably trigger** the large-single-module case: the `## Web Experience`
section in `spec/outliner.md` is rich enough that its generated module (a full inline-HTML SPA)
exceeds Phoenix's per-call output bound, so generation must **continue across calls** and stitch the
chunks (issue #24).

## Run it

```sh
phoenix init --arch web-api/node-typescript      # bind the architecture/runtime
phoenix run --runtime-checks                      # generate + provision + boot + evaluate
```

Watch the run live with `phoenix runs <id>`. On the Web Experience module you should see the
generation cross the byte bound and continue: the journal records `generation_continuation` events
(one per round) and a terminal `generation_assembled` with `converged: true` and the total bytes.

## A/B comparing approaches

Continuation is on by default. Toggle it to compare against the prior behavior (hard-fail at the
first bound) on the *same* spec:

```sh
PHOENIX_GENERATE_CONTINUATIONS=0 phoenix run --runtime-checks   # no continuation → bounds hard-fail → stub
PHOENIX_GENERATE_CONTINUATIONS=1 phoenix run --runtime-checks   # continuation (default) → assembled module
```

Tuning:
- `PHOENIX_GENERATE_MAX_CONTINUATIONS` (default 4) — rounds before a non-converging generation hard-fails.
- `PHOENIX_GENERATE_MAX_TOKENS` — the per-call output-token budget.

The trigger depends on the model's verbosity, so the exact number of continuation rounds varies between
runs and models; the point is that the module completes as a real, non-stub SPA rather than a runaway → stub.
