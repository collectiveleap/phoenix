/**
 * E2E: Functional Equivalence — Cross-Target HTTP Behavior
 *
 * Boots both runtime targets (web-api/node-typescript and
 * web-api/node-typescript-stdlib) as actual HTTP servers, replays an identical
 * request script against each, and asserts canonicalized JSON responses are
 * equal. This is the behavioral counterpart to the structural diff in
 * cross-target.test.ts.
 *
 * Design notes
 * ────────────
 *   1. Uses fixed module fixtures from examples/todo-app/src/generated rather
 *      than live LLM regen. The two existing targets share architecture and
 *      module structure; the runtime delta is confined to sharedFiles
 *      (specifically src/db.ts). Pinning module bodies isolates the test to
 *      runtime-target equivalence and avoids LLM nondeterminism.
 *
 *   2. Skips cleanly in environments without pnpm/npm or on Node < 22 (the
 *      stdlib variant requires node:sqlite). Set PHOENIX_SKIP_FUNCTIONAL_E2E=1
 *      to force-skip in CI matrices that can't afford the install/boot cost.
 *
 *   3. Auto-increment IDs are deterministic across both targets when request
 *      order is identical and DB is fresh; only ISO-8601 timestamps need
 *      canonicalization.
 */

import { describe, it, expect } from 'vitest';
import {
  mkdtempSync, rmSync, writeFileSync, cpSync, existsSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, spawnSync, execSync, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';

import { resolveTarget } from '../../src/architectures/index.js';
import type { ResolvedTarget } from '../../src/models/architecture.js';

// ─── Environment detection ──────────────────────────────────────────────────

type PackageManager = 'pnpm' | 'npm';

function detectPackageManager(): PackageManager | null {
  // Prefer pnpm (it's what this repo's contributor uses); fall back to npm.
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

// ─── Project setup ──────────────────────────────────────────────────────────

const repoRoot = join(import.meta.dirname, '..', '..');
const fixtureDir = join(repoRoot, 'examples', 'todo-app');

function setupTargetProject(target: ResolvedTarget, tmpDir: string, packageManager: PackageManager): void {
  // Module fixtures are runtime-agnostic: they import { db, registerMigration }
  // from '../../db.js' which both targets export with the same shape.
  cpSync(join(fixtureDir, 'src', 'generated'), join(tmpDir, 'src', 'generated'), { recursive: true });
  cpSync(join(fixtureDir, 'src', 'server.ts'), join(tmpDir, 'src', 'server.ts'));
  cpSync(join(fixtureDir, 'tsconfig.json'), join(tmpDir, 'tsconfig.json'));

  // Runtime-owned shared files (src/db.ts, src/app.ts) — this is where the
  // ephemeral delta lives.
  for (const [path, content] of Object.entries(target.runtime.sharedFiles)) {
    writeFileSync(join(tmpDir, path), content, 'utf8');
  }

  const pkg: Record<string, unknown> = {
    name: 'cross-target-test',
    version: '0.0.0',
    private: true,
    type: 'module',
    dependencies: target.runtime.packages,
    devDependencies: target.runtime.devPackages,
    ...(target.runtime.packageExtras ?? {}),
  };
  // pnpm v10+ blocks postinstall scripts by default; both targets need esbuild
  // (transitive dep of tsx) to build, and target A needs better-sqlite3 native.
  if (packageManager === 'pnpm') {
    pkg.pnpm = { onlyBuiltDependencies: ['better-sqlite3', 'esbuild'] };
  }
  writeFileSync(join(tmpDir, 'package.json'), JSON.stringify(pkg, null, 2), 'utf8');

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

async function bootServer(
  tmpDir: string,
  port: number,
  packageManager: PackageManager,
): Promise<ServerHandle> {
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

  const exited = new Promise<number | null>(resolve => {
    proc.once('exit', code => resolve(code));
  });

  const kill = async (): Promise<void> => {
    if (proc.exitCode !== null) return;
    proc.kill('SIGTERM');
    const timer = setTimeout(() => proc.kill('SIGKILL'), 10_000);
    await exited;
    clearTimeout(timer);
  };

  // Poll /health
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

function canonicalizeResponse(r: CapturedResponse): CapturedResponse {
  return { name: r.name, status: r.status, body: canonicalize(r.body) };
}

// ─── Test ───────────────────────────────────────────────────────────────────

describe('E2E: Functional equivalence — cross-target HTTP behavior', () => {
  it.skipIf(skipReason !== null)(
    'two runtime targets produce identical HTTP behavior on todo-app modules',
    { timeout: 240_000 },
    async () => {
      const targetA = resolveTarget('web-api/node-typescript');
      const targetB = resolveTarget('web-api/node-typescript-stdlib');
      expect(targetA).toBeTruthy();
      expect(targetB).toBeTruthy();

      // Sanity: fixture directory exists.
      expect(existsSync(join(fixtureDir, 'src', 'generated'))).toBe(true);

      const dirA = mkdtempSync(join(tmpdir(), 'phoenix-cta-'));
      const dirB = mkdtempSync(join(tmpdir(), 'phoenix-ctb-'));

      let serverA: ServerHandle | undefined;
      let serverB: ServerHandle | undefined;

      try {
        setupTargetProject(targetA!, dirA, pm!);
        setupTargetProject(targetB!, dirB, pm!);

        const portA = await pickFreePort();
        const portB = await pickFreePort();

        serverA = await bootServer(dirA, portA, pm!);
        serverB = await bootServer(dirB, portB, pm!);

        const responsesA = await runRequestScript(portA);
        const responsesB = await runRequestScript(portB);

        const canonA = responsesA.map(canonicalizeResponse);
        const canonB = responsesB.map(canonicalizeResponse);

        // Pin script length so a regression in the script is loud.
        expect(canonA.length).toBe(10);
        expect(canonB.length).toBe(10);

        // The headline assertion.
        expect(canonB).toEqual(canonA);
      } finally {
        await serverA?.kill();
        await serverB?.kill();
        rmSync(dirA, { recursive: true, force: true });
        rmSync(dirB, { recursive: true, force: true });
      }
    },
  );
});
