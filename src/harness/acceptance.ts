/**
 * Acceptance gate (PRD O12 / appendix #7).
 *
 * "Build succeeded" must mean the app actually runs. After generation this
 * gate reports green/red on:
 *   1. whole-project typecheck clean,
 *   2. the server boots,
 *   3. a health/root route returns 200.
 * The run is "done" only if every check is green; on failure the failing
 * check is named.
 */

import { spawn, execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { typecheckProject } from './typecheck.js';

export interface AcceptanceCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface AcceptanceResult {
  ok: boolean;
  checks: AcceptanceCheck[];
}

export interface AcceptanceOptions {
  projectRoot: string;
  /** Skip the boot + route checks (e.g. dependencies not installed). */
  skipRuntime?: boolean;
  /** Command to boot the server. Defaults to the project's tsx/start script. */
  bootCommand?: { cmd: string; args: string[] };
  /** Path probed for a 200. Default '/health'. */
  healthPath?: string;
  /** Port the server should listen on. Default: a free port. */
  port?: number;
  /** Max ms to wait for the server to become reachable. Default 15000. */
  bootTimeoutMs?: number;
}

/** Find a free TCP port. */
function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

/** Resolve how to boot the generated server. */
function resolveBootCommand(projectRoot: string): { cmd: string; args: string[] } | null {
  const tsx = join(projectRoot, 'node_modules', '.bin', 'tsx');
  if (existsSync(tsx) && existsSync(join(projectRoot, 'src', 'server.ts'))) {
    return { cmd: tsx, args: ['src/server.ts'] };
  }
  // Fall back to the package's start script if a runner is available.
  const pkgPath = join(projectRoot, 'package.json');
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { scripts?: Record<string, string> };
      if (pkg.scripts?.start) return { cmd: 'npm', args: ['start', '--silent'] };
    } catch { /* ignore */ }
  }
  return null;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** Poll a URL until it returns 200 or the deadline passes. */
async function waitForOk(url: string, deadline: number): Promise<{ ok: boolean; status?: number; detail: string }> {
  let lastErr = 'no response';
  while (Date.now() < deadline) {
    try {
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), 2_000);
      const res = await fetch(url, { signal: ac.signal });
      clearTimeout(t);
      if (res.status === 200) return { ok: true, status: 200, detail: `200 from ${url}` };
      lastErr = `status ${res.status}`;
    } catch (err) {
      lastErr = err instanceof Error ? err.message : String(err);
    }
    await sleep(300);
  }
  return { ok: false, detail: `never returned 200 (${lastErr})` };
}

/** Run the acceptance gate. */
export async function runAcceptance(opts: AcceptanceOptions): Promise<AcceptanceResult> {
  const checks: AcceptanceCheck[] = [];

  // 1. Whole-project typecheck.
  const tc = typecheckProject(opts.projectRoot);
  checks.push({
    name: 'typecheck',
    ok: tc.status === 'clean',
    detail: tc.status === 'clean' ? `clean (${tc.command})`
      : tc.status === 'errors' ? `${tc.count} type error(s)`
      : `typecheck unavailable: ${tc.detail}`,
  });

  if (opts.skipRuntime) {
    return { ok: checks.every(c => c.ok), checks };
  }

  // 2. Run the generated test suite (unit_tests evidence). The generated tests
  // exist but were never executed; running them is what gives them teeth.
  const vitestBin = join(opts.projectRoot, 'node_modules', '.bin', 'vitest');
  if (existsSync(vitestBin)) {
    try {
      execFileSync(vitestBin, ['run'], { cwd: opts.projectRoot, stdio: 'pipe', timeout: 120_000 });
      checks.push({ name: 'unit_tests', ok: true, detail: 'generated tests pass' });
    } catch (e) {
      const out = (e as { stdout?: Buffer }).stdout?.toString().trim().slice(-300) ?? '';
      checks.push({ name: 'unit_tests', ok: false, detail: `generated tests failed${out ? ` — ${out}` : ''}` });
    }
  } else {
    checks.push({ name: 'unit_tests', ok: false, detail: 'vitest not installed (provision deps)' });
  }

  // 3 + 4. Boot the server and probe a route.
  const boot = opts.bootCommand ?? resolveBootCommand(opts.projectRoot);
  if (!boot) {
    checks.push({ name: 'boot', ok: false, detail: 'no boot command (install deps / add a start script)' });
    return { ok: false, checks };
  }

  const port = opts.port ?? await getFreePort();
  const healthPath = opts.healthPath ?? '/health';
  const child = spawn(boot.cmd, boot.args, {
    cwd: opts.projectRoot,
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, PORT: String(port) },
  });

  let booted = false;
  const killTree = () => {
    try { if (child.pid) process.kill(-child.pid, 'SIGKILL'); }
    catch { child.kill('SIGKILL'); }
  };

  try {
    const deadline = Date.now() + (opts.bootTimeoutMs ?? 15_000);
    const probe = await waitForOk(`http://localhost:${port}${healthPath}`, deadline);
    booted = probe.ok;
    checks.push({ name: 'boot', ok: booted, detail: booted ? `listening on :${port}` : 'server did not start' });
    checks.push({ name: 'root-route', ok: probe.ok, detail: probe.detail });
  } finally {
    killTree();
  }

  return { ok: checks.every(c => c.ok), checks };
}
