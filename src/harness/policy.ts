/**
 * Failure-handling policy (PRD O14).
 *
 * Timeout, retries, backoff, size cap, repair-iteration cap, and skip-vs-abort
 * are all data, not code — change a threshold in `.phoenix/config.json` and
 * behaviour changes with no code edit. `phoenix run --dry-run` prints the
 * resolved policy per stage.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { HealthBudgets } from '../observe/journal.js';
import { DEFAULT_BUDGETS } from '../observe/journal.js';
import { DEFAULT_IU_SIZE_THRESHOLD } from '../iu-planner.js';

export interface RunPolicy {
  /** Stall budgets for the watchdog (startup / stream / wedge), in ms. */
  budgets: HealthBudgets;
  /** Max repair attempts per module before reporting a capped loop. */
  maxRepairs: number;
  /** Max generation retries per module on hard failure. */
  maxRetries: number;
  /** Backoff between retries, in ms (multiplied by attempt). */
  backoffMs: number;
  /** Module source-node count above which generation is flagged/gated. */
  sizeThreshold: number;
  /** On a module that ultimately fails: skip and continue, or abort the run. */
  onModuleFailure: 'skip' | 'abort';
}

export const DEFAULT_POLICY: RunPolicy = {
  budgets: { ...DEFAULT_BUDGETS },
  maxRepairs: 2,
  maxRetries: 1,
  backoffMs: 2_000,
  sizeThreshold: DEFAULT_IU_SIZE_THRESHOLD,
  onModuleFailure: 'skip',
};

/** Deep-merge a partial policy from config over the defaults. */
function mergePolicy(base: RunPolicy, override: unknown): RunPolicy {
  if (!override || typeof override !== 'object') return base;
  const o = override as Record<string, unknown>;
  const budgets = (o.budgets && typeof o.budgets === 'object')
    ? { ...base.budgets, ...(o.budgets as Partial<HealthBudgets>) }
    : base.budgets;
  return {
    budgets,
    maxRepairs: typeof o.maxRepairs === 'number' ? o.maxRepairs : base.maxRepairs,
    maxRetries: typeof o.maxRetries === 'number' ? o.maxRetries : base.maxRetries,
    backoffMs: typeof o.backoffMs === 'number' ? o.backoffMs : base.backoffMs,
    sizeThreshold: typeof o.sizeThreshold === 'number' ? o.sizeThreshold : base.sizeThreshold,
    onModuleFailure: o.onModuleFailure === 'abort' ? 'abort' : base.onModuleFailure,
  };
}

/** Resolve the run policy from `.phoenix/config.json` (`policy` key) + defaults. */
export function loadPolicy(phoenixDir?: string): RunPolicy {
  if (!phoenixDir) return { ...DEFAULT_POLICY };
  const configPath = join(phoenixDir, 'config.json');
  if (!existsSync(configPath)) return { ...DEFAULT_POLICY };
  try {
    const config = JSON.parse(readFileSync(configPath, 'utf8')) as { policy?: unknown };
    return mergePolicy(DEFAULT_POLICY, config.policy);
  } catch {
    return { ...DEFAULT_POLICY };
  }
}

/** Human-readable lines describing the policy that would apply at each stage. */
export function describePolicy(policy: RunPolicy): string[] {
  return [
    `preflight   → abort run if any required tool is missing`,
    `canonicalize→ LLM normalize when available, else rule-based`,
    `plan        → flag modules > ${policy.sizeThreshold} source nodes as oversized`,
    `generate    → watchdog startup ${policy.budgets.startupMs}ms / stream-stall ${policy.budgets.streamStallMs}ms / wedge ${policy.budgets.wedgeMs}ms`,
    `            → up to ${policy.maxRepairs} repair(s), ${policy.maxRetries} retry(ies), backoff ${policy.backoffMs}ms × attempt`,
    `            → on module failure: ${policy.onModuleFailure}`,
    `acceptance  → typecheck + boot + root-200 must pass for "done"`,
  ];
}
