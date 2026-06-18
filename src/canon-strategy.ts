/**
 * Canonicalization identity strategy — a pluggable seam (mirrors `WebUIStrategy` in regen.ts) that
 * decides whether the LLM's statement rewrite enters the content-addressed identity of a canonical node.
 *
 * #36: the LLM normalizer is non-deterministic (claude-cli ignores its `temperature`), so when its
 * rewrite feeds `candidate_id`, the chain `canon_id → iu_id → generated code → verdict` all churns
 * run-to-run. This seam lets the existing behavior and the rule-anchored fix coexist as A/B
 * alternatives, measured by `phoenix canon-compare`.
 */
import { sha256 } from './semhash.js';
import type { CandidateNode, CanonicalNode } from './models/canonical.js';

export interface CanonIdentityStrategy {
  name: string;
  description: string;
  /**
   * Given the deterministic rule-extracted candidate and the LLM's rewrite, return the candidate to
   * resolve — deciding whether the rewrite enters the content-addressed identity (`candidate_id`).
   */
  applyNormalization(candidate: CandidateNode, normalized: string): CandidateNode;
}

/** Existing behavior: the LLM rewrite defines identity — `candidate_id` is recomputed from it. */
export const llmIdentityStrategy: CanonIdentityStrategy = {
  name: 'llm-identity',
  description: 'LLM rewrite defines identity: candidate_id is recomputed from the normalized statement (non-deterministic on an unseeded model).',
  applyNormalization(c, normalized) {
    const newId = sha256([c.type, normalized, c.source_clause_ids[0]].join('\x00'));
    return { ...c, candidate_id: newId, statement: normalized, extraction_method: 'llm' };
  },
};

/** Fix A: identity stays anchored to the deterministic rule extraction; the LLM rewrite is cosmetic. */
export const ruleIdentityStrategy: CanonIdentityStrategy = {
  name: 'rule-identity',
  description: 'Rule extraction defines identity: candidate_id is preserved; the LLM rewrite updates only the displayed statement (deterministic identity).',
  applyNormalization(c, normalized) {
    return { ...c, statement: normalized, extraction_method: 'llm' };
  },
};

export const CANON_STRATEGIES: Record<string, CanonIdentityStrategy> = {
  'llm-identity': llmIdentityStrategy,
  'rule-identity': ruleIdentityStrategy,
};

/** Default keeps the existing behavior — no silent change to a core primitive. Flip only with evidence. */
export const DEFAULT_CANON_STRATEGY = 'llm-identity';

/** Resolve the active strategy from `PHOENIX_CANON_STRATEGY` (default = current behavior). */
export function selectCanonStrategy(name?: string): CanonIdentityStrategy {
  const key = name ?? process.env.PHOENIX_CANON_STRATEGY ?? DEFAULT_CANON_STRATEGY;
  return CANON_STRATEGIES[key] ?? CANON_STRATEGIES[DEFAULT_CANON_STRATEGY];
}

/**
 * Identity-based hash of a canonical graph: the structural identity that drives IU planning —
 * `canon_id`, type, and sorted edges — NOT the (possibly LLM-rewritten) statement. Two runs whose
 * graphs share this hash plan the same IUs. Used by both the A/B harness and the provenance gate, so
 * "the canonical graph" means the same thing in each.
 */
export function canonicalGraphHash(nodes: CanonicalNode[]): string {
  return sha256(
    nodes
      .map(n => `${n.canon_id}:${n.type}:${[...(n.linked_canon_ids ?? [])].sort().join(',')}`)
      .sort().join('\n'),
  );
}
