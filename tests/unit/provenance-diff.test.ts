/**
 * Provenance #30 — diffRuns localizes WHERE a set of runs' causal chains first fork, so a
 * non-deterministic `verify` reports a root-cause stage instead of a bare verdict count. Walks
 * upstream→downstream and stops at the first forking stage: inputs (canonicalization) → generation →
 * evaluation. Synthetic runs only — no live regeneration.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProvenanceStore } from '../../src/store/provenance-store.js';
import type { RunProvenance } from '../../src/models/provenance.js';

function base(runId: string): RunProvenance {
  return {
    run_id: runId,
    created_at: '2026-01-01T00:00:00Z',
    producer: { phoenix_version: 'sha-v1', phoenix_dirty: false, generator_model: 'test' },
    trigger: { kind: 'verify', spec_semhash: 'spec1', eval_suite_hash: 'eval1' },
    inputs: { clause_set_hash: 'clauses1', canonical_graph_hash: 'canon1', contract_hashes: {} },
    checks: [{ name: 'typecheck', ok: true }, { name: 'unit_tests', ok: true }],
    ius: [
      { iu_id: 'store', name: 'Store', source_canon_ids: [], generation: { code_hash: 'codeS1' }, decision: 'PASS' },
      { iu_id: 'web', name: 'Web', source_canon_ids: [], generation: { code_hash: 'codeW1' }, decision: 'PASS' },
    ],
    verdict_signature: 'sig-A',
    tree_hash: 'tree1',
    overall: 'ok',
  };
}

let dir: string;
let store: ProvenanceStore;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'prov-diff-')); store = new ProvenanceStore(dir); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

/** record two runs (b derived from a clone of base('r2')) and diff them. */
function diff(mutate: (r2: RunProvenance) => void) {
  store.record(base('r1'));
  const r2 = base('r2');
  mutate(r2);
  store.record(r2);
  return store.diffRuns(['r1', 'r2']);
}

describe('#30 diffRuns: localizes the first forking stage', () => {
  it('identical runs → stage none, verdict stable', () => {
    const rep = diff(() => { /* no change */ });
    expect(rep.stage).toBe('none');
    expect(rep.verdict_stable).toBe(true);
    expect(rep.verdict_signatures).toEqual(['sig-A']);
  });

  it('canonical graph differs → stage inputs (upstream of generation), even when downstream also differs', () => {
    const rep = diff(r2 => {
      r2.inputs.canonical_graph_hash = 'canon2';
      r2.ius[1].generation.code_hash = 'codeW2';   // also forks downstream…
      r2.verdict_signature = 'sig-B';
    });
    expect(rep.stage).toBe('inputs');               // …but inputs is reported first
    expect(rep.details.map(d => d.key)).toContain('canonical_graph');
  });

  it('inputs identical, an IU code differs → stage generation', () => {
    const rep = diff(r2 => { r2.ius[1].generation.code_hash = 'codeW2'; r2.verdict_signature = 'sig-B'; });
    expect(rep.stage).toBe('generation');
    expect(rep.details.map(d => d.key)).toEqual(['web']);
    expect(rep.verdict_stable).toBe(false);
  });

  it('generation forks but the verdict is stable → stage generation, verdict_stable true (output varied, verdict held)', () => {
    const rep = diff(r2 => { r2.ius[1].generation.code_hash = 'codeW2'; /* verdict_signature stays sig-A */ });
    expect(rep.stage).toBe('generation');
    expect(rep.verdict_stable).toBe(true);
  });

  it('code identical, an IU verdict differs → stage evaluation (flaky evaluator)', () => {
    const rep = diff(r2 => { r2.ius[1].decision = 'FAIL'; r2.verdict_signature = 'sig-B'; });
    expect(rep.stage).toBe('evaluation');
    expect(rep.details.map(d => d.key)).toContain('web');
  });

  it('code identical, a run-level check flips → stage evaluation', () => {
    const rep = diff(r2 => { r2.checks[1].ok = false; r2.verdict_signature = 'sig-B'; });
    expect(rep.stage).toBe('evaluation');
    expect(rep.details.map(d => d.key)).toContain('check:unit_tests');
  });

  it('a single run is trivially deterministic', () => {
    store.record(base('only'));
    expect(store.diffRuns(['only']).stage).toBe('none');
  });
});
