/**
 * Provision stage (B1/B2): install declared dependencies and build native ones.
 *
 * Phoenix regenerates from scratch, so installing the architecture's declared
 * deps — and building any native module among them — is Phoenix's job, not the
 * user's. This module owns:
 *   1. running `<pm> install` in the project root, and
 *   2. for each declared native dep, ensuring its binding is built (`<pm>
 *      rebuild <dep>`) and actually loadable — failing with an explicit
 *      remediation instead of letting an opaque "could not locate the bindings
 *      file" error surface at boot.
 *
 * Command construction is exported so it can be unit-tested without a real
 * install.
 */

import { spawnSync } from 'node:child_process';
import { detectPackageManager } from './preflight.js';

export interface ProvisionStep {
  name: string;
  ok: boolean;
  detail: string;
}

export interface ProvisionResult {
  ok: boolean;
  pm: string | null;
  steps: ProvisionStep[];
}

export interface ProvisionOptions {
  projectRoot: string;
  /** Declared native deps to build/verify (from `arch.runtime.nativeDeps`). */
  nativeDeps?: string[];
  /** Override the detected package manager (mainly for tests). */
  packageManager?: string | null;
  /** Per-step logger. */
  log?: (msg: string) => void;
}

/** The `<pm> install` command for a package manager. */
export function installCommand(pm: string): { cmd: string; args: string[] } {
  return { cmd: pm, args: ['install'] };
}

/**
 * The command that forces a (re)build of a single dependency's install
 * scripts, or null when the package manager has no equivalent (then we rely on
 * the install + allowlist having built it, and only verify).
 */
export function rebuildCommand(pm: string, dep: string): { cmd: string; args: string[] } | null {
  switch (pm) {
    case 'pnpm':
    case 'npm':
      return { cmd: pm, args: ['rebuild', dep] };
    default:
      return null; // yarn/bun: install with the allowlist builds it; verify only.
  }
}

/** Verify a native dependency's binding actually loads from the project. */
function bindingLoads(projectRoot: string, dep: string): boolean {
  // `node -e require(...)` runs as CommonJS regardless of the project's
  // "type": "module", and exercises the compiled native binding.
  const res = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(dep)})`], {
    cwd: projectRoot,
    stdio: 'pipe',
    timeout: 30_000,
  });
  return res.status === 0;
}

/** Run a command, returning a step report. */
function runStep(name: string, cmd: string, args: string[], cwd: string, timeoutMs: number): ProvisionStep {
  const res = spawnSync(cmd, args, { cwd, stdio: 'pipe', timeout: timeoutMs });
  if (res.error) {
    return { name, ok: false, detail: `${cmd} ${args.join(' ')} failed: ${res.error.message}` };
  }
  if (res.status !== 0) {
    const err = (res.stderr?.toString() ?? '').trim().slice(0, 300);
    return { name, ok: false, detail: `${cmd} ${args.join(' ')} exited ${res.status}${err ? `: ${err}` : ''}` };
  }
  return { name, ok: true, detail: `${cmd} ${args.join(' ')}` };
}

/**
 * Install deps and build/verify native deps. Stops at the first failed step
 * and returns the report so the caller can fail the run with a clear cause.
 */
export function provision(opts: ProvisionOptions): ProvisionResult {
  const log = opts.log ?? (() => {});
  const pm = opts.packageManager !== undefined ? opts.packageManager : detectPackageManager();
  const steps: ProvisionStep[] = [];

  if (!pm) {
    steps.push({ name: 'package-manager', ok: false, detail: 'no package manager found (install npm, pnpm, yarn, or bun)' });
    return { ok: false, pm: null, steps };
  }

  // 1. Install declared dependencies.
  const inst = installCommand(pm);
  log(`provision: ${pm} install`);
  const installStep = runStep('install', inst.cmd, inst.args, opts.projectRoot, 300_000);
  steps.push(installStep);
  if (!installStep.ok) return { ok: false, pm, steps };

  // 2. Build + verify each declared native dependency.
  for (const dep of opts.nativeDeps ?? []) {
    const rb = rebuildCommand(pm, dep);
    if (rb) {
      log(`provision: ${pm} rebuild ${dep}`);
      const rebuilt = runStep(`build:${dep}`, rb.cmd, rb.args, opts.projectRoot, 300_000);
      steps.push(rebuilt);
      if (!rebuilt.ok) return { ok: false, pm, steps };
    }

    const built = bindingLoads(opts.projectRoot, dep);
    const rebuildHint = rb ? `${rb.cmd} ${rb.args.join(' ')}` : `${pm} install`;
    steps.push({
      name: `verify:${dep}`,
      ok: built,
      detail: built ? `${dep} binding loads` : `native dependency \`${dep}\` not built — run \`${rebuildHint}\``,
    });
    if (!built) return { ok: false, pm, steps };
  }

  return { ok: true, pm, steps };
}
