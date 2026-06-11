/**
 * Evidence gate — turns the run's acceptance results into per-IU EvidenceRecords
 * and evaluates each IU's declared `evidence_policy` (PRD: code → evidence →
 * policy decision). Wires the existing `policy-engine` into the run so "verified"
 * reflects the declared evidence, not just an ad-hoc smoke gate.
 *
 * A produced-and-failing required type (e.g. unit_tests ran and failed) makes the
 * run NOT verified. A required type that simply wasn't produced this run (e.g.
 * unit_tests skipped without --runtime-checks) is reported INCOMPLETE — surfaced,
 * but it does not by itself fail the run (you can't verify what didn't run).
 */

import type { ImplementationUnit } from '../models/iu.js';
import { EvidenceKind, EvidenceStatus } from '../models/evidence.js';
import type { EvidenceRecord, PolicyEvaluation } from '../models/evidence.js';
import { evaluateAllPolicies } from '../policy-engine.js';
import type { AcceptanceCheck } from './acceptance.js';
import type { ContractViolation } from './contract-check.js';

/**
 * Map the gate's checks to per-IU evidence. `typecheck` and `unit_tests` are
 * whole-project (one result applies to every module); `boundary_validation` is
 * per-module (a contract violation naming the module fails its boundary). A check
 * that did not run yields no record → the policy reports that type as missing.
 */
export function produceEvidence(
  ius: ImplementationUnit[],
  checks: AcceptanceCheck[],
  contractViolations: ContractViolation[],
  at: string,
): EvidenceRecord[] {
  const ok = (name: string): boolean | undefined => checks.find(c => c.name === name)?.ok;
  const typecheckOk = ok('typecheck');
  const unitTestsOk = ok('unit_tests'); // undefined when not run (skipRuntime)

  const records: EvidenceRecord[] = [];
  let seq = 0;
  const push = (iu: ImplementationUnit, kind: EvidenceKind, pass: boolean) => {
    records.push({
      evidence_id: `ev-${++seq}`, kind,
      status: pass ? EvidenceStatus.PASS : EvidenceStatus.FAIL,
      iu_id: iu.iu_id, canon_ids: iu.source_canon_ids, timestamp: at,
    });
  };

  for (const iu of ius) {
    if (typecheckOk !== undefined) push(iu, EvidenceKind.TYPECHECK, typecheckOk);
    if (unitTestsOk !== undefined) push(iu, EvidenceKind.UNIT_TEST, unitTestsOk);
    const violated = contractViolations.some(v => v.module === iu.name);
    push(iu, EvidenceKind.BOUNDARY_VALIDATION, !violated);
  }
  return records;
}

export interface EvidenceGateResult {
  verdicts: PolicyEvaluation[];
  /** A required evidence type was produced and FAILED → the run is not verified. */
  anyFailed: boolean;
  /** A required type wasn't produced this run (e.g. tests not run) → reported, not fatal. */
  incomplete: PolicyEvaluation[];
}

/** Evaluate every IU's evidence policy against the produced records. */
export function evaluateEvidence(ius: ImplementationUnit[], records: EvidenceRecord[]): EvidenceGateResult {
  const verdicts = evaluateAllPolicies(ius, records);
  return {
    verdicts,
    anyFailed: verdicts.some(v => v.verdict === 'FAIL'),
    incomplete: verdicts.filter(v => v.verdict === 'INCOMPLETE'),
  };
}
