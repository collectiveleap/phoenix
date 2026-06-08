/**
 * REST interface dialect — the transport-specific half of the cross-module
 * contract (C1–C4). Validates against the actual outliner scenario:
 * web-ui fetched /operations while the store mounts at /outliner-store.
 */
import { describe, it, expect } from 'vitest';
import { restDialect, mountForName } from '../../src/architectures/dialects/rest.js';
import { makeContract } from '../../src/models/interface-contract.js';
import type { ImplementationUnit } from '../../src/models/iu.js';

const iu = (name: string) => ({ name } as unknown as ImplementationUnit);

/** The outliner store contract: derived ops for "Outliner Store" (mount /outliner-store). */
function storeContract() {
  const ops = restDialect.deriveOperations(iu('Outliner Store'), []);
  return makeContract('store-iu', 'Outliner Store', ops, 'an operation has a seq and a payload');
}

describe('REST dialect: derive + describe', () => {
  it('derives CRUD operations addressed at the module mount', () => {
    const c = storeContract();
    expect(mountForName('Outliner Store')).toBe('/outliner-store');
    const list = c.operations.find(o => o.name === 'list')!;
    expect(list.address).toEqual({ method: 'GET', path: '/outliner-store' });
    const create = c.operations.find(o => o.name === 'create')!;
    expect(create.address).toEqual({ method: 'POST', path: '/outliner-store' });
    expect(c.operations.find(o => o.name === 'get')!.address).toEqual({ method: 'GET', path: '/outliner-store/:id' });
  });

  it('renders explicit endpoints for the consumer prompt (no invented paths)', () => {
    const desc = restDialect.describeForPrompt(storeContract());
    expect(desc).toContain('GET /outliner-store — list all');
    expect(desc).toContain('POST /outliner-store — create one');
    expect(desc).toContain('do NOT invent paths');
  });
});

describe('REST dialect: bindConsumer auto-repair (the outliner 404 fix)', () => {
  it('rewrites an invented path to the single provider mount', () => {
    const code = `const ops = await fetch('/operations').then(r => r.json());`;
    const fixed = restDialect.bindConsumer(code, [storeContract()]);
    expect(fixed).toContain(`fetch('/outliner-store')`);
    expect(fixed).not.toContain(`fetch('/operations')`);
  });

  it('rewrites a template-literal path and leaves a correct path untouched', () => {
    const code = "const a = fetch(`/operations/${id}`); const b = fetch('/outliner-store');";
    const fixed = restDialect.bindConsumer(code, [storeContract()]);
    expect(fixed).toContain('fetch(`/outliner-store/${id}`)');
    expect(fixed).toContain(`fetch('/outliner-store')`);
  });
});

describe('REST dialect: extract for the contract check (C3)', () => {
  it('resolves a matching consumer call and flags an unresolved one', () => {
    const code = `fetch('/outliner-store'); fetch('/totally-unknown');`;
    const refs = restDialect.extractConsumerCalls(code, [storeContract()]);
    expect(refs.find(r => r.raw === '/outliner-store')?.name).toBe('Outliner Store');
    expect(refs.find(r => r.raw === '/totally-unknown')?.name).toBeNull();
  });

  it('extracts provider routes and matches them to contract operations', () => {
    const code = `router.get('/', (c) => {}); router.post('/', async (c) => {}); router.get('/:id', (c) => {});`;
    const refs = restDialect.extractProviderOps(code, storeContract());
    const names = refs.map(r => r.name);
    expect(names).toContain('list');
    expect(names).toContain('create');
    expect(names).toContain('get');
  });
});
