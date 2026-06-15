/**
 * #34 (root cause) — the web-ui emitted `create-reference` but had no `applyOp` case, so the op never
 * folded into state and the next `render()` (rebuilt from state) wiped the inline chip. The shell owns
 * applyOp/render, so its prompt now mandates: a fold case for EVERY op type (create-reference included)
 * and render-from-state, never one-shot live-DOM insertion.
 */
import { describe, it, expect } from 'vitest';
import { buildBoundedShellPrompt } from '../../src/llm/prompt.js';
import { resolveTarget } from '../../src/architectures/index.js';
import type { ImplementationUnit } from '../../src/models/iu.js';
import type { CanonicalNode } from '../../src/models/canonical.js';

describe('#34: the shell prompt mandates fold-every-op + render-from-state', () => {
  it('requires an applyOp case for every op type and forbids live-DOM-only changes', () => {
    const target = resolveTarget('web-api/node-typescript')!;
    const iu = { iu_id: 'web', name: 'Web Experience', risk_tier: 'low', source_canon_ids: ['w1'],
      contract: { description: '', inputs: [], outputs: [], invariants: [] } } as unknown as ImplementationUnit;
    const canon = [{ canon_id: 'w1', type: 'REQUIREMENT', statement: 'typing @ creates a reference',
      source_clause_ids: [], linked_canon_ids: [], tags: [] } as unknown as CanonicalNode];
    const p = buildBoundedShellPrompt(iu, canon, [], target);
    expect(p).toMatch(/case for EVERY/);
    expect(p).toMatch(/folds into model state/);
    expect(p).toMatch(/NEVER leave a change/);
    expect(p).toMatch(/range\.insertNode/);          // names the exact anti-pattern
    expect(p).toMatch(/silent no-op/);
  });
});
