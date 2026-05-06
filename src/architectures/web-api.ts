/**
 * Architecture: web-api
 *
 * An API-driven web application. Components communicate via REST endpoints.
 * Each resource owns its data mutations. Components are independently
 * testable via HTTP endpoint contracts.
 *
 * This architecture is language/runtime agnostic.
 */

import type {
  Architecture,
  EvalSurface,
  EvalContext,
  EvalResult,
} from '../models/architecture.js';
import type { Evaluation } from '../models/evaluation.js';

// ─── Evaluation runner (HTTP step definitions) ──────────────────────────────
//
// Step definitions translate domain-language Given/When/Then phrases into
// HTTP requests against the regenerated implementation. Each step pattern is
// a regex with named/positional captures for parameters (resource names,
// input fields, expected values).
//
// Per docs/SUCCESS-CRITERIA.md Principle 1 (sparse-grow), iter 12 implements
// only what the bootstrap scenario needs:
//   - "no resources of any kind exist" (Given)
//   - "a <singular> is created with <field> \"<value>\" and <field> \"<value>\"" (When)
//   - "the request succeeds" (Then)
//   - "a <singular> is retrievable with <field> \"<value>\" and <field> \"<value>\"" (Then)
//
// New phrases get added on demand — when an incident, observation, or new
// evaluation introduces them. Vocabulary remains small and enumerable.

interface StepCtx {
  surface: EvalSurface;
  context: EvalContext;
  /** Last response from a When step, used by retrievable assertions. */
  lastResponse?: { status: number; body: unknown };
}

/** Parse "title \"T1\" and priority \"high\"" → { title: 'T1', priority: 'high' } */
function parseFieldPairs(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  const re = /(\w+)\s+"([^"]*)"/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    result[match[1]] = match[2];
  }
  return result;
}

/** Find the mount path for a singular resource name (e.g., "task" → "/tasks"). */
function mountPathForResource(resource: string, ctx: EvalContext): string | null {
  // Try matching "task" against IU named "Tasks" (or with case/plural variants).
  const target = resource.toLowerCase().replace(/s$/, '');
  for (const iu of ctx.ius) {
    const iuKey = iu.name.toLowerCase().replace(/s$/, '');
    if (iuKey === target) {
      const entry = ctx.interfaces.find(e => e.iu_id === iu.iu_id);
      return entry?.mount_path ?? null;
    }
  }
  return null;
}

async function httpFetch(
  port: number,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.headers = { 'Content-Type': 'application/json' };
    init.body = JSON.stringify(body);
  }
  const res = await fetch(`http://localhost:${port}${path}`, init);
  let parsed: unknown = null;
  const ct = res.headers.get('content-type') ?? '';
  if (ct.includes('application/json')) {
    try { parsed = await res.json(); } catch { parsed = null; }
  } else if (res.status !== 204) {
    try { parsed = await res.text(); } catch { parsed = null; }
  }
  return { status: res.status, body: parsed };
}

/** "no resources of any kind exist" — always true on a fresh DB. */
async function stepGivenNoResources(_ctx: StepCtx, _text: string): Promise<void> {
  // Deletion-test runner provisions fresh DB per evaluation; nothing to do.
}

/**
 * "a <resource> is created with <field> \"<value>\" and <field> \"<value>\""
 * → POST /<resource> with a JSON body of the captured fields.
 */
async function stepWhenResourceCreated(ctx: StepCtx, text: string): Promise<void> {
  const m = text.match(/^a\s+(\w+)\s+is created with\s+(.+)$/);
  if (!m) throw new Error(`step did not match create-pattern: "${text}"`);
  const resource = m[1];
  const fields = parseFieldPairs(m[2]);
  const mountPath = mountPathForResource(resource, ctx.context);
  if (!mountPath) throw new Error(`no mount path for resource "${resource}"`);
  ctx.lastResponse = await httpFetch(ctx.surface.port, 'POST', mountPath, fields);
}

/** "the request succeeds" → last response status is 2xx. */
async function stepThenRequestSucceeds(ctx: StepCtx, _text: string): Promise<void> {
  if (!ctx.lastResponse) throw new Error('no prior request to evaluate');
  if (ctx.lastResponse.status >= 200 && ctx.lastResponse.status < 300) return;
  throw new Error(`expected 2xx, got ${ctx.lastResponse.status}: ${JSON.stringify(ctx.lastResponse.body)}`);
}

/**
 * "a <resource> is retrievable with <field> \"<value>\" and <field> \"<value>\""
 * → GET /<resource> and find an entry where every captured field matches.
 */
async function stepThenResourceRetrievable(ctx: StepCtx, text: string): Promise<void> {
  const m = text.match(/^a\s+(\w+)\s+is retrievable with\s+(.+)$/);
  if (!m) throw new Error(`step did not match retrievable-pattern: "${text}"`);
  const resource = m[1];
  const expected = parseFieldPairs(m[2]);
  const mountPath = mountPathForResource(resource, ctx.context);
  if (!mountPath) throw new Error(`no mount path for resource "${resource}"`);
  const res = await httpFetch(ctx.surface.port, 'GET', mountPath);
  if (!Array.isArray(res.body)) {
    throw new Error(`GET ${mountPath} did not return array: ${JSON.stringify(res.body)}`);
  }
  const items = res.body as Array<Record<string, unknown>>;
  const found = items.some(item =>
    Object.entries(expected).every(([k, v]) => String(item[k] ?? '') === v),
  );
  if (!found) {
    throw new Error(
      `no ${resource} matched ${JSON.stringify(expected)} in GET ${mountPath} response of ${items.length} items`,
    );
  }
}

interface StepDef {
  kind: 'given' | 'when' | 'then';
  pattern: RegExp;
  exec: (ctx: StepCtx, text: string) => Promise<void>;
}

const STEP_DEFS: StepDef[] = [
  { kind: 'given', pattern: /^no resources of any kind exist$/, exec: stepGivenNoResources },
  { kind: 'when',  pattern: /^a\s+\w+\s+is created with\s+.+$/, exec: stepWhenResourceCreated },
  { kind: 'then',  pattern: /^the request succeeds$/, exec: stepThenRequestSucceeds },
  { kind: 'then',  pattern: /^a\s+\w+\s+is retrievable with\s+.+$/, exec: stepThenResourceRetrievable },
];

async function runStep(
  kind: 'given' | 'when' | 'then',
  text: string,
  ctx: StepCtx,
): Promise<void> {
  for (const def of STEP_DEFS) {
    if (def.kind === kind && def.pattern.test(text)) {
      await def.exec(ctx, text);
      return;
    }
  }
  throw new Error(`no ${kind} step definition matches: "${text}"`);
}

async function webApiRunEvaluation(
  evaluation: Evaluation,
  surface: EvalSurface,
  context: EvalContext,
): Promise<EvalResult> {
  const ctx: StepCtx = { surface, context };
  try {
    for (const s of evaluation.given) await runStep('given', s.text, ctx);
    for (const s of evaluation.when)  await runStep('when',  s.text, ctx);
    for (const s of evaluation.then)  await runStep('then',  s.text, ctx);
    return { eval_id: evaluation.eval_id, name: evaluation.name, pass: true };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { eval_id: evaluation.eval_id, name: evaluation.name, pass: false, reason };
  }
}

// ─── Architecture export ────────────────────────────────────────────────────

export const webApi: Architecture = {
  name: 'web-api',
  description: 'API-driven web application — REST endpoints, resource-oriented, independently testable',

  communicationPattern: 'rest',
  dataOwnership: 'per-component',
  evaluationSurface: 'http-endpoints',

  systemPrompt: `## Architecture: API-driven Web Application

This system is an API-driven web application with the following architectural constraints:

### Communication
- Components communicate via REST HTTP endpoints
- Each resource has its own set of endpoints (CRUD)
- Standard HTTP status codes: 200 (ok), 201 (created), 204 (no content), 400 (bad request), 404 (not found)
- All responses are JSON. Errors: { "error": "message" }

### Data Ownership
- Each resource module owns exclusive mutation authority over its database table(s)
- Cross-resource queries use JOINs for read-only access
- Foreign key relationships must be validated before mutation (check referenced row exists)
- Cascade protection: cannot delete a parent resource that has dependent children

### Component Grain
- One module per resource (e.g., tasks, projects, categories)
- Each module is independently deployable and testable
- A web UI module serves HTML and calls the resource modules via fetch()

### Evaluation Surface
- Every module is testable via HTTP endpoint contracts
- Create → verify response has ID and matches input
- Read → verify response shape matches schema
- Update → verify changes are persisted
- Delete → verify resource is gone
- Validation → verify 400 for invalid input
- Not found → verify 404 for missing resources

### Translating user requirements to implementation
- "Users can create X" → POST endpoint with validation
- "Users can view X" → GET endpoint with SELECT query (JOINs for related data)
- "Users can edit X" → PATCH endpoint with UPDATE query
- "Users can delete X" → DELETE endpoint with safety checks
- "Users can filter by Y" → query parameters on GET endpoints
- "Show X sorted by Y" → ORDER BY in query
- "X must be visually highlighted" → UI concern, not API
- "Expose a programmatic interface" → the REST API IS the programmatic interface
`,

  runtimeTargets: ['node-typescript', 'node-typescript-stdlib', 'node-typescript-express'],

  runEvaluation: webApiRunEvaluation,
};
