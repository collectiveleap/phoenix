/**
 * Provenance #30 — the store persists per-run causal chains durably and supports the cross-version
 * "did my fix help" query. Round-trip, ancestry-index append, and phoenix_version filtering.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProvenanceStore } from '../../src/store/provenance-store.js';
import type { RunProvenance } from '../../src/models/provenance.js';

function rp(runId: string, version: string, overall: 'ok' | 'fail', webDecision: string): RunProvenance {
  return {
    run_id: runId,
    created_at: '2026-01-01T00:00:00Z',
    producer: { phoenix_version: version, phoenix_dirty: false, generator_model: 'test' },
    trigger: { kind: 'verify', spec_semhash: 'spec1', eval_suite_hash: 'eval1' },
    inputs: { clause_set_hash: 'clauses1', canonical_graph_hash: 'canon1', contract_hashes: { 'web→store': 'c1' } },
    checks: [{ name: 'typecheck', ok: true }],
    ius: [{ iu_id: 'web', name: 'Web', source_canon_ids: ['n1'], generation: { code_hash: 'codeW1' }, decision: webDecision }],
    verdict_signature: `sig-${webDecision}`,
    tree_hash: 'tree1',
    overall,
  };
}

let dir: string;
let store: ProvenanceStore;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'prov-store-')); store = new ProvenanceStore(dir); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('#30 ProvenanceStore: round-trip + ancestry index', () => {
  it('record → getRun returns the full record; runs.jsonl gets a header line', () => {
    const r = rp('r1', 'sha-v1', 'ok', 'PASS');
    store.record(r);
    expect(store.getRun('r1')).toEqual(r);
    expect(store.getRun('missing')).toBeUndefined();

    const indexPath = join(dir, 'provenance', 'runs.jsonl');
    expect(existsSync(indexPath)).toBe(true);
    const header = JSON.parse(readFileSync(indexPath, 'utf8').trim());
    expect(header).toMatchObject({ run_id: 'r1', phoenix_version: 'sha-v1', overall: 'ok', verdict_signature: 'sig-PASS' });
  });

  it('listRuns returns headers in insertion order and filters by phoenix_version', () => {
    store.record(rp('r1', 'sha-v1', 'fail', 'FAIL'));
    store.record(rp('r2', 'sha-v2', 'ok', 'PASS'));
    expect(store.listRuns().map(h => h.run_id)).toEqual(['r1', 'r2']);
    expect(store.listRuns({ phoenix_version: 'sha-v2' }).map(h => h.run_id)).toEqual(['r2']);
  });
});

describe('#30 cross-version comparison: "did my fix help"', () => {
  it('isolates each version, and diffRuns across versions surfaces the verdict change', () => {
    store.record(rp('before', 'sha-v1', 'fail', 'FAIL'));   // broken under v1
    store.record(rp('after', 'sha-v2', 'ok', 'PASS'));      // fixed under v2

    // Pull the latest run for each Phoenix version (the join key), then diff them.
    const before = store.listRuns({ phoenix_version: 'sha-v1' });
    const after = store.listRuns({ phoenix_version: 'sha-v2' });
    expect(before).toHaveLength(1);
    expect(after).toHaveLength(1);

    const rep = store.diffRuns(['before', 'after']);
    expect(rep.verdict_stable).toBe(false);                 // the verdict changed version-over-version
    expect(rep.verdict_signatures.sort()).toEqual(['sig-FAIL', 'sig-PASS']);
    expect(rep.stage).toBe('evaluation');                   // same inputs+code, the verdict moved
  });
});
