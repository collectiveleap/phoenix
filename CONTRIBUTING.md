# Contributing to Phoenix

## Reporting issues

Phoenix tracks bugs, diagnoses, and feature requests as **GitHub issues** at
<https://github.com/collectiveleap/phoenix/issues>. Anyone — human or AI agent — files them the same way.

### How to submit

- **Web:** open a New Issue and pick the **Diagnosis** template.
- **CLI (`gh`):** `gh issue create --template diagnosis`

The template applies the `diagnosis` label automatically — you don't need label permissions.

### What a good issue contains (the Diagnosis shape)

1. **Headline** — one line naming the symptom.
2. **Evidence** — the concrete run/output that proves it (command, run id, observed vs expected).
3. **Outcomes & evidence of success** — numbered outcomes, each with the evidence that would prove it solved.
4. **Fix locus** — where in the code it likely lives (file paths), if known.
5. **Provenance** — how it surfaced; link related issues as `#<N>`.

Claim only what's reproducible on the current build, and describe behavior (what you observe), not
implementation details.

## The regen→improve handoff (determinism diagnoses)

Phoenix is exercised through two loops:

- **loop-bramble-regen** — run `phoenix` to regenerate a target app (e.g. Bramble) from its spec.
- **loop-improve-phoenix** — edit Phoenix itself.

When `phoenix verify` finds a regeneration non-deterministic or stably red, that finding has to cross
from the regen loop into the improve loop. It crosses as a **diagnosis issue** — the *diagnosis* travels,
not the raw provenance records. The records stay in the regen workspace under `.phoenix/provenance/`;
the issue carries pointers (run-ids), not copies.

**When to file.** `phoenix verify --runs=N` exits non-zero — either a non-deterministic verdict
(several distinct acceptance results across the N clean regens) or a stably-red verdict (a repeatable
failure). A single green regen is *not* a fix and a single red one is *not* the whole story; the gate is
the arbiter.

**What it carries.** `verify` prints a ready-to-file block already in the Diagnosis shape. It names:
- the **Phoenix commit** the divergence was observed on (`producer.phoenix_version` — the join key
  between the two loops);
- the **divergence stage** — where the runs' causal chains first fork: `inputs` (canonicalization),
  `generation` (an IU's code differs on identical inputs), or `evaluation` (a verdict differs on
  identical code — a flaky evaluator);
- the **forking points** and the **provenance run-ids** (under `.phoenix/provenance/runs/`).

File it with `gh issue create -F -` (paste the block) or the web template. Labels: `diagnosis` +
`nondeterminism` (create the latter once with `gh label create nondeterminism` if it doesn't exist).

**Closing convention.** Completion is decided by the evals, repeatably — not by inspection or one lucky
regen. Close a determinism diagnosis only with **eval-verified, version-over-version** evidence: re-run
`phoenix verify` under the fixed Phoenix commit and, in the closing comment, attach the now-stable
verdict **and** the cross-version comparison (the broken commit → the fixed commit). The Phoenix commit
SHA stamped on each provenance record is the join key that makes that comparison a query rather than a
memory.
