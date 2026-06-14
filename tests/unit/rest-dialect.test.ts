/**
 * REST interface dialect — the transport-specific half of the cross-module
 * contract (C1–C4). Validates against the actual outliner scenario:
 * web-ui fetched /operations while the store mounts at /outliner-store.
 */
import { describe, it, expect } from 'vitest';
import { restDialect, mountForName, declaredCrudCapabilities } from '../../src/architectures/dialects/rest.js';
import { makeContract } from '../../src/models/interface-contract.js';
import type { ImplementationUnit } from '../../src/models/iu.js';
import type { CanonicalNode } from '../../src/models/canonical.js';

const iu = (name: string) => ({ name } as unknown as ImplementationUnit);

/** Build an IU + canon from requirement statements (+ optional invariants/description). */
function behaviorIU(
  name: string,
  requirements: string[],
  invariants: string[] = [],
  description = '',
): { iu: ImplementationUnit; canon: CanonicalNode[] } {
  const canon = requirements.map((statement, i) =>
    ({ canon_id: `r${i}`, type: 'REQUIREMENT', statement } as unknown as CanonicalNode));
  const built = {
    name,
    source_canon_ids: canon.map(c => c.canon_id),
    contract: { description, inputs: [], outputs: [], invariants },
  } as unknown as ImplementationUnit;
  return { iu: built, canon };
}

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
    expect(desc).toContain('POST /outliner-store — create/append one');
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

  it('rewrites a variable-held invented URL used via fetch(VAR) (#6)', () => {
    // The bypass shape: the page hand-rolls `var STORE = '/operations'` then `fetch(STORE)`.
    const code = `var STORE = '/operations';\nasync function load() { return fetch(STORE).then(r => r.json()); }`;
    const fixed = restDialect.bindConsumer(code, [storeContract()]);
    expect(fixed).toContain(`var STORE = '/outliner-store'`);
    expect(fixed).not.toContain(`'/operations'`);
  });
});

describe('REST dialect: extract for the contract check (C3)', () => {
  it('resolves a matching consumer call and flags an unresolved one', () => {
    const code = `fetch('/outliner-store'); fetch('/totally-unknown');`;
    const refs = restDialect.extractConsumerCalls(code, [storeContract()]);
    expect(refs.find(r => r.raw === '/outliner-store')?.name).toBe('Outliner Store');
    expect(refs.find(r => r.raw === '/totally-unknown')?.name).toBeNull();
  });

  it('resolves a fetch via a URL variable and flags an invented one (#6)', () => {
    // The static check must see the page's REAL target, not just literal fetch() args.
    const bad = `var STORE = '/operations';\nfetch(STORE);`;
    expect(restDialect.extractConsumerCalls(bad, [storeContract()]).find(r => r.raw === '/operations')?.name).toBeNull();
    const good = `const STORE = '/outliner-store';\nfetch(STORE);`;
    expect(restDialect.extractConsumerCalls(good, [storeContract()]).find(r => r.raw === '/outliner-store')?.name).toBe('Outliner Store');
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

describe('P1.1: operations come from the module\'s declared behaviors, not a CRUD template', () => {
  it('an append-only store yields list + create (append) — never get/update/remove', () => {
    const { iu: store, canon } = behaviorIU(
      'Outliner Store',
      [
        'the store must return all operations in seq order, accepting an optional since seq',
        'the store must validate and append an operation, returning the stored operation',
      ],
      ['the store must never modify or remove a logged operation; the log only ever grows'],
      'an append-only log of operations',
    );
    const caps = declaredCrudCapabilities(store, canon);
    expect(caps).toEqual(['list', 'create']);
    const ops = restDialect.deriveOperations(store, canon).map(o => o.name);
    expect(ops).toEqual(['list', 'create']);
    expect(ops).not.toContain('update');
    expect(ops).not.toContain('remove');
  });

  it('does not reify the prose verb "update" from descriptive UI behaviour (#32)', () => {
    // The store's op vocabulary is append/list; "updates" here is ordinary prose describing UI
    // behaviour, not a store operation. It must not become a phantom `update` op the store fails on.
    const { iu: store, canon } = behaviorIU(
      'Outliner Store',
      [
        'the store must append an operation and return the stored operation',
        'the store must list all operations in seq order',
        'the screen updates with no delay and the store appends the operation in the background',
        'the system updates every occurrence of a node on each keystroke, live everywhere',
      ],
      [],
      'an append-only operation log',
    );
    const caps = declaredCrudCapabilities(store, canon);
    expect(caps).toEqual(['list', 'create']);
    expect(caps).not.toContain('update');
  });

  it('keeps update/remove for an entity that declares them — even under an append-only invariant', () => {
    // Storage discipline (append-only) must NOT strip the API surface: an entity
    // that declares delete/update keeps them (implemented as append/tombstone).
    const { iu: node, canon } = behaviorIU(
      'Nodes',
      [
        'the user can create a node and list nodes',
        'the user can update a node\'s text',
        'the user can delete a node',
      ],
      ['every change is stored append-only; the log is immutable'],
    );
    const caps = declaredCrudCapabilities(node, canon);
    expect(caps).toContain('update');
    expect(caps).toContain('remove');
  });

  it('a spec that declares no operations falls back to full CRUD (no regression)', () => {
    // The no-contract/empty IU the other tests use → unchanged behavior.
    expect(restDialect.deriveOperations(iu('Outliner Store'), []).map(o => o.name))
      .toEqual(['list', 'create', 'get', 'update', 'remove']);
  });
});

describe('P1.2: the generated client is operation-driven and typed (no implicit-any)', () => {
  it('emits only the contract\'s operations, with typed params', () => {
    const ops = restDialect.deriveOperations(
      behaviorIU('Outliner Store', ['list operations', 'append an operation']).iu,
      behaviorIU('Outliner Store', ['list operations', 'append an operation']).canon,
    );
    const contract = makeContract('s', 'Outliner Store', ops, '');
    const client = restDialect.generateClient([contract])['_client.ts'];

    expect(client).toContain('list: ()');
    expect(client).toContain('create: (body: unknown)');     // typed → no TS7006
    expect(client).not.toContain('get:');                    // not declared
    expect(client).not.toContain('update:');
    expect(client).not.toContain('remove:');
    // No untyped parameter declarations (the TS7006 source); body in JSON.stringify(body) is fine.
    expect(client).not.toMatch(/:\s*\((body|id)\)\s*=>/);
  });
});
