/**
 * REST interface dialect — renders the neutral interface contract as HTTP routes
 * (`{method, path}`) invoked via `fetch(url)`. This is the first dialect; it is the
 * transport-specific half of the cross-module contract fix (C1–C4). A non-REST
 * target (P2P/in-browser, RPC, message bus) supplies a different dialect; the core
 * contract machinery is unchanged.
 */

import type { ImplementationUnit } from '../../models/iu.js';
import type { CanonicalNode } from '../../models/canonical.js';
import type {
  InterfaceDialect, InterfaceContract, OperationSpec, OpRef,
} from '../../models/interface-contract.js';

/** REST addressing for an operation. */
interface RestAddress { method: 'GET' | 'POST' | 'PATCH' | 'DELETE'; path: string }

/** Slug an IU name to its mount path, matching the scaffold's server mount. */
export function mountForName(name: string): string {
  return '/' + name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
}

/** Base path of a URL/route: `/x/:id` → `/x`, `/x?q=1` → `/x`. */
function basePath(p: string): string {
  if (!p.startsWith('/')) return p;
  return '/' + p.slice(1).split(/[/?]/)[0];
}

/** The provider's mount = the base of any of its operation paths. */
function mountOfContract(c: InterfaceContract): string {
  const addr = c.operations[0]?.address as RestAddress | undefined;
  return addr ? basePath(addr.path) : '';
}

/** Name-similarity for repair (ported from regen.repairFetchPaths). */
function resourceSimilarity(a: string, b: string): number {
  if (a === b) return 10;
  const stem = (s: string) => s.replace(/s$/, '').replace(/ies$/, 'y');
  if (stem(a) === stem(b)) return 8;
  const groups = [
    ['task', 'todo', 'item', 'ticket', 'operation', 'op', 'entry', 'event'],
    ['project', 'workspace', 'board', 'category'],
    ['user', 'account', 'profile', 'member'],
  ];
  for (const g of groups) if (g.includes(stem(a)) && g.includes(stem(b))) return 5;
  return 0;
}

/** Resolve a consumer URL's base to a provider contract (mount match, then similarity). */
function resolveBase(base: string, contracts: InterfaceContract[]): InterfaceContract | null {
  const exact = contracts.find(c => mountOfContract(c) === base);
  if (exact) return exact;
  // Single provider: any unmatched call is unambiguous — bind it.
  if (contracts.length === 1) return contracts[0];
  // Otherwise best name similarity between the called resource and a provider.
  const want = base.slice(1).toLowerCase();
  let best: InterfaceContract | null = null;
  let bestScore = 0;
  for (const c of contracts) {
    const score = Math.max(
      resourceSimilarity(want, mountOfContract(c).slice(1).toLowerCase()),
      resourceSimilarity(want, c.identity.toLowerCase()),
    );
    if (score > bestScore) { bestScore = score; best = c; }
  }
  return bestScore > 0 ? best : null;
}

export const restDialect: InterfaceDialect = {
  deriveOperations(iu: ImplementationUnit, _canonNodes: CanonicalNode[]): OperationSpec[] {
    const mount = mountForName(iu.name);
    const a = (method: RestAddress['method'], path: string): RestAddress => ({ method, path });
    return [
      { name: 'list', purpose: 'list all', address: a('GET', mount) },
      { name: 'create', purpose: 'create one', address: a('POST', mount) },
      { name: 'get', purpose: 'get one by id', address: a('GET', `${mount}/:id`) },
      { name: 'update', purpose: 'update one by id', address: a('PATCH', `${mount}/:id`) },
      { name: 'remove', purpose: 'delete one by id', address: a('DELETE', `${mount}/:id`) },
    ];
  },

  describeForPrompt(contract: InterfaceContract): string {
    const lines = contract.operations.map(o => {
      const ad = o.address as RestAddress;
      return `    ${ad.method} ${ad.path} — ${o.purpose}`;
    });
    let out = `- "${contract.identity}" — call these EXACT endpoints with fetch(); do NOT invent paths:\n${lines.join('\n')}`;
    if (contract.shape) out += `\n    shape: ${contract.shape}`;
    return out;
  },

  generateClient(contracts: InterfaceContract[]): Record<string, string> {
    if (contracts.length === 0) return {};
    const blocks = contracts.map(c => {
      const mount = mountOfContract(c);
      const key = c.identity.replace(/[^a-zA-Z0-9]+(.)?/g, (_, ch) => (ch ? ch.toUpperCase() : ''));
      return `  ${key}: {
    list: () => fetch('${mount}').then(r => r.json()),
    create: (body) => fetch('${mount}', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.json()),
    get: (id) => fetch(\`${mount}/\${id}\`).then(r => r.json()),
    update: (id, body) => fetch(\`${mount}/\${id}\`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.json()),
    remove: (id) => fetch(\`${mount}/\${id}\`, { method: 'DELETE' }).then(r => r.json()),
  },`;
    });
    const content = `/** @internal Phoenix VCS — generated API client (interface contract). Do not edit. */
export const api = {
${blocks.join('\n')}
};
`;
    return { '_client.ts': content };
  },

  bindConsumer(code: string, contracts: InterfaceContract[]): string {
    if (contracts.length === 0) return code;
    const valid = new Set(contracts.map(mountOfContract));
    const rewrite = (url: string): string => {
      const base = basePath(url);
      if (valid.has(base)) return url;
      const target = resolveBase(base, contracts);
      if (!target) return url;
      return url.replace(base, mountOfContract(target));
    };
    // fetch('/x') / fetch("/x")
    code = code.replace(/fetch\(\s*(['"])(\/[^'"]+)\1/g, (m, q, url) => `fetch(${q}${rewrite(url)}${q}`);
    // fetch(`/x/${id}`) — rewrite only the leading literal base
    code = code.replace(/fetch\(\s*`(\/[^`]+)`/g, (m, url) => `fetch(\`${rewrite(url)}\``);
    return code;
  },

  extractConsumerCalls(code: string, contracts: InterfaceContract[]): OpRef[] {
    const refs: OpRef[] = [];
    const re = /fetch\(\s*['"`](\/[^'"`]+)['"`]/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(code)) !== null) {
      const raw = m[1];
      const base = basePath(raw);
      const target = contracts.find(c => mountOfContract(c) === base);
      refs.push({ raw, name: target ? target.identity : null });
    }
    return refs;
  },

  extractProviderOps(code: string, contract: InterfaceContract): OpRef[] {
    const mount = mountOfContract(contract);
    const refs: OpRef[] = [];
    const re = /router\.(get|post|patch|delete|put)\(\s*['"`]([^'"`]*)['"`]/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(code)) !== null) {
      const method = m[1].toUpperCase();
      const rel = m[2] || '/';
      const abs = rel === '/' ? mount : `${mount}${rel}`;
      const op = contract.operations.find(o => {
        const ad = o.address as RestAddress;
        return ad.method === method && ad.path === abs;
      });
      refs.push({ raw: `${method} ${abs}`, name: op ? op.name : null });
    }
    return refs;
  },
};
