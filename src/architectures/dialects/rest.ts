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

/** Map `const/let/var NAME = '/path'` declarations to their literal URL (#6). */
function urlVarDecls(code: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /(?:const|let|var)\s+(\w+)\s*=\s*['"`](\/[^'"`]+)['"`]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code)) !== null) out[m[1]] = m[2];
  return out;
}

/** Identifiers used as the target of a `fetch(...)` call (incl. `fetch(`${NAME}…`)`) (#6). */
function fetchedIdents(code: string): Set<string> {
  const out = new Set<string>();
  const re = /fetch\(\s*`?\$?\{?\s*(\w+)\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code)) !== null) out.add(m[1]);
  return out;
}

/** The CRUD-shaped capabilities a REST contract can expose, in canonical order. */
type Capability = 'list' | 'create' | 'get' | 'update' | 'remove';
const CAPABILITY_ORDER: Capability[] = ['list', 'create', 'get', 'update', 'remove'];

/**
 * Verbs that declare each capability. Detection is over the module's *positive*
 * behaviors (what it does), and is **negation-aware** — "must never modify or
 * remove" declares nothing, so an append-only store yields list+create, not
 * update/remove. The contract is the API surface; how a mutation is implemented
 * (in-place / append / tombstone) is the provider's concern, not the contract's.
 */
const CAPABILITY_VERBS: Record<Capability, RegExp> = {
  list: /\b(list|index|enumerate|query|return all|returns all|get all|fetch all|all (?:the )?\w+s\b)\b/,
  create: /\b(create|add|append|insert|log|record|store|submit|register|post)\b/,
  // get-one needs an id/singular context so "get all" / "list" don't trip it.
  get: /\b(get|read|retrieve|fetch|view|show|look ?up)\b[^.;]*\b(by id|by its|by the|single|one|specific)\b/,
  update: /\b(update|modify|edit|change|patch|rename|replace)\b/,
  remove: /\b(delete|remove|destroy|purge|drop)\b/,
};
const NEGATION = /\b(never|not|no|cannot|can't|must not|may not|won't|shall not)\b/;

/**
 * Derive the CRUD capabilities a module *declares*, from its behavior statements.
 * A capability is included iff one of its verbs appears in a non-negated clause.
 * Falls back to full CRUD when nothing is detected (sparse/empty spec) so a spec
 * that doesn't enumerate operations keeps today's behavior — narrowing happens
 * only when the spec actually declares a subset.
 */
export function declaredCrudCapabilities(iu: ImplementationUnit, canonNodes: CanonicalNode[]): Capability[] {
  const own = canonNodes.filter(n => iu.source_canon_ids?.includes(n.canon_id));
  const statements = [
    iu.contract?.description ?? '',
    ...own.map(n => n.statement),
    ...(iu.contract?.invariants ?? []),
  ];
  // Clause-level scan so a negation only suppresses verbs in its own clause.
  const clauses = statements.flatMap(s => s.toLowerCase().split(/[.;,\n]/)).filter(Boolean);
  const found = new Set<Capability>();
  for (const cap of CAPABILITY_ORDER) {
    const verb = CAPABILITY_VERBS[cap];
    for (const clause of clauses) {
      if (verb.test(clause) && !NEGATION.test(clause)) { found.add(cap); break; }
    }
  }
  if (found.size === 0) return [...CAPABILITY_ORDER]; // nothing declared → full CRUD (no regression)
  return CAPABILITY_ORDER.filter(c => found.has(c));
}

export const restDialect: InterfaceDialect = {
  deriveOperations(iu: ImplementationUnit, canonNodes: CanonicalNode[]): OperationSpec[] {
    const mount = mountForName(iu.name);
    const a = (method: RestAddress['method'], path: string): RestAddress => ({ method, path });
    const spec: Record<Capability, OperationSpec> = {
      list: { name: 'list', purpose: 'list all', address: a('GET', mount) },
      create: { name: 'create', purpose: 'create/append one', address: a('POST', mount) },
      get: { name: 'get', purpose: 'get one by id', address: a('GET', `${mount}/:id`) },
      update: { name: 'update', purpose: 'update one by id', address: a('PATCH', `${mount}/:id`) },
      remove: { name: 'remove', purpose: 'delete one by id', address: a('DELETE', `${mount}/:id`) },
    };
    // Operations come from the module's declared behaviors, not a fixed CRUD set.
    return declaredCrudCapabilities(iu, canonNodes).map(c => spec[c]);
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
    // Typed method per declared operation (params from the op shape) so the
    // generated "do not edit" file passes the strict tsconfig Phoenix writes —
    // and only the operations the contract actually declares are emitted.
    const JSON_HDR = `{ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }`;
    const method = (mount: string, opName: string): string | null => {
      switch (opName) {
        case 'list':   return `    list: (): Promise<unknown> => fetch('${mount}').then(r => r.json()),`;
        case 'create': return `    create: (body: unknown): Promise<unknown> => fetch('${mount}', ${JSON_HDR}).then(r => r.json()),`;
        case 'get':    return `    get: (id: string): Promise<unknown> => fetch(\`${mount}/\${id}\`).then(r => r.json()),`;
        case 'update': return `    update: (id: string, body: unknown): Promise<unknown> => fetch(\`${mount}/\${id}\`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.json()),`;
        case 'remove': return `    remove: (id: string): Promise<unknown> => fetch(\`${mount}/\${id}\`, { method: 'DELETE' }).then(r => r.json()),`;
        default:       return null;
      }
    };
    const blocks = contracts.map(c => {
      const mount = mountOfContract(c);
      const key = c.identity.replace(/[^a-zA-Z0-9]+(.)?/g, (_, ch) => (ch ? ch.toUpperCase() : ''));
      const methods = c.operations.map(o => method(mount, o.name)).filter(Boolean).join('\n');
      return `  ${key}: {\n${methods}\n  },`;
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
    // Variable-held store URL used via fetch(NAME): rewrite the declaration so the
    // page's real target binds to the provider mount (#6) — a bare `var STORE='/operations'`
    // that fetch() then uses is otherwise invisible to the literal-only rewrites above.
    const fetched = fetchedIdents(code);
    if (fetched.size > 0) {
      code = code.replace(
        /((?:const|let|var)\s+(\w+)\s*=\s*(['"`]))(\/[^'"`]+)(\3)/g,
        (full, pre, name, _q, url, close) => (fetched.has(name) ? `${pre}${rewrite(url)}${close}` : full),
      );
    }
    return code;
  },

  extractConsumerCalls(code: string, contracts: InterfaceContract[]): OpRef[] {
    const refs: OpRef[] = [];
    const add = (raw: string) => {
      const target = contracts.find(c => mountOfContract(c) === basePath(raw));
      refs.push({ raw, name: target ? target.identity : null });
    };
    // Literal fetch('/x') / fetch(`/x/${id}`)
    const lit = /fetch\(\s*['"`](\/[^'"`]+)['"`]/g;
    let m: RegExpExecArray | null;
    while ((m = lit.exec(code)) !== null) add(m[1]);
    // fetch(NAME) where NAME holds a URL — the page's real target via indirection (#6),
    // which the literal regex misses; validate it so an invented `/operations` can't pass.
    const vars = urlVarDecls(code);
    for (const name of fetchedIdents(code)) if (vars[name]) add(vars[name]);
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
