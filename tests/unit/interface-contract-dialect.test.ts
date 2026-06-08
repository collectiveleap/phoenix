/**
 * Architecture generality — the load-bearing test for the dialect seam.
 *
 * A fake NON-REST dialect: operations are addressed by message topic (no URLs, no
 * HTTP methods, no `/` paths) — the P2P/in-browser shape. It drives the SAME core
 * (`checkInterfaceContracts`) to the same outcomes, proving nothing transport-
 * specific leaked into the core contract machinery.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { checkInterfaceContracts } from '../../src/harness/contract-check.js';
import { makeContract } from '../../src/models/interface-contract.js';
import type { InterfaceDialect, InterfaceContract, OpRef, OperationSpec } from '../../src/models/interface-contract.js';
import type { ImplementationUnit } from '../../src/models/iu.js';
import type { InterfaceEntry } from '../../src/scaffold.js';

/** A message-bus dialect: operations addressed by topic, invoked via call("topic"). */
const messageDialect: InterfaceDialect = {
  deriveOperations(iu: ImplementationUnit): OperationSpec[] {
    const base = iu.name.toLowerCase().replace(/\s+/g, '.');
    return [
      { name: 'append', purpose: 'append', address: { topic: `${base}.append` } },
      { name: 'list', purpose: 'list', address: { topic: `${base}.list` } },
    ];
  },
  describeForPrompt(c) {
    return `- "${c.identity}" — send these topics: ${c.operations.map(o => (o.address as { topic: string }).topic).join(', ')}`;
  },
  generateClient() { return {}; },
  bindConsumer(code, contracts) {
    const topics = new Set(contracts.flatMap(c => c.operations.map(o => (o.address as { topic: string }).topic)));
    return code.replace(/call\("([^"]+)"\)/g, (m, t) => {
      if (topics.has(t)) return m;
      if (contracts.length === 1) return `call("${(contracts[0].operations[0].address as { topic: string }).topic}")`;
      return m;
    });
  },
  extractConsumerCalls(code, contracts): OpRef[] {
    const refs: OpRef[] = [];
    const re = /call\("([^"]+)"\)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(code))) {
      const topic = m[1];
      const owner = contracts.find(c => c.operations.some(o => (o.address as { topic: string }).topic === topic));
      refs.push({ raw: topic, name: owner ? owner.identity : null });
    }
    return refs;
  },
  extractProviderOps(code, contract): OpRef[] {
    const refs: OpRef[] = [];
    const re = /handle\("([^"]+)"\)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(code))) {
      const op = contract.operations.find(o => (o.address as { topic: string }).topic === m![1]);
      refs.push({ raw: m[1], name: op ? op.name : null });
    }
    return refs;
  },
};

const storeIU = { iu_id: 's', name: 'Store', output_files: ['src/generated/app/store.ts'] } as unknown as ImplementationUnit;
const webIU = { iu_id: 'w', name: 'Web Experience', output_files: ['src/generated/app/web.ts'] } as unknown as ImplementationUnit;

function interfaces(): InterfaceEntry[] {
  const ops = messageDialect.deriveOperations(storeIU, []);
  return [
    { iu_id: 's', name: 'Store', mount_path: '', role: 'api', resource_fields: '', contract: makeContract('s', 'Store', ops, '') },
    { iu_id: 'w', name: 'Web Experience', mount_path: '', role: 'web-ui', resource_fields: '' },
  ];
}

describe('dialect seam: a non-REST (topic) dialect drives the same contract core', () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'phoenix-dlx-')); });
  const write = (rel: string, content: string) => {
    const p = join(root, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content, 'utf8');
  };
  const fullProvider = `handle("store.append"); handle("store.list");`;

  it('flags a consumer that sends an undeclared topic (no URLs involved)', () => {
    write('src/generated/app/store.ts', fullProvider);
    write('src/generated/app/web.ts', `call("store.nope");`);
    const r = checkInterfaceContracts(root, [storeIU, webIU], interfaces(), messageDialect);
    expect(r.ok).toBe(false);
    expect(r.violations[0].detail).toContain('store.nope');
  });

  it('passes when the consumer sends a declared topic', () => {
    write('src/generated/app/store.ts', fullProvider);
    write('src/generated/app/web.ts', `call("store.append");`);
    expect(checkInterfaceContracts(root, [storeIU, webIU], interfaces(), messageDialect).ok).toBe(true);
  });

  it('flags provider conformance against the topic contract', () => {
    write('src/generated/app/store.ts', `handle("store.append");`); // missing store.list
    write('src/generated/app/web.ts', `call("store.append");`);
    const r = checkInterfaceContracts(root, [storeIU, webIU], interfaces(), messageDialect, { checkProviders: true });
    expect(r.ok).toBe(false);
    expect(r.violations.some(v => v.kind === 'provider-missing' && /list/.test(v.detail))).toBe(true);
  });

  it('auto-repairs an undeclared topic to the single provider (transport-agnostic bindConsumer)', () => {
    const fixed = messageDialect.bindConsumer(`call("store.nope")`, interfaces().filter(e => e.contract).map(e => e.contract!));
    expect(fixed).toBe(`call("store.append")`);
  });
});
