/**
 * E2E: Functional Equivalence — Cross-Target HTTP Behavior (three-way)
 *
 * Boots three runtime targets (web-api/node-typescript,
 * web-api/node-typescript-stdlib, web-api/node-typescript-express) as actual
 * HTTP servers, replays an identical request script against each, and
 * asserts canonicalized JSON responses are byte-identical across all three.
 *
 * This is the headline three-way proof of Phoenix's core thesis:
 *
 *   Same durable specifications →
 *   Three different ephemeral implementations →
 *   Identical observable behavior on the HTTP contract.
 *
 * Design notes
 * ────────────
 *   1. Uses fixed module fixtures from examples/todo-app (Hono) and
 *      examples/todo-app-express (Express). Pinning module bodies isolates
 *      the test to runtime-target equivalence and avoids LLM nondeterminism.
 *
 *   2. Per-target server.ts is generated via generateScaffold(), which
 *      delegates to target.runtime.generateServerEntry — the iter-5 hook.
 *      That lets each target produce its framework-correct entry point
 *      (Hono's serve() vs Express's app.listen()) without hand-coded test
 *      scaffolding.
 *
 *   3. Skips cleanly without pnpm/npm or on Node < 22 (the stdlib target
 *      needs node:sqlite). Set PHOENIX_SKIP_FUNCTIONAL_E2E=1 to force-skip
 *      in CI matrices that can't afford the install/boot cost.
 *
 *   4. Auto-increment IDs are deterministic across all three targets when
 *      request order is identical and DB is fresh; only ISO-8601 timestamps
 *      need canonicalization.
 *
 *   5. Each target's generateServerEntry registers a JSON 404 fallback
 *      (`{error: 'Not Found'}`) after mounts, overriding the framework
 *      default error page. That makes the 404 step a real equivalence
 *      assertion rather than a status-only check.
 */

import { describe, it, expect } from 'vitest';
import {
  mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, cpSync, existsSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, spawnSync, execSync, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';

import { resolveTarget } from '../../src/architectures/index.js';
import { generateScaffold } from '../../src/scaffold.js';
import type { ResolvedTarget } from '../../src/models/architecture.js';
import type { ImplementationUnit } from '../../src/models/iu.js';

// ─── Environment detection ──────────────────────────────────────────────────

type PackageManager = 'pnpm' | 'npm';

function detectPackageManager(): PackageManager | null {
  for (const pm of ['pnpm', 'npm'] as const) {
    const result = spawnSync(pm, ['--version'], { stdio: 'ignore' });
    if (result.status === 0) return pm;
  }
  return null;
}

const pm = detectPackageManager();
const nodeMajor = parseInt(process.versions.node.split('.')[0], 10);
const skipReason = !pm
  ? 'no pnpm/npm on PATH'
  : nodeMajor < 22
  ? `Node ${process.versions.node} < 22 (node:sqlite required)`
  : process.env.PHOENIX_SKIP_FUNCTIONAL_E2E === '1'
  ? 'PHOENIX_SKIP_FUNCTIONAL_E2E=1'
  : null;

if (skipReason) {
  console.log(`[cross-target-functional] skipping: ${skipReason}`);
}

// ─── Targets under test ─────────────────────────────────────────────────────

const repoRoot = join(import.meta.dirname, '..', '..');

interface TargetSpec {
  targetName: string;
  fixtureDir: string;
}

const TARGETS_AND_FIXTURES: TargetSpec[] = [
  { targetName: 'web-api/node-typescript',         fixtureDir: 'examples/todo-app' },
  { targetName: 'web-api/node-typescript-stdlib',  fixtureDir: 'examples/todo-app' },
  { targetName: 'web-api/node-typescript-express', fixtureDir: 'examples/todo-app-express' },
];

/** Synthetic IUs used to drive scaffold's mount-path lookup. */
function makeSyntheticIUs(): ImplementationUnit[] {
  return [
    { iu_id: 'iu-projects', name: 'Projects', kind: 'module', risk_tier: 'high',
      contract: { description: '', inputs: [], outputs: [], invariants: [] },
      source_canon_ids: [], dependencies: [],
      boundary_policy: {
        code: { allowed_ius: [], allowed_packages: [], forbidden_ius: [], forbidden_packages: [], forbidden_paths: [] },
        side_channels: { databases: [], queues: [], caches: [], config: [], external_apis: [], files: [] },
      },
      enforcement: { dependency_violation: { severity: 'error' }, side_channel_violation: { severity: 'warning' } },
      evidence_policy: { required: [] },
      output_files: ['src/generated/todos/projects.ts'],
    },
    { iu_id: 'iu-tasks', name: 'Tasks', kind: 'module', risk_tier: 'high',
      contract: { description: '', inputs: [], outputs: [], invariants: [] },
      source_canon_ids: [], dependencies: [],
      boundary_policy: {
        code: { allowed_ius: [], allowed_packages: [], forbidden_ius: [], forbidden_packages: [], forbidden_paths: [] },
        side_channels: { databases: [], queues: [], caches: [], config: [], external_apis: [], files: [] },
      },
      enforcement: { dependency_violation: { severity: 'error' }, side_channel_violation: { severity: 'warning' } },
      evidence_policy: { required: [] },
      output_files: ['src/generated/todos/tasks.ts'],
    },
    { iu_id: 'iu-web-experience', name: 'Web Experience', kind: 'module', risk_tier: 'high',
      contract: { description: '', inputs: [], outputs: [], invariants: [] },
      source_canon_ids: [], dependencies: [],
      boundary_policy: {
        code: { allowed_ius: [], allowed_packages: [], forbidden_ius: [], forbidden_packages: [], forbidden_paths: [] },
        side_channels: { databases: [], queues: [], caches: [], config: [], external_apis: [], files: [] },
      },
      enforcement: { dependency_violation: { severity: 'error' }, side_channel_violation: { severity: 'warning' } },
      evidence_policy: { required: [] },
      output_files: ['src/generated/todos/web-experience.ts'],
    },
  ];
}

// ─── Project setup ──────────────────────────────────────────────────────────

function setupTargetProject(target: ResolvedTarget, fixtureDir: string, tmpDir: string, packageManager: PackageManager): void {
  const writeFile = (relPath: string, content: string): void => {
    const fullPath = join(tmpDir, relPath);
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, content, 'utf8');
  };

  // 1. Module fixtures: framework-flavored. Hono fixtures for Hono targets,
  //    Express fixtures for the Express target. The runtime target's hooks
  //    handle everything else (db.ts, app.ts, server.ts, package.json).
  cpSync(join(fixtureDir, 'src', 'generated'), join(tmpDir, 'src', 'generated'), { recursive: true });

  // 2. Use scaffold to produce server.ts (via target.runtime.generateServerEntry),
  //    sharedFiles (db.ts, app.ts), package.json, tsconfig.json. This exercises
  //    the iter-5 hook and is uniform across all targets — no per-target
  //    branching in the test.
  const ius = makeSyntheticIUs();
  const services = [{
    name: 'Todos',
    dir: 'todos',
    modules: ['projects.ts', 'tasks.ts', 'web-experience.ts'],
    ius,
    port: 3000,
  }];
  const interfaces = [
    { iu_id: 'iu-projects',       name: 'Projects',       mount_path: '/projects', role: 'api' as const,    resource_fields: '' },
    { iu_id: 'iu-tasks',          name: 'Tasks',          mount_path: '/tasks',    role: 'api' as const,    resource_fields: '' },
    { iu_id: 'iu-web-experience', name: 'Web Experience', mount_path: '',          role: 'web-ui' as const, resource_fields: '' },
  ];
  const scaffold = generateScaffold(services, 'cross-target-test', target, interfaces);
  for (const [path, content] of scaffold.files) {
    writeFile(path, content);
  }

  // 3. pnpm v10+ blocks postinstall scripts by default; inject the allow-list.
  if (packageManager === 'pnpm') {
    const pkgPath = join(tmpDir, 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    pkg.pnpm = { onlyBuiltDependencies: ['better-sqlite3', 'esbuild'] };
    writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
  }

  execSync(`${packageManager} install --silent`, {
    cwd: tmpDir,
    stdio: 'pipe',
    timeout: 180_000,
  });
}

// ─── Server lifecycle ───────────────────────────────────────────────────────

interface ServerHandle {
  proc: ChildProcess;
  kill: () => Promise<void>;
}

async function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, () => {
      const addr = srv.address();
      if (!addr || typeof addr !== 'object') {
        srv.close();
        reject(new Error('no address'));
        return;
      }
      const port = addr.port;
      srv.close(() => resolve(port));
    });
  });
}

async function bootServer(tmpDir: string, port: number, packageManager: PackageManager): Promise<ServerHandle> {
  const proc = spawn(packageManager, ['exec', 'tsx', 'src/server.ts'], {
    cwd: tmpDir,
    env: {
      ...process.env,
      PORT: String(port),
      DB_PATH: join(tmpDir, 'data', 'app.db'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const stderrChunks: Buffer[] = [];
  proc.stderr?.on('data', (b: Buffer) => stderrChunks.push(b));
  const exited = new Promise<number | null>(resolve => proc.once('exit', code => resolve(code)));

  const kill = async (): Promise<void> => {
    if (proc.exitCode !== null) return;
    proc.kill('SIGTERM');
    const timer = setTimeout(() => proc.kill('SIGKILL'), 10_000);
    await exited;
    clearTimeout(timer);
  };

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) {
      const stderr = Buffer.concat(stderrChunks).toString('utf8');
      throw new Error(`server exited early (code ${proc.exitCode}). stderr:\n${stderr}`);
    }
    try {
      const r = await fetch(`http://localhost:${port}/health`);
      if (r.ok) return { proc, kill };
    } catch { /* not ready yet */ }
    await new Promise(r => setTimeout(r, 250));
  }

  await kill();
  const stderr = Buffer.concat(stderrChunks).toString('utf8');
  throw new Error(`server did not respond on /health within 30s (port ${port}). stderr:\n${stderr}`);
}

// ─── Request script ─────────────────────────────────────────────────────────

interface CapturedResponse {
  name: string;
  status: number;
  body: unknown;
}

async function call(
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
    parsed = await res.text();
  }
  return { status: res.status, body: parsed };
}

async function runRequestScript(port: number): Promise<CapturedResponse[]> {
  const out: CapturedResponse[] = [];
  const step = async (name: string, fn: () => Promise<{ status: number; body: unknown }>) => {
    const { status, body } = await fn();
    out.push({ name, status, body });
  };

  await step('GET /tasks (empty)', () => call(port, 'GET', '/tasks'));
  await step('POST /tasks (empty title → 400)', () => call(port, 'POST', '/tasks', { title: '' }));
  await step('POST /projects', () => call(port, 'POST', '/projects', { name: 'P1', color: '#ff0000' }));
  await step('POST /tasks (with project_id)', () =>
    call(port, 'POST', '/tasks', { title: 'T1', priority: 'high', project_id: 1 }),
  );
  await step('GET /tasks (after create)', () => call(port, 'GET', '/tasks'));
  await step('PATCH /tasks/1 (mark complete)', () =>
    call(port, 'PATCH', '/tasks/1', { completed: true }),
  );
  await step('DELETE /projects/1 (has tasks → 400)', () => call(port, 'DELETE', '/projects/1'));
  await step('DELETE /tasks/1', () => call(port, 'DELETE', '/tasks/1'));
  await step('DELETE /projects/1 (now empty)', () => call(port, 'DELETE', '/projects/1'));
  await step('GET / (web UI)', () => call(port, 'GET', '/'));
  await step('GET /unknown (→ 404)', () => call(port, 'GET', '/unknown'));

  return out;
}

// ─── Canonicalization ───────────────────────────────────────────────────────

const TIMESTAMP_FIELDS = new Set(['created_at', 'updated_at']);

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = TIMESTAMP_FIELDS.has(k) ? '<TIMESTAMP>' : canonicalize(v);
    }
    return out;
  }
  return value;
}

/**
 * Normalize HTML response bodies by stripping per-line trailing whitespace.
 * The Hono and Express fixtures differ in trailing whitespace on blank
 * indented lines — an artifact of how the HTML body was authored, not a
 * semantic difference. Browsers render the two identically; the test must
 * not flag this.
 */
function normalizeHtml(body: unknown): unknown {
  if (typeof body !== 'string') return body;
  if (!body.includes('<!DOCTYPE')) return body;
  return body.split('\n').map(line => line.replace(/\s+$/, '')).join('\n');
}

function canonicalizeResponse(r: CapturedResponse): CapturedResponse {
  return { name: r.name, status: r.status, body: normalizeHtml(canonicalize(r.body)) };
}

// ─── Test ───────────────────────────────────────────────────────────────────

describe('E2E: Functional equivalence — cross-target HTTP behavior', () => {
  it.skipIf(skipReason !== null)(
    'three runtime targets produce identical HTTP behavior on todo-app modules',
    { timeout: 360_000 },
    async () => {
      const targets = TARGETS_AND_FIXTURES.map(tf => {
        const t = resolveTarget(tf.targetName);
        expect(t, `${tf.targetName} must be registered`).toBeTruthy();
        const fixtureDir = join(repoRoot, tf.fixtureDir);
        expect(existsSync(join(fixtureDir, 'src', 'generated'))).toBe(true);
        return { ...tf, target: t!, fixtureDir };
      });

      const dirs: string[] = [];
      const servers: (ServerHandle | undefined)[] = new Array(targets.length).fill(undefined);
      const responseSets: CapturedResponse[][] = [];

      try {
        // Set up + boot each target sequentially. (Parallelizing would
        // contend on the pnpm store; sequential is simpler and ~3× the
        // wall time of the original two-way test, ~15-30s warm.)
        for (let i = 0; i < targets.length; i++) {
          const { target, fixtureDir } = targets[i];
          const dir = mkdtempSync(join(tmpdir(), `phoenix-ct${i}-`));
          dirs.push(dir);
          setupTargetProject(target, fixtureDir, dir, pm!);
          const port = await pickFreePort();
          servers[i] = await bootServer(dir, port, pm!);
          responseSets.push(await runRequestScript(port));
        }

        // All scripts must have run to completion with the same step count.
        const expectedSteps = 11;
        for (let i = 0; i < responseSets.length; i++) {
          expect(responseSets[i].length, `target[${i}] (${targets[i].targetName}) script length`).toBe(expectedSteps);
        }

        const canonized = responseSets.map(rs => rs.map(canonicalizeResponse));

        // The headline three-way assertion: every target's response sequence
        // equals target[0]'s after canonicalization. Diff includes a target
        // label so failures point straight at the divergent runtime.
        for (let i = 1; i < canonized.length; i++) {
          expect(canonized[i], `target[${i}] (${targets[i].targetName}) diverged from target[0] (${targets[0].targetName})`).toEqual(canonized[0]);
        }
      } finally {
        for (const s of servers) await s?.kill();
        for (const d of dirs) rmSync(d, { recursive: true, force: true });
      }
    },
  );
});
