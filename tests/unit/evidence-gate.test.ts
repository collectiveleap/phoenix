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

/** A rendered-ui IU requiring typecheck + boundary_validation + ui_behavior. */
const webIu = (name: string): ImplementationUnit => ({
  iu_id: name.toLowerCase(), name, source_canon_ids: ['c1'],
  evidence_policy: { required: ['typecheck', 'boundary_validation', 'ui_behavior'] },
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

  it('a web-ui module requiring ui_behavior with no producer → INCOMPLETE, not falsely PASS off the smoke', () => {
    const web = webIu('Web Experience');
    // typecheck + the project unit_tests smoke pass — but ui_behavior was not produced.
    const records = produceEvidence([web], [check('typecheck', true), check('unit_tests', true)], [], AT);
    const ev = evaluateEvidence([web], records);
    expect(ev.verdicts[0].verdict).toBe('INCOMPLETE');
    expect(ev.verdicts[0].missing).toContain('ui_behavior');
    expect(ev.verdicts[0].satisfied).not.toContain('ui_behavior'); // the smoke cannot stand in for it
    expect(ev.anyFailed).toBe(false);
  });
});

describe('Phase 1: ui_behavior is surface-scoped to the IUs that require it', () => {
  it('a passing ui_behavior check → UI_BEHAVIOR PASS on the rendered-ui IU, never on an api IU', () => {
    const ius = [iu('Store'), webIu('Web Experience')];
    const records = produceEvidence(
      ius, [check('typecheck', true), check('unit_tests', true), check('ui_behavior', true)], [], AT,
    );
    const web = records.filter(r => r.iu_id === 'web experience');
    const api = records.filter(r => r.iu_id === 'store');
    expect(web.some(r => r.kind === 'ui_behavior' && r.status === 'PASS')).toBe(true);
    expect(api.some(r => r.kind === 'ui_behavior')).toBe(false); // api never carries ui_behavior

    const ev = evaluateEvidence(ius, records);
    expect(ev.verdicts.every(v => v.verdict === 'PASS')).toBe(true);
  });

  it('a failing ui_behavior check → FAIL for the rendered-ui module (fatal)', () => {
    const ius = [webIu('Web Experience')];
    const records = produceEvidence(ius, [check('typecheck', true), check('ui_behavior', false)], [], AT);
    const ev = evaluateEvidence(ius, records);
    expect(ev.verdicts[0].verdict).toBe('FAIL');
    expect(ev.verdicts[0].failed).toContain('ui_behavior');
    expect(ev.anyFailed).toBe(true);
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
