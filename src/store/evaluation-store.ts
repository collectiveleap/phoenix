/**
 * Evaluation Store — persists the *resolved* (ephemeral) view of evaluations
 * inside .phoenix/. The durable source files live at the project root in
 * `evals/*.feature` (per docs/SUCCESS-CRITERIA.md). Bootstrap parses those
 * sources, runs the simple resolver to attach iu_id / canon_ids to each
 * Evaluation, and writes the result here. The store is regenerable.
 */

import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Evaluation, EvaluationBinding, EvaluationOrigin, EvaluationCoverage, EvaluationGap } from '../models/evaluation.js';
import type { ImplementationUnit } from '../models/iu.js';

interface EvalIndex {
  evaluations: Evaluation[];
}

export class EvaluationStore {
  private indexPath: string;

  constructor(phoenixRoot: string) {
    // Path: .phoenix/evals/index.json (renamed from .phoenix/evaluations/evaluations.json
    // for parity with the top-level durable evals/ directory).
    const dir = join(phoenixRoot, 'evals');
    mkdirSync(dir, { recursive: true });
    this.indexPath = join(dir, 'index.json');
  }

  private load(): EvalIndex {
    if (!existsSync(this.indexPath)) return { evaluations: [] };
    return JSON.parse(readFileSync(this.indexPath, 'utf8'));
  }

  private save(index: EvalIndex): void {
    writeFileSync(this.indexPath, JSON.stringify(index, null, 2), 'utf8');
  }

  add(evaluation: Evaluation): void {
    const index = this.load();
    // Replace if same ID exists
    const existing = index.evaluations.findIndex(e => e.eval_id === evaluation.eval_id);
    if (existing >= 0) {
      index.evaluations[existing] = evaluation;
    } else {
      index.evaluations.push(evaluation);
    }
    this.save(index);
  }

  addMany(evaluations: Evaluation[]): void {
    const index = this.load();
    for (const evaluation of evaluations) {
      const existing = index.evaluations.findIndex(e => e.eval_id === evaluation.eval_id);
      if (existing >= 0) {
        index.evaluations[existing] = evaluation;
      } else {
        index.evaluations.push(evaluation);
      }
    }
    this.save(index);
  }

  getByIU(iuId: string): Evaluation[] {
    return this.load().evaluations.filter(e => e.iu_id === iuId);
  }

  getAll(): Evaluation[] {
    return this.load().evaluations;
  }

  getConservation(): Evaluation[] {
    return this.load().evaluations.filter(e => e.conservation);
  }

  /**
   * Replace the entire index with the provided list. Used by bootstrap when
   * (re)loading durable evaluations from the project's `evals/` directory.
   */
  replaceAll(evaluations: Evaluation[]): void {
    this.save({ evaluations });
  }

  remove(evalId: string): boolean {
    const index = this.load();
    const before = index.evaluations.length;
    index.evaluations = index.evaluations.filter(e => e.eval_id !== evalId);
    if (index.evaluations.length < before) {
      this.save(index);
      return true;
    }
    return false;
  }

  /**
   * Compute evaluation coverage for an IU.
   */
  coverage(iu: ImplementationUnit): EvaluationCoverage {
    const evals = this.getByIU(iu.iu_id);
    const gaps: EvaluationGap[] = [];

    // Count by binding (in subject for the new model)
    const byBinding: Record<EvaluationBinding, number> = {
      domain_rule: 0, boundary_contract: 0, constraint: 0, invariant: 0, failure_mode: 0,
    };
    const byOrigin: Record<EvaluationOrigin, number> = {
      specified: 0, characterization: 0, observed: 0, incident: 0, audit: 0,
    };
    const coveredCanonIds = new Set<string>();

    for (const e of evals) {
      byBinding[e.subject.binding] = (byBinding[e.subject.binding] ?? 0) + 1;
      byOrigin[e.origin] = (byOrigin[e.origin] ?? 0) + 1;
      for (const cid of e.canon_ids ?? []) coveredCanonIds.add(cid);
    }

    // Check for missing coverage
    const uncoveredCanonIds = iu.source_canon_ids.filter(id => !coveredCanonIds.has(id));

    if (byBinding.boundary_contract === 0) {
      gaps.push({
        category: 'missing_boundary',
        subject: iu.iu_id,
        message: `No boundary contract evaluations for ${iu.name}`,
        recommended_action: 'Write evaluations asserting input/output behavior at the IU boundary',
      });
    }
    if (byBinding.failure_mode === 0) {
      gaps.push({
        category: 'missing_failure_mode',
        subject: iu.iu_id,
        message: `No failure mode evaluations for ${iu.name}`,
        recommended_action: 'Write evaluations asserting behavior under error conditions',
      });
    }
    if (byBinding.invariant === 0 && iu.contract.invariants.length > 0) {
      gaps.push({
        category: 'missing_invariant',
        subject: iu.iu_id,
        message: `${iu.contract.invariants.length} contract invariants but no invariant evaluations`,
        recommended_action: 'Write evaluations for each declared invariant',
      });
    }
    for (const e of evals) {
      if (e.last_status === undefined || e.last_status === 'untested') {
        gaps.push({
          category: 'untested',
          subject: e.eval_id,
          message: `Evaluation "${e.name}" has never been verified`,
          recommended_action: 'Run evaluation suite against current implementation',
        });
      }
    }
    // Check for stale evaluations (>90 days since last verification)
    const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
    for (const e of evals) {
      if (e.last_verified_at && e.last_verified_at < ninetyDaysAgo) {
        gaps.push({
          category: 'stale',
          subject: e.eval_id,
          message: `Evaluation "${e.name}" last verified >90 days ago`,
          recommended_action: 'Re-verify evaluation against current implementation',
        });
      }
    }

    const coverageRatio = iu.source_canon_ids.length > 0
      ? coveredCanonIds.size / iu.source_canon_ids.length
      : evals.length > 0 ? 1 : 0;

    return {
      iu_id: iu.iu_id,
      iu_name: iu.name,
      total_evaluations: evals.length,
      by_binding: byBinding,
      by_origin: byOrigin,
      canon_ids_covered: [...coveredCanonIds],
      canon_ids_uncovered: uncoveredCanonIds,
      coverage_ratio: coverageRatio,
      conservation_count: evals.filter(e => e.conservation).length,
      gaps,
    };
  }
}
