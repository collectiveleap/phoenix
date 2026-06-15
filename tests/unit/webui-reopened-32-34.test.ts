/**
 * #32 (reopened) — the descriptive guard alone was non-deterministic (phantom `update` recurred
 * 3/5). Module-level NEGATION precedence (for mutating caps): a capability the spec negates anywhere
 * ("never modify or remove") is excluded even if a stray non-descriptive prose clause uses the verb —
 * without killing list/create on a noun-verb collision (e.g. the noun "store").
 *
 * #34 (reopened) — the op-fix landed but references still fail downstream; pinpointing needs a
 * Playwright trace. The generated config now retains a trace + screenshot on failure.
 */
import { describe, it, expect } from 'vitest';
import { declaredCrudCapabilities } from '../../src/architectures/dialects/rest.js';
import { generateScaffold } from '../../src/scaffold.js';
import { resolveTarget } from '../../src/architectures/index.js';
import type { ImplementationUnit } from '../../src/models/iu.js';
import type { CanonicalNode } from '../../src/models/canonical.js';

const iuWith = (statements: string[], invariants: string[]): { iu: ImplementationUnit; canon: CanonicalNode[] } => {
  const canon = statements.map((statement, i) =>
    ({ canon_id: `c${i}`, type: 'REQUIREMENT', statement, source_clause_ids: [], linked_canon_ids: [], tags: [] } as unknown as CanonicalNode));
  const iu = {
    iu_id: 'store', name: 'Store', source_canon_ids: canon.map(c => c.canon_id),
    contract: { description: '', inputs: [], outputs: [], invariants },
  } as unknown as ImplementationUnit;
  return { iu, canon };
};

describe('#32 reopened: module-level negation excludes a stray non-descriptive "update"', () => {
  it('a forbidden mutating cap is excluded even when a plain prose clause uses the verb — list/create survive', () => {
    // "updates the cache as it goes" has NO descriptive keyword (cache/goes) — the per-clause guard
    // would miss it; only module-level negation keeps `update` out. And the negated invariant mentions
    // the NOUN "store" (a create verb) — create must NOT be killed by that collision.
    const { iu, canon } = iuWith(
      [
        'the store must return all operations and append an operation',
        'the store updates the cache as it goes',
      ],
      ['the store must never modify or remove a logged operation'],
    );
    const caps = declaredCrudCapabilities(iu, canon);
    expect(caps).toEqual(['list', 'create']);
    expect(caps).not.toContain('update');
  });

  it('still keeps update/remove when the spec declares them and never negates them', () => {
    const { iu, canon } = iuWith(
      ['the user can create a node and list nodes, update a node by id, and delete a node'],
      [],
    );
    const caps = declaredCrudCapabilities(iu, canon);
    expect(caps).toContain('update');
    expect(caps).toContain('remove');
  });
});

describe('#34 reopened: the generated Playwright config retains a trace on failure', () => {
  it('captures trace + screenshot so a failing reference scenario can be pinpointed', () => {
    const target = resolveTarget('web-api/node-typescript')!;
    const services = [{ name: 'App', dir: 'app', modules: ['web-experience.ts'], ius: [], port: 3000 }];
    const cfg = generateScaffold(services as never, 'app', target, []).files.get('playwright.config.ts') ?? '';
    expect(cfg).toMatch(/trace:\s*'retain-on-failure'/);
    expect(cfg).toMatch(/screenshot:\s*'only-on-failure'/);
  });
});
