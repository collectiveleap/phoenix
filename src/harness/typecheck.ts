/**
 * TypeScript checker resolution + invocation (PRD O3).
 *
 * The reference failure (appendix #1) was a phantom-error repair loop: when
 * the typechecker was absent, "command not found" was returned as if it were
 * type errors, so the repair loop fired wasted LLM calls. The fix is to treat
 * a missing/broken tool as a distinct `unavailable` outcome — never as type
 * errors — and to probe availability before any repair work.
 *
 * Shared by regen (per-file repair loop), preflight (O9), and the acceptance
 * gate (O12, whole-project check).
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export interface TypecheckCommand {
  cmd: string;
  args: string[];
  label: string;
}

export interface TypecheckProbe {
  available: boolean;
  command?: TypecheckCommand;
  detail: string;
}

/** A real TypeScript diagnostic looks like `path(1,2): error TS1234: …`. */
const ERROR_TS = /error TS\d+/;

/**
 * Resolve a TypeScript checker, preferring the project's local install, then
 * a global `tsc`, then `npx tsc`. Verifies the candidate actually runs.
 */
export function probeTypechecker(projectRoot: string): TypecheckProbe {
  const candidates: TypecheckCommand[] = [];
  const localBin = join(projectRoot, 'node_modules', '.bin', 'tsc');
  if (existsSync(localBin)) candidates.push({ cmd: localBin, args: [], label: 'node_modules/.bin/tsc' });
  candidates.push({ cmd: 'tsc', args: [], label: 'tsc (PATH)' });
  candidates.push({ cmd: 'npx', args: ['--no-install', 'tsc'], label: 'npx tsc' });

  for (const c of candidates) {
    try {
      execFileSync(c.cmd, [...c.args, '--version'], { cwd: projectRoot, stdio: 'pipe', timeout: 10_000 });
      return { available: true, command: c, detail: `Using ${c.label}` };
    } catch {
      // try next candidate
    }
  }
  return {
    available: false,
    detail: 'TypeScript compiler not found (looked for node_modules/.bin/tsc, tsc on PATH, npx tsc)',
  };
}

export type TypecheckResult =
  | { status: 'clean'; command: string }
  | { status: 'errors'; errors: string; count: number; command: string }
  | { status: 'unavailable'; detail: string };

/**
 * Run `tsc --noEmit` over the project. Distinguishes a tool failure
 * (`unavailable`) from real type errors (`errors`) by requiring the output to
 * contain at least one `error TS####` diagnostic before treating it as errors.
 *
 * @param filter when set, only diagnostic lines mentioning this path are kept.
 */
export function typecheckProject(
  projectRoot: string,
  filter?: string,
  probe?: TypecheckProbe,
): TypecheckResult {
  const p = probe ?? probeTypechecker(projectRoot);
  if (!p.available || !p.command) {
    return { status: 'unavailable', detail: p.detail };
  }
  const label = p.command.label;
  try {
    execFileSync(p.command.cmd, [...p.command.args, '--noEmit'], {
      cwd: projectRoot,
      stdio: 'pipe',
      timeout: 120_000,
    });
    return { status: 'clean', command: label };
  } catch (err: unknown) {
    const e = err as { stdout?: Buffer; stderr?: Buffer; code?: unknown; signal?: string };
    const output = ((e.stdout?.toString() ?? '') + (e.stderr?.toString() ?? '')).trim();

    // No TS diagnostics in the output → the tool itself failed (ENOENT,
    // killed, crashed). Never treat this as type errors (appendix #1).
    if (!ERROR_TS.test(output)) {
      const reason = output || `typechecker exited abnormally (code ${String(e.code)}${e.signal ? `, signal ${e.signal}` : ''})`;
      return { status: 'unavailable', detail: reason };
    }

    const lines = output.split('\n');
    const filtered = filter ? lines.filter(l => l.includes(filter)) : lines;
    const kept = filtered.length > 0 ? filtered : lines;
    const count = kept.filter(l => ERROR_TS.test(l)).length;
    return { status: 'errors', errors: kept.join('\n').trim(), count, command: label };
  }
}
