/**
 * Evidence spine — the run produces per-IU evidence from the gate's checks and
 * evaluates each module's declared evidence_policy, so "verified" reflects the
 * declared evidence (GENERATED-EVIDENCE-SMOKE-ONLY, Phase 1).
 */
import { describe, it, expect } from 'vitest';
import { produceEvidence, evaluateEvidence } from '../../src/harness/evidence-gate.js';
import { planIUs } from '../../src/iu-planner.js';
import { parseSpec } from '../../src/spec-parser.js';
import { extractCanonicalNodes } from '../../src/canonicalizer.js';
import type { ImplementationUnit } from '../../src/models/iu.js';
import type { AcceptanceCheck } from '../../src/harness/acceptance.js';
import type { ContractViolation } from '../../src/harness/contract-check.js';

/** A medium-tier IU requiring typecheck + boundary_validation + unit_tests. */
const iu = (name: string): ImplementationUnit => ({
  iu_id: name.toLowerCase(), name, source_canon_ids: ['c1'],
  evidence_policy: { required: ['typecheck', 'boundary_validation', 'unit_tests'] },
} as unknown as ImplementationUnit);

const check = (name: string, ok: boolean): AcceptanceCheck => ({ name, ok, detail: '' });
const AT = '2026-01-01T00:00:00Z';

describe('Phase 1: evidence is produced from the gate and the policy is evaluated', () => {
  it('all required evidence passing → verdict PASS, run verified', () => {
    const ius = [iu('Store')];
    const records = produceEvidence(ius, [check('typecheck', true), check('unit_tests', true)], [], AT);
    const ev = evaluateEvidence(ius, records);
    expect(ev.verdicts[0].verdict).toBe('PASS');
    expect(ev.anyFailed).toBe(false);
  });

  it('generated tests RAN and FAILED → verdict FAIL → run not verified', () => {
    const ius = [iu('Store')];
    const records = produceEvidence(ius, [check('typecheck', true), check('unit_tests', false)], [], AT);
    const ev = evaluateEvidence(ius, records);
    expect(ev.verdicts[0].verdict).toBe('FAIL');
    expect(ev.verdicts[0].failed).toContain('unit_tests');
    expect(ev.anyFailed).toBe(true);
  });

  it('a contract violation fails that module\'s boundary_validation', () => {
    const ius = [iu('Store')];
    const violations: ContractViolation[] = [{ kind: 'provider-missing', module: 'Store', detail: 'x' }];
    const records = produceEvidence(ius, [check('typecheck', true), check('unit_tests', true)], violations, AT);
    const ev = evaluateEvidence(ius, records);
    expect(ev.verdicts[0].failed).toContain('boundary_validation');
    expect(ev.anyFailed).toBe(true);
  });

  it('unit_tests not produced (skipRuntime) → INCOMPLETE, not fatal', () => {
    const ius = [iu('Store')];
    // no 'unit_tests' check → not produced this run
    const records = produceEvidence(ius, [check('typecheck', true)], [], AT);
    const ev = evaluateEvidence(ius, records);
    expect(ev.verdicts[0].verdict).toBe('INCOMPLETE');
    expect(ev.verdicts[0].missing).toContain('unit_tests');
    expect(ev.anyFailed).toBe(false); // surfaced, but the run is not failed by it
  });
});

describe('Phase 1: evidence-policy honesty — only producible types are declared', () => {
  it('a planned IU requires only typecheck / boundary_validation / unit_tests', () => {
    const clauses = parseSpec('# App\n\n## Store\n\nThe service must append and list operations.', 'app.md');
    const canon = extractCanonicalNodes(clauses);
    const required = planIUs(canon, clauses)[0].evidence_policy.required;
    const producible = new Set(['typecheck', 'boundary_validation', 'unit_tests']);
    expect(required.every(r => producible.has(r))).toBe(true);
    for (const dishonest of ['lint', 'property_tests', 'static_analysis', 'human_signoff']) {
      expect(required).not.toContain(dishonest);
    }
  });
});
