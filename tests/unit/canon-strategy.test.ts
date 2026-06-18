/**
 * #36 — canonicalization identity strategy seam. The non-determinism root cause was the LLM's rewrite
 * feeding the content-addressed identity (canon_id → iu_id → code → verdict). The seam keeps the
 * existing behavior (`llm-identity`) and the rule-anchored fix (`rule-identity`) as A/B alternatives.
 * These tests lock the identity property per strategy and prove rule-identity makes canon_id stable
 * across runs even when the LLM rewrites differently each time.
 */
import { describe, it, expect, afterEach } from 'vitest';
import {
  selectCanonStrategy, CANON_STRATEGIES, DEFAULT_CANON_STRATEGY,
  llmIdentityStrategy, ruleIdentityStrategy,
} from '../../src/canon-strategy.js';
import { canonicalize } from '../../src/canonicalizer-llm.js';
import { parseSpec } from '../../src/spec-parser.js';
import { CanonicalType } from '../../src/models/canonical.js';
import type { CandidateNode } from '../../src/models/canonical.js';
import type { LLMProvider, GenerateOptions, StreamHooks } from '../../src/llm/provider.js';

afterEach(() => { delete process.env.PHOENIX_CANON_STRATEGY; });

function candidate(): CandidateNode {
  return {
    candidate_id: 'rule-id-123',
    type: CanonicalType.REQUIREMENT,
    statement: 'rule normalized statement',
    source_clause_ids: ['clause-1'],
    extraction_method: 'rule',
  } as unknown as CandidateNode;
}

describe('#36 registry + selection', () => {
  it('defaults to llm-identity (existing), selects by name, unknown falls back', () => {
    expect(selectCanonStrategy().name).toBe('llm-identity');
    expect(DEFAULT_CANON_STRATEGY).toBe('llm-identity');
    expect(selectCanonStrategy('rule-identity').name).toBe('rule-identity');
    expect(selectCanonStrategy('does-not-exist').name).toBe(DEFAULT_CANON_STRATEGY);
    expect(Object.keys(CANON_STRATEGIES).sort()).toEqual(['llm-identity', 'rule-identity']);
  });

  it('honors PHOENIX_CANON_STRATEGY', () => {
    process.env.PHOENIX_CANON_STRATEGY = 'rule-identity';
    expect(selectCanonStrategy().name).toBe('rule-identity');
  });
});

describe('#36 applyNormalization identity policy', () => {
  it('rule-identity preserves candidate_id; the rewrite updates only the statement', () => {
    const c = candidate();
    const a = ruleIdentityStrategy.applyNormalization(c, 'rewrite A');
    const b = ruleIdentityStrategy.applyNormalization(c, 'a completely different rewrite B');
    expect(a.candidate_id).toBe('rule-id-123');
    expect(b.candidate_id).toBe('rule-id-123');   // identity is invariant to the LLM phrasing
    expect(a.statement).toBe('rewrite A');
    expect(a.extraction_method).toBe('llm');
  });

  it('llm-identity recomputes candidate_id from the rewrite (so different phrasing ⇒ different id)', () => {
    const c = candidate();
    const a = llmIdentityStrategy.applyNormalization(c, 'rewrite A');
    const b = llmIdentityStrategy.applyNormalization(c, 'a completely different rewrite B');
    expect(a.candidate_id).not.toBe('rule-id-123');
    expect(a.candidate_id).not.toBe(b.candidate_id);
    expect(a.statement).toBe('rewrite A');
  });
});

/** A provider whose normalization differs on every call — stands in for an unseeded LLM. */
class CountingProvider implements LLMProvider {
  readonly name = 'fake'; readonly model = 'test';
  calls = 0;
  async generate(_p: string, _o?: GenerateOptions): Promise<string> {
    this.calls++;
    return JSON.stringify({ statement: `Canonical form variant ${this.calls}` });
  }
  generateStream(p: string, o?: GenerateOptions, _hooks?: StreamHooks): Promise<string> {
    return this.generate(p, o);
  }
}

describe('#36 end-to-end: identity stability across runs (the property the harness measures)', () => {
  const clauses = parseSpec('# Store\n\nThe system must persist each operation.', 'spec.md');
  const canonIds = async (strategy: string, llm: LLMProvider): Promise<string[]> => {
    const res = await canonicalize(clauses, llm, { strategy });
    return res.nodes.map(n => n.canon_id).sort();
  };

  it('rule-identity yields the same canon_id set across two runs despite different rewrites', async () => {
    const llm = new CountingProvider();
    const a = await canonIds('rule-identity', llm);
    const b = await canonIds('rule-identity', llm);          // provider keeps counting → different text
    expect(llm.calls).toBeGreaterThan(0);                    // normalization actually ran
    expect(a).toEqual(b);
  });

  it('llm-identity yields a different canon_id set across two runs (the #36 churn)', async () => {
    const llm = new CountingProvider();
    const a = await canonIds('llm-identity', llm);
    const b = await canonIds('llm-identity', llm);
    expect(a).not.toEqual(b);
  });
});
