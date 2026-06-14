/**
 * #33 — web-ui and store didn't share the operation wire contract (op-type vocab + {type,payload}
 * envelope), so every append 400'd. The plan-split bounded shell stripped the cross-section op
 * vocabulary that buildPrompt surfaces as "Related Context". Fix: surface the shared op wire
 * contract to the bounded shell (flowing shell → __CONTRACT__ → slices) + a no-invent rule.
 */
import { describe, it, expect } from 'vitest';
import { buildBoundedShellPrompt, buildCompactSlicePrompt } from '../../src/llm/prompt.js';
import { resolveTarget } from '../../src/architectures/index.js';
import type { ImplementationUnit } from '../../src/models/iu.js';
import type { CanonicalNode } from '../../src/models/canonical.js';

const target = resolveTarget('web-api/node-typescript')!;
const webIU = {
  iu_id: 'web', name: 'Web Experience', risk_tier: 'low', source_canon_ids: ['w1'],
  contract: { description: '', inputs: [], outputs: [], invariants: [] },
} as unknown as ImplementationUnit;
const node = (canon_id: string, type: string, statement: string): CanonicalNode =>
  ({ canon_id, type, statement, source_clause_ids: [], linked_canon_ids: [], tags: [] } as unknown as CanonicalNode);
const canon: CanonicalNode[] = [
  node('w1', 'REQUIREMENT', 'render the outline at GET /'),
  // a store-section definition the web IU does NOT own — the op wire vocabulary:
  node('d1', 'DEFINITION', 'An operation is { type, payload }; type is one of set-content, split, join'),
];

describe('#33: the bounded shell surfaces the shared op wire contract', () => {
  it('includes the cross-section op vocabulary and the no-invent envelope rule', () => {
    const p = buildBoundedShellPrompt(webIU, canon, [], target);
    expect(p).toMatch(/Shared model & operation vocabulary from other modules/);
    expect(p).toContain('set-content, split, join');   // the op vocab definition reached the shell
    expect(p).toMatch(/NEVER invent op names/);
    expect(p).toMatch(/\{ type, payload \}/);
    expect(p).toMatch(/wire:/);                          // recorded in the __CONTRACT__ block for slices
  });

  it('the compact slice prompt requires the contract wire format for backend POSTs', () => {
    const p = buildCompactSlicePrompt(webIU, [canon[0]], 'state: ...\nwire: { type, payload }', target, 0);
    expect(p).toMatch(/wire/);
    expect(p).toMatch(/NEVER invent op names/);
  });
});
