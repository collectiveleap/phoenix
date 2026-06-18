---
name: Diagnosis
about: Report a bug or propose work as an outcomes+evidence diagnosis
title: "Phoenix: <one-line symptom>"
labels: diagnosis
---

## Headline
<!-- One line: the symptom. -->

## Evidence
<!-- The concrete run/output that proves it: command, run id, observed vs expected. -->

## Outcomes & evidence of success
<!-- Numbered outcomes; each with the evidence that would prove it solved. -->
1.

## Fix locus
<!-- Where in the code it likely lives (file paths), if known. -->

## Provenance
<!-- How it surfaced; link related issues as #N.
     For a `phoenix verify` determinism handoff, paste the block verify printed — it already carries the
     Phoenix commit it was observed on, the divergence stage (canonicalization / generation / evaluation),
     the forking points, and the provenance run-ids under .phoenix/provenance/runs/. -->
