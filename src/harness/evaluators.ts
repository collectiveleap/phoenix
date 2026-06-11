/**
 * Surface evaluators — producers of post-boot evidence, keyed by evaluation surface.
 *
 * Each evaluator drives the running app for one surface and yields a result: either
 * it `ran` (with an ok/detail) or it did not (tooling or inputs absent → the gate
 * records no check → the policy reports that evidence INCOMPLETE, never a false red).
 * Surfaces — not roles — select evaluators, so a new architecture that declares a
 * surface gets its evidence by registering an evaluator here.
 *
 * The `http-endpoints` surface is produced by the in-process vitest run in
 * `acceptance.ts` (it needs no booted server); the evaluators here are the post-boot
 * producers that drive the live app. Today: `rendered-ui` via Playwright.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { EvaluationSurface } from '../models/architecture.js';

export interface EvaluatorContext {
  projectRoot: string;
  /** The booted server, e.g. `http://localhost:PORT`. */
  baseUrl: string;
  /** Wall-clock budget for this evaluator (ms). */
  timeoutMs: number;
}

export interface EvaluatorResult {
  /** false ⇒ not produced this run (tooling/inputs absent) → INCOMPLETE, not a failure. */
  ran: boolean;
  ok?: boolean;
  detail?: string;
}

export interface SurfaceEvaluator {
  surface: EvaluationSurface;
  /** The acceptance-check name / evidence kind this evaluator produces. */
  produces: string;
  run(ctx: EvaluatorContext): EvaluatorResult;
}

/** Resolve a project-local `.bin` executable, or null if not installed. */
function resolveBin(projectRoot: string, name: string): string | null {
  const bin = join(projectRoot, 'node_modules', '.bin', name);
  return existsSync(bin) ? bin : null;
}

/** Does the project carry any Playwright UI spec (`*.ui.spec.ts`) under src/? */
function hasUiSpecs(projectRoot: string): boolean {
  const root = join(projectRoot, 'src');
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries: import('node:fs').Dirent[];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (e.isDirectory()) { if (e.name !== 'node_modules') stack.push(join(dir, e.name)); }
      else if (e.name.endsWith('.ui.spec.ts')) return true;
    }
  }
  return false;
}

/** A missing browser engine is a provisioning gap, not a behavior failure → INCOMPLETE. */
function isBrowserMissing(output: string): boolean {
  return /Executable doesn't exist|playwright install|please install it|browserType\.launch/i.test(output);
}

/**
 * rendered-ui: drive the booted app with Playwright (`playwright test`), passing the
 * live server as `PHOENIX_BASE_URL`. Degrades to not-ran (→ INCOMPLETE) when Playwright
 * isn't installed, no UI specs exist, or the browser engine isn't provisioned — never
 * a false red. A non-zero exit with specs present and a browser available is a real FAIL.
 */
export const renderedUiEvaluator: SurfaceEvaluator = {
  surface: 'rendered-ui',
  produces: 'ui_behavior',
  run({ projectRoot, baseUrl, timeoutMs }) {
    const playwright = resolveBin(projectRoot, 'playwright');
    if (!playwright) return { ran: false };          // not provisioned
    if (!hasUiSpecs(projectRoot)) return { ran: false }; // nothing to evaluate
    try {
      execFileSync(playwright, ['test'], {
        cwd: projectRoot,
        stdio: 'pipe',
        timeout: timeoutMs,
        env: { ...process.env, PHOENIX_BASE_URL: baseUrl },
      });
      return { ran: true, ok: true, detail: 'ui scenarios pass' };
    } catch (e) {
      const err = e as { stdout?: Buffer; stderr?: Buffer; signal?: string };
      const text = `${err.stdout?.toString() ?? ''}${err.stderr?.toString() ?? ''}`;
      if (isBrowserMissing(text)) return { ran: false }; // provisioning gap → INCOMPLETE
      const why = err.signal === 'SIGTERM' ? 'timed out' : (text.trim().slice(-300) || 'non-zero exit');
      return { ran: true, ok: false, detail: `ui scenarios failed — ${why}` };
    }
  },
};

/** Post-boot evaluators by surface. A new surface registers its evaluator here. */
export const SURFACE_EVALUATORS: Partial<Record<EvaluationSurface, SurfaceEvaluator>> = {
  'rendered-ui': renderedUiEvaluator,
};
