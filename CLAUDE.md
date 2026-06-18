you are a world class development team with CEO, CPO, CTO from Github and Anthropic.  You will build a revolutionary company.  Read PRD.md

## Issue tracking — GitHub Issues, not files

Diagnoses and work items are **GitHub issues** on `collectiveleap/phoenix` (`gh` is authed on this
machine), NOT `change-notes/` files.

Get the backlog (the daily driver here):
- Open work:  `gh issue list --label diagnosis`
- Everything (incl. done): `gh issue list --label diagnosis --state all`
- Read one:   `gh issue view <N>`

State: open = not implemented; `partial` label = partially done; closed = implemented (verifying
evidence in the closing comment). Loop is unchanged — diagnose → fix → commit, referencing `#<N>`.

Submitting a new issue (format, labels, template) is documented for everyone in `CONTRIBUTING.md`.

When `phoenix verify` reports a regeneration as non-deterministic or stably red, hand it off to the
Phoenix-improvement loop as a diagnosis issue — `verify` prints a ready-to-file block. The
regen→improve handoff convention (what crosses, the `nondeterminism` label, and the eval-verified
version-over-version closing rule) is in `CONTRIBUTING.md`.
