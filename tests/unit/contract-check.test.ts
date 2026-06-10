/**
 * C3 — cross-module interface contract check (+ provider conformance, Step 5).
 * Reproduces the outliner scenario: a web-ui that calls an address no module serves.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { checkInterfaceContracts } from '../../src/harness/contract-check.js';
import { restDialect } from '../../src/architectures/dialects/rest.js';
import { makeContract } from '../../src/models/interface-contract.js';
import type { ImplementationUnit } from '../../src/models/iu.js';
import type { CanonicalNode } from '../../src/models/canonical.js';
import type { InterfaceEntry } from '../../src/scaffold.js';

const STORE_FILE = 'src/generated/app/outliner-store.ts';
const WEB_FILE = 'src/generated/app/web-experience.ts';

const storeIU = { iu_id: 's', name: 'Outliner Store', output_files: [STORE_FILE] } as unknown as ImplementationUnit;
const webIU = { iu_id: 'w', name: 'Web Experience', output_files: [WEB_FILE] } as unknown as ImplementationUnit;

function interfaces(): InterfaceEntry[] {
  const ops = restDialect.deriveOperations(storeIU, []);
  return [
    { iu_id: 's', name: 'Outliner Store', mount_path: '/outliner-store', role: 'api', resource_fields: '', contract: makeContract('s', 'Outliner Store', ops, '') },
    { iu_id: 'w', name: 'Web Experience', mount_path: '', role: 'web-ui', resource_fields: '' },
  ];
}

describe('C3: cross-module contract check', () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'phoenix-cc-')); });

  const write = (rel: string, content: string) => {
    const p = join(root, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content, 'utf8');
  };
  const fullStore = `router.get('/', c=>{}); router.post('/', async c=>{}); router.get('/:id', c=>{}); router.patch('/:id', async c=>{}); router.delete('/:id', c=>{});`;

  it('flags a consumer call that no module serves (the outliner 404)', () => {
    write(STORE_FILE, fullStore);
    write(WEB_FILE, `const ops = await fetch('/operations').then(r=>r.json());`);
    const r = checkInterfaceContracts(root, [storeIU, webIU], interfaces(), restDialect);
    expect(r.ok).toBe(false);
    expect(r.violations.some(v => v.kind === 'consumer-unresolved' && /\/operations/.test(v.detail))).toBe(true);
  });

  it('passes when the consumer calls the declared mount', () => {
    write(STORE_FILE, fullStore);
    write(WEB_FILE, `await fetch('/outliner-store'); await fetch('/outliner-store', { method: 'POST' });`);
    const r = checkInterfaceContracts(root, [storeIU, webIU], interfaces(), restDialect);
    expect(r.ok).toBe(true);
    expect(r.checked).toBeGreaterThan(0);
  });

  it('flags a provider that does not implement a declared operation (conformance)', () => {
    write(STORE_FILE, `router.get('/', c=>{});`); // missing create/get/update/remove
    write(WEB_FILE, `await fetch('/outliner-store');`);
    const r = checkInterfaceContracts(root, [storeIU, webIU], interfaces(), restDialect, { checkProviders: true });
    expect(r.ok).toBe(false);
    expect(r.violations.some(v => v.kind === 'provider-missing' && /create/.test(v.detail))).toBe(true);
  });

  it('is a no-op pass when the architecture has no dialect (degrades to static boundary)', () => {
    write(WEB_FILE, `await fetch('/anything');`);
    const r = checkInterfaceContracts(root, [storeIU, webIU], interfaces(), undefined);
    expect(r.ok).toBe(true);
    expect(r.checked).toBe(0);
  });

  // P1.1 / R2 headline: the spec-correct append-only store (list + append only) now
  // PASSES conformance — before the fix the CRUD-template contract demanded
  // get/update/remove and failed it.
  it('an append-only store (spec-derived list+append) conforms — no demand for get/update/remove', () => {
    const canon = [
      { canon_id: 'a', statement: 'the store must return all operations in seq order' },
      { canon_id: 'b', statement: 'the store must validate and append an operation' },
    ] as unknown as CanonicalNode[];
    const appendStore = {
      iu_id: 's', name: 'Outliner Store', output_files: [STORE_FILE], source_canon_ids: ['a', 'b'],
      contract: { description: 'append-only log of operations', inputs: [], outputs: [],
        invariants: ['the store must never modify or remove a logged operation; the log only ever grows'] },
    } as unknown as ImplementationUnit;
    const ops = restDialect.deriveOperations(appendStore, canon); // → list + create only
    expect(ops.map(o => o.name)).toEqual(['list', 'create']);
    const ifaces: InterfaceEntry[] = [
      { iu_id: 's', name: 'Outliner Store', mount_path: '/outliner-store', role: 'api', resource_fields: '', contract: makeContract('s', 'Outliner Store', ops, '') },
      { iu_id: 'w', name: 'Web Experience', mount_path: '', role: 'web-ui', resource_fields: '' },
    ];
    write(STORE_FILE, `router.get('/', c=>{}); router.post('/', async c=>{});`); // append-only provider
    write(WEB_FILE, `await fetch('/outliner-store'); await fetch('/outliner-store', { method: 'POST' });`);
    const r = checkInterfaceContracts(root, [appendStore, webIU], ifaces, restDialect, { checkProviders: true });
    expect(r.ok).toBe(true);
    expect(r.violations).toHaveLength(0);
  });
});
