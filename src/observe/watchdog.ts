/**
 * Watchdog — wall-clock supervision of streaming LLM calls (PRD O2, O8).
 *
 * Design choices driven by the stress-test reference failures:
 *  - A wall-clock *polling* timer (setInterval), never a background `sleep`
 *    whose pipe blocks the caller for the full timeout on every call
 *    (appendix #2, the pipe-holding watchdog).
 *  - Kills via an AbortSignal that the provider honours (process kill for the
 *    CLI, fetch abort for the APIs) — no orphaned child outlives the call.
 *  - Distinguishes startup-stall (no first byte) from stream-stall (first byte
 *    then silence) so a big-but-progressing module is not killed (appendix #4).
 *  - A run-lifetime keep-awake (`caffeinate -i` on macOS) so timers fire on
 *    schedule under OS power-throttling (appendix #9).
 */

import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { RunJournal, DEFAULT_BUDGETS } from './journal.js';
import type { HealthBudgets, CallHealth } from './journal.js';
import { recordedGenerate, BoundsExceededError } from './instrument.js';
import type { CallContext } from './instrument.js';
import type { LLMProvider, GenerateOptions } from '../llm/provider.js';

/** Health states the watchdog treats as a kill condition. */
const KILL_HEALTH: ReadonlySet<CallHealth> = new Set<CallHealth>([
  'startup-stalled',
  'stream-stalled',
  'returned-then-wedged',
  'exceeded-bounds',
]);

export interface WatchdogOptions {
  /** Stall budgets. Defaults to DEFAULT_BUDGETS. */
  budgets?: HealthBudgets;
  /** How often to poll call health, in ms. Default 1000. */
  pollMs?: number;
}

/** Controllers for calls currently in flight, so run teardown can kill them all. */
const inFlight = new Set<AbortController>();

/** Abort every supervised call currently running (used on run teardown — O11). */
export function abortAllInFlight(): void {
  for (const c of inFlight) {
    try { c.abort(); } catch { /* ignore */ }
  }
  inFlight.clear();
}

/**
 * Run a generation under watchdog supervision: the call self-records to the
 * journal, and a polling timer aborts it if it stalls. On a stall the watchdog
 * records a `watchdog_kill` event and the call's terminal outcome becomes
 * `timeout`. Re-throws on failure (caller's retry policy decides next steps).
 */
export async function supervisedGenerate(
  journal: RunJournal,
  provider: LLMProvider,
  prompt: string,
  options: GenerateOptions | undefined,
  ctx: CallContext,
  wd?: WatchdogOptions,
): Promise<string> {
  const budgets = wd?.budgets ?? DEFAULT_BUDGETS;
  const pollMs = wd?.pollMs ?? 1000;

  const controller = new AbortController();
  inFlight.add(controller);
  // Chain an externally-supplied signal so callers can still cancel.
  const callerSignal = options?.signal;
  if (callerSignal) {
    if (callerSignal.aborted) controller.abort();
    else callerSignal.addEventListener('abort', () => controller.abort(), { once: true });
  }

  let callId: string | undefined;
  let killed = false;
  const timer = setInterval(() => {
    if (!callId) return;
    const rec = journal.getCall(callId);
    if (!rec || rec.endedAt !== undefined) return;
    const health = RunJournal.classify(rec, budgets);
    if (!KILL_HEALTH.has(health)) return;
    killed = true;
    const elapsedMs = Date.now() - rec.startedAt;
    if (health === 'exceeded-bounds') {
      // Runaway (G4): bound by bytes or wall-clock, not a stall. Abort WITH a
      // typed reason so instrument records `over_budget` and re-throws it with the
      // captured partial output — distinct event, never `watchdog_kill`.
      const bound = budgets.maxBytes && rec.bytesStreamed > budgets.maxBytes ? 'bytes' : 'duration';
      journal.event('generation_bounds_exceeded', {
        callId, bound, bytes: rec.bytesStreamed, elapsedMs,
        stage: rec.stage, target: rec.target, attempt: rec.attempt,
      });
      controller.abort(new BoundsExceededError(bound, rec.bytesStreamed, elapsedMs));
    } else {
      journal.event('watchdog_kill', {
        callId, health, stage: rec.stage, target: rec.target, attempt: rec.attempt, elapsedMs,
      });
      controller.abort();
    }
    clearInterval(timer);
  }, pollMs);
  // Don't let the poll timer keep the process alive on its own.
  (timer as unknown as { unref?: () => void }).unref?.();

  try {
    return await recordedGenerate(
      journal,
      provider,
      prompt,
      { ...options, signal: controller.signal },
      ctx,
      { onCallStart: (id) => { callId = id; } },
    );
  } catch (err) {
    // A bounds abort (G4) is already a precise, captured error — surface it as-is.
    if (err instanceof BoundsExceededError) throw err;
    if (killed) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Watchdog killed stalled call (${ctx.target ?? ctx.stage}): ${message}`);
    }
    throw err;
  } finally {
    clearInterval(timer);
    inFlight.delete(controller);
  }
}

/**
 * Run-lifetime keep-awake. On macOS holds a `caffeinate -i` process so the
 * watchdog's wall-clock timers are not delayed/defeated by power management
 * (appendix #9). A no-op on other platforms.
 */
export class KeepAwake {
  private child?: ChildProcess;

  start(): void {
    if (this.child) return;
    if (process.platform !== 'darwin') return;
    try {
      this.child = spawn('caffeinate', ['-i'], { stdio: 'ignore' });
      this.child.unref();
      this.child.on('error', () => { this.child = undefined; });
    } catch {
      this.child = undefined;
    }
  }

  stop(): void {
    if (this.child) {
      this.child.kill();
      this.child = undefined;
    }
  }
}
