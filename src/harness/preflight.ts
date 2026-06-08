/**
 * Preflight — verify the toolchain BEFORE a run starts (PRD O9).
 *
 * Each assumption is checked independently and reported pass/fail with
 * remediation, so a run aborts in seconds with a fix list instead of failing
 * opaquely mid-generation. Pure: runs cheap `--version`-style probes only.
 */

import { execFileSync } from 'node:child_process';
import { resolveProviderInfo } from '../llm/resolve.js';

export interface PreflightCheck {
  name: string;
  ok: boolean;
  detail: string;
  remediation?: string;
}

export interface PreflightResult {
  ok: boolean;
  checks: PreflightCheck[];
}

export interface PreflightOptions {
  projectRoot: string;
  phoenixDir?: string;
  /** Fail if no LLM provider resolves (generation can't run). */
  requireProvider?: boolean;
  /** Fail if no C toolchain (native modules like better-sqlite3 won't build). */
  requireNativeBuild?: boolean;
  /** Minimum Node major version. Default 18. */
  minNodeMajor?: number;
}

/** True if `cmd --version` (or given probe args) runs without throwing. */
function commandWorks(cmd: string, args: string[] = ['--version']): boolean {
  try {
    execFileSync(cmd, args, { stdio: 'pipe', timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

/** The package manager Phoenix will use to install/build, or null if none. */
export function detectPackageManager(): string | null {
  return ['pnpm', 'npm', 'yarn', 'bun'].find(r => commandWorks(r)) ?? null;
}

export function preflight(opts: PreflightOptions): PreflightResult {
  const checks: PreflightCheck[] = [];
  const minNode = opts.minNodeMajor ?? 18;

  // 1. Runtime version
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  checks.push({
    name: 'runtime',
    ok: nodeMajor >= minNode,
    detail: `Node ${process.versions.node}`,
    remediation: nodeMajor >= minNode ? undefined : `Upgrade Node to >= ${minNode}.`,
  });

  // The typechecker is intentionally NOT checked here: it is an architecture-
  // derived, Phoenix-installed dependency (a devDep the provision step installs),
  // not a host-supplied prerequisite. Its enforcement lives downstream — the
  // per-module typecheck (O3) and the acceptance typecheck — so a genuinely
  // missing/broken `tsc` surfaces as a Phoenix install/build failure, not as a
  // user-facing environment gate. (See DEPENDENCY-LIFECYCLE-OUTCOMES, DC1/DC4.)

  // 2. Package runner
  const runner = detectPackageManager();
  checks.push({
    name: 'package-runner',
    ok: !!runner,
    detail: runner ? `${runner} available` : 'no package manager found',
    remediation: runner ? undefined : 'Install npm, pnpm, yarn, or bun to install dependencies.',
  });

  // 3. Provider reachable (only when generation is required)
  if (opts.requireProvider) {
    const info = resolveProviderInfo(opts.phoenixDir);
    checks.push({
      name: 'llm-provider',
      ok: info.provider !== null,
      detail: info.name ? `${info.name}/${info.model} (from ${info.providerSource})` : 'no provider resolved',
      remediation: info.provider ? undefined : 'Set ANTHROPIC_API_KEY/OPENAI_API_KEY or install the Claude CLI.',
    });
  }

  // 4. Native-build capability (only when an arch needs native modules)
  if (opts.requireNativeBuild) {
    const compiler = ['cc', 'clang', 'gcc'].find(c => commandWorks(c, ['--version']));
    checks.push({
      name: 'native-build',
      ok: !!compiler,
      detail: compiler ? `${compiler} available` : 'no C compiler found',
      remediation: compiler ? undefined : 'Install Xcode Command Line Tools / build-essential for native modules (e.g. better-sqlite3).',
    });
  }

  return { ok: checks.every(c => c.ok), checks };
}
