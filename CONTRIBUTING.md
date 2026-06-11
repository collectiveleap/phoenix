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
