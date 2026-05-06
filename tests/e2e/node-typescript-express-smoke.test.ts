/**
 * E2E: Smoke test — node-typescript-express
 *
 * Boots a stub Express server scaffolded by the runtime target and verifies
 * three things:
 *   1. The scaffold produces a buildable Express project
 *   2. The server starts on Node ≥22 with `pnpm tsx`
 *   3. Stub routes serve the expected JSON shape
 *
 * This is the behavioral counterpart to iteration 7's typecheck-only proof:
 * the abstraction held mechanically (zero edits to regen.ts/scaffold.ts/
 * prompt.ts), and now the runtime actually runs.
 *
 * Hono ↔ Express HTTP-replay equivalence (the three-way functional proof) is
 * iteration 8. This test only proves Express works in isolation.
 */

import { describe, it, expect } from 'vitest';
import {
  mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, spawnSync, execSync, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';

import { resolveTarget } from '../../src/architectures/index.js';
import { generateScaffold } from '../../src/scaffold.js';
import type { ImplementationUnit } from '../../src/models/iu.js';
import type { ResolvedTarget } from '../../src/models/architecture.js';

// ─── Environment detection (matches cross-target-functional.test.ts) ────────

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
  ? `Node ${process.versions.node} < 22`
  : process.env.PHOENIX_SKIP_FUNCTIONAL_E2E === '1'
  ? 'PHOENIX_SKIP_FUNCTIONAL_E2E=1'
  : null;

if (skipReason) {
  console.log(`[express-smoke] skipping: ${skipReason}`);
}

// ─── Synthetic IUs (no spec/canonicalization needed) ────────────────────────

const SYNTHETIC_IUS: ImplementationUnit[] = [
  {
    iu_id: 'iu-greetings',
    kind: 'module',
    name: 'Greetings',
    risk_tier: 'low',
    contract: { description: 'stub greetings module', inputs: [], outputs: [], invariants: [] },
    source_canon_ids: ['canon-1'],
    dependencies: [],
    boundary_policy: {
      code: { allowed_ius: [], allowed_packages: [], forbidden_ius: [], forbidden_packages: [], forbidden_paths: [] },
      side_channels: { databases: [], queues: [], caches: [], config: [], external_apis: [], files: [] },
    },
    enforcement: {
      dependency_violation: { severity: 'error' },
      side_channel_violation: { severity: 'warning' },
    },
    evidence_policy: { required: [] },
    output_files: ['src/generated/api/greetings.ts'],
  },
  {
    iu_id: 'iu-counters',
    kind: 'module',
    name: 'Counters',
    risk_tier: 'low',
    contract: { description: 'stub counters module', inputs: [], outputs: [], invariants: [] },
    source_canon_ids: ['canon-2'],
    dependencies: [],
    boundary_policy: {
      code: { allowed_ius: [], allowed_packages: [], forbidden_ius: [], forbidden_packages: [], forbidden_paths: [] },
      side_channels: { databases: [], queues: [], caches: [], config: [], external_apis: [], files: [] },
    },
    enforcement: {
      dependency_violation: { severity: 'error' },
      side_channel_violation: { severity: 'warning' },
    },
    evidence_policy: { required: [] },
    output_files: ['src/generated/api/counters.ts'],
  },
];

// ─── Project setup ──────────────────────────────────────────────────────────

function setupExpressProject(target: ResolvedTarget, tmpDir: string, packageManager: PackageManager): void {
  const writeFile = (relPath: string, content: string): void => {
    const fullPath = join(tmpDir, relPath);
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, content, 'utf8');
  };

  // 1. Stub modules from the runtime target itself — this is what we're testing.
  for (const iu of SYNTHETIC_IUS) {
    writeFile(iu.output_files[0], target.runtime.generateModuleStub(iu));
  }

  // 2. Use scaffold to produce server.ts, package.json, tsconfig, etc.
  //    Scaffold also writes the runtime's sharedFiles (db.ts, app.ts).
  const services = [{
    name: 'Api',
    dir: 'api',
    modules: ['greetings.ts', 'counters.ts'],
    ius: SYNTHETIC_IUS,
    port: 3000,
  }];
  const interfaces = [
    { iu_id: 'iu-greetings', name: 'Greetings', mount_path: '/greetings', role: 'api' as const, resource_fields: '' },
    { iu_id: 'iu-counters',  name: 'Counters',  mount_path: '/counters',  role: 'api' as const, resource_fields: '' },
  ];
  const scaffold = generateScaffold(services, 'express-smoke-test', target, interfaces);
  for (const [path, content] of scaffold.files) {
    writeFile(path, content);
  }

  // 3. pnpm v10 blocks postinstall scripts by default; better-sqlite3 needs
  //    its native binding built and esbuild (transitive of tsx) needs to build.
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

// ─── Server lifecycle (mirror of cross-target-functional helpers) ───────────

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

// ─── Test ───────────────────────────────────────────────────────────────────

describe('E2E: node-typescript-express smoke test', () => {
  it.skipIf(skipReason !== null)(
    'scaffolds, builds, boots, and serves stubs',
    { timeout: 240_000 },
    async () => {
      const target = resolveTarget('web-api/node-typescript-express');
      expect(target, 'web-api/node-typescript-express must be registered').toBeTruthy();
      expect(target!.runtime.name).toBe('node-typescript-express');

      const dir = mkdtempSync(join(tmpdir(), 'phoenix-express-smoke-'));
      let server: ServerHandle | undefined;

      try {
        setupExpressProject(target!, dir, pm!);
        const port = await pickFreePort();
        server = await bootServer(dir, port, pm!);

        // 1. /health responds 200 with status: 'ok'
        const health = await fetch(`http://localhost:${port}/health`);
        expect(health.status).toBe(200);
        const healthBody = await health.json() as Record<string, unknown>;
        expect(healthBody.status).toBe('ok');

        // 2. Stub route serves the expected stub response
        const greetings = await fetch(`http://localhost:${port}/greetings`);
        expect(greetings.status).toBe(200);
        const greetingsBody = await greetings.json() as Record<string, unknown>;
        expect(greetingsBody).toEqual({
          stub: true,
          module: 'Greetings',
          message: 'Not yet implemented',
        });

        const counters = await fetch(`http://localhost:${port}/counters`);
        expect(counters.status).toBe(200);
        const countersBody = await counters.json() as Record<string, unknown>;
        expect(countersBody.module).toBe('Counters');

        // 3. Unknown route → 404
        const unknown = await fetch(`http://localhost:${port}/nope`);
        expect(unknown.status).toBe(404);
      } finally {
        await server?.kill();
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});
