/**
 * #34 — the @ picker committed `link` (structural) instead of `create-reference` (inline mention),
 * so no chip rendered. Slice guidance now requires emitting the EXACT op a gesture names.
 * #35 — a scenario seeded `unique('offline')` which matched its own error regex → strict-mode
 * 2-match failure. UI-scenario guidance now requires neutral seeds + role/container-scoped
 * error assertions.
 */
import { describe, it, expect } from 'vitest';
import { nodeTypescript } from '../../src/architectures/node-typescript.js';
import { buildCompactSlicePrompt } from '../../src/llm/prompt.js';
import { resolveTarget } from '../../src/architectures/index.js';
import type { ImplementationUnit } from '../../src/models/iu.js';
import type { CanonicalNode } from '../../src/models/canonical.js';

describe('#34: slice prompt requires the exact op a gesture names (no related-op substitution)', () => {
  it('forbids substituting a related op (e.g. link for create-reference)', () => {
    const iu = { iu_id: 'web', name: 'Web Experience', source_canon_ids: ['w1'] } as unknown as ImplementationUnit;
    const node = { canon_id: 'w1', type: 'REQUIREMENT', statement: 'typing @ creates a reference', source_clause_ids: [], linked_canon_ids: [], tags: [] } as unknown as CanonicalNode;
    const p = buildCompactSlicePrompt(iu, [node], 'state: ...', resolveTarget('web-api/node-typescript'), 0);
    expect(p).toMatch(/EXACT operation each behaviour NAMES/);
    expect(p).toMatch(/create-reference.*NOT the structural `link`/);
  });
});

describe('#35: ui-scenario guidance avoids seed/assertion collisions', () => {
  const ui = nodeTypescript.uiGuidance ?? '';
  it('requires neutral seeds that do not match a later assertion regex', () => {
    expect(ui).toMatch(/Seed data must NOT collide/);
    expect(ui).toMatch(/unique\('offline'\)/);   // the concrete anti-pattern
    expect(ui).toMatch(/unique\('note'\)/);       // the neutral alternative
  });
  it('requires error/status assertions scoped to the indicator, not a page-wide regex', () => {
    expect(ui).toMatch(/getByRole\('status'\)/);
    expect(ui).toMatch(/NOT a page-wide text regex/);
  });
});
