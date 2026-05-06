/**
 * E2E: The Deletion Test
 *
 * Phoenix's headline correctness oracle (per docs/SUCCESS-CRITERIA.md).
 *
 * For each registered (architecture, runtime) combination:
 *   1. Start from a temp dir containing ONLY durable artifacts (spec/ + evals/).
 *      Everything ephemeral (.phoenix/, src/, package.json, node_modules/, …)
 *      is absent — must be regenerated.
 *   2. Run the full LLM-driven flow: phoenix init / bootstrap / regen.
 *   3. Install + boot the regenerated implementation on a free port.
 *   4. Run every evaluation through the architecture's runEvaluation adapter.
 *   5. Assert all results.pass.
 *
 * Skip conditions (test logs the reason):
 *   - PHOENIX_RUN_LLM_E2E !== '1'
 *   - resolveProvider() returns null (no LLM credentials in env)
 *   - no pnpm/npm on PATH
 *   - Node major < 22 (node:sqlite needed by stdlib variant)
 *
 * This is the iter 12 deliverable. With one bootstrap evaluation in
 * evals/todo-app.feature, the test exercises the closed loop end-to-end.
 * Coverage grows in iter 13+ (incremental, on-demand evals).
 */

import { describe, it, expect, beforeAll } from 'vitest';
import {
  mkdtempSync, mkdirSync, rmSync, cpSync, writeFileSync, readFileSync,
  existsSync, statSync, readdirSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';

import { resolveTarget, listArchitectures } from '../../src/architectures/index.js';
import { resolveProvider } from '../../src/llm/resolve.js';
import { loadEvaluationsFromDir } from '../../src/eval-parser.js';
import type { ResolvedTarget, EvalContext } from '../../src/models/architecture.js';
import type { ImplementationUnit } from '../../src/models/iu.js';

// ─── Environment detection ──────────────────────────────────────────────────

const repoRoot = join(import.meta.dirname, '..', '..');
const cli = join(repoRoot, 'dist', 'cli.js');

type PackageManager = 'pnpm' | 'npm';
function detectPackageManager(): PackageManager | null {
  for (const pm of ['pnpm', 'npm'] as const) {
    const r = spawnSync(pm, ['--version'], { stdio: 'ignore' });
    if (r.status === 0) return pm;
  }
  return null;
}

const pm = detectPackageManager();
const nodeMajor = parseInt(process.versions.node.split('.')[0], 10);
const llmAvailable = (() => {
  try { return resolveProvider(repoRoot) !== null; } catch { return false; }
})();

const skipReason = process.env.PHOENIX_RUN_LLM_E2E !== '1'
  ? 'PHOENIX_RUN_LLM_E2E !== "1" (deletion test is opt-in; gated for cost/time)'
  : !pm
  ? 'no pnpm/npm on PATH'
  : nodeMajor < 22
  ? `Node ${process.versions.node} < 22 (node:sqlite required by stdlib variant)`
  : !llmAvailable
  ? 'no LLM provider resolved (need ANTHROPIC_API_KEY, OPENAI_API_KEY, or claude-cli)'
  : null;

if (skipReason) {
  console.log(`[deletion-test] skipping: ${skipReason}`);
}

// ─── Dist freshness ─────────────────────────────────────────────────────────

function newestMtimeUnder(dir: string): number {
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) newest = Math.max(newest, newestMtimeUnder(full));
    else if (entry.isFile() && entry.name.endsWith('.ts')) newest = Math.max(newest, statSync(full).mtimeMs);
  }
  return newest;
}
function ensureDistFresh(): void {
  const distExists = existsSync(cli);
  const distMtime = distExists ? statSync(cli).mtimeMs : 0;
  const newest = newestMtimeUnder(join(repoRoot, 'src'));
  if (!distExists || newest > distMtime) {
    execSync('./node_modules/.bin/tsc', { cwd: repoRoot, stdio: 'inherit' });
  }
}

// ─── Server lifecycle helpers (mirrored from cross-target-functional) ────────

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
      if (!addr || typeof addr !== 'object') { srv.close(); reject(new Error('no address')); return; }
      const port = addr.port;
      srv.close(() => resolve(port));
    });
  });
}

async function bootServer(tmpDir: string, port: number, packageManager: PackageManager): Promise<ServerHandle> {
  const proc = spawn(packageManager, ['exec', 'tsx', 'src/server.ts'], {
    cwd: tmpDir,
    env: { ...process.env, PORT: String(port), DB_PATH: join(tmpDir, 'data', 'app.db') },
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
    } catch { /* not ready */ }
    await new Promise(r => setTimeout(r, 250));
  }
  await kill();
  const stderr = Buffer.concat(stderrChunks).toString('utf8');
  throw new Error(`server did not respond on /health within 30s (port ${port}). stderr:\n${stderr}`);
}

// ─── Per-target deletion-test routine ───────────────────────────────────────

async function runDeletionTestForTarget(targetName: string, packageManager: PackageManager): Promise<void> {
  const target = resolveTarget(targetName);
  expect(target, `${targetName} must be registered`).toBeTruthy();
  const resolved: ResolvedTarget = target!;

  // Fresh dir; copy ONLY durable artifacts.
  const dir = mkdtempSync(join(tmpdir(), `phoenix-deletion-${resolved.runtime.name}-`));
  let server: ServerHandle | undefined;
  try {
    cpSync(join(repoRoot, 'examples', 'todo-app', 'spec'), join(dir, 'spec'), { recursive: true });
    cpSync(join(repoRoot, 'evals'), join(dir, 'evals'), { recursive: true });

    const opts = { cwd: dir, stdio: 'pipe' as const };

    // Full Phoenix flow with real LLM.
    execSync(`node ${JSON.stringify(cli)} init --arch=${targetName}`, opts);
    execSync(`node ${JSON.stringify(cli)} bootstrap`, opts);
    execSync(`node ${JSON.stringify(cli)} regen`, opts);

    // pnpm v10 blocks postinstall by default; allow native binaries.
    if (packageManager === 'pnpm') {
      const pkgPath = join(dir, 'package.json');
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
      pkg.pnpm = { onlyBuiltDependencies: ['better-sqlite3', 'esbuild'] };
      writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
    }
    execSync(`${packageManager} install --silent`, { cwd: dir, stdio: 'pipe', timeout: 180_000 });

    // Boot.
    const port = await pickFreePort();
    server = await bootServer(dir, port, packageManager);

    // Load durable evals + read resolved view from .phoenix/evals/index.json.
    const durable = loadEvaluationsFromDir(join(dir, 'evals'));
    const resolvedPath = join(dir, '.phoenix', 'evals', 'index.json');
    const resolvedEvals = existsSync(resolvedPath)
      ? (JSON.parse(readFileSync(resolvedPath, 'utf8')).evaluations as typeof durable)
      : durable;

    expect(resolvedEvals.length, 'at least one evaluation must exist').toBeGreaterThan(0);

    // Build EvalContext from the IU plan + interface registry on disk.
    const iuPath = join(dir, '.phoenix', 'graphs', 'ius.json');
    expect(existsSync(iuPath), 'IU plan must exist after bootstrap').toBe(true);
    const ius = JSON.parse(readFileSync(iuPath, 'utf8')) as ImplementationUnit[];

    // Reuse Phoenix's deriveInterfaces by reading interfaces from the
    // server.ts (mounted as `<prefix>` per IU). Quick heuristic: derive
    // interfaces via the same logic as scaffold.ts. For iter 12, just read
    // the runtime registry.
    const { deriveInterfaces } = await import('../../src/scaffold.js');
    const interfaces = deriveInterfaces(ius).map(e => ({
      iu_id: e.iu_id, name: e.name, mount_path: e.mount_path, role: e.role,
    }));

    const context: EvalContext = {
      ius: ius.map(iu => ({ iu_id: iu.iu_id, name: iu.name })),
      interfaces,
    };

    // Run each evaluation through the architecture's adapter.
    for (const eval_ of resolvedEvals) {
      const result = await resolved.architecture.runEvaluation(eval_, { port }, context);
      expect(result.pass,
        `${targetName} :: eval "${result.name}" failed: ${result.reason ?? 'unknown'}`,
      ).toBe(true);
    }
  } finally {
    await server?.kill();
    rmSync(dir, { recursive: true, force: true });
  }
}

// ─── Test ───────────────────────────────────────────────────────────────────

describe('E2E: The Deletion Test', () => {
  beforeAll(() => {
    if (skipReason) return;
    ensureDistFresh();
  });

  // Iterate over every registered (architecture, runtime) combination.
  // For iter 12 that's web-api × {node-typescript, node-typescript-stdlib,
  // node-typescript-express}.
  const targets: string[] = [];
  for (const arch of listArchitectures()) {
    const archDef = resolveTarget(arch);
    if (!archDef) continue;
    for (const rtName of archDef.architecture.runtimeTargets) {
      targets.push(`${arch}/${rtName}`);
    }
  }

  for (const t of targets) {
    it.skipIf(skipReason !== null)(
      `passes for ${t} from durable-only state`,
      { timeout: 360_000 },
      async () => { await runDeletionTestForTarget(t, pm!); },
    );
  }
});
