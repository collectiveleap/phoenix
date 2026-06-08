/**
 * Run Journal — the per-run event log and the spine of observability.
 *
 * Every LLM call's lifecycle is recorded as a sequence of append-only JSONL
 * events under `.phoenix/runs/<runId>/events.jsonl`, plus a `state.json`
 * snapshot for fast live reads. From the events alone — with no OS-process
 * inspection — any call can be reconstructed and classified as healthy,
 * startup-stalled, stream-stalled, or returned-then-wedged (PRD outcome O1).
 *
 * Other pipeline stages (typecheck, scaffold writes, watchdog kills, …) log
 * to the same journal via the generic `event()` method so a single surface
 * answers "what's happening / is it stuck / how far along" (O15).
 */

import { mkdirSync, appendFileSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Terminal outcome of a single LLM call.
 * - `truncated`: completed-but-truncated — the model hit the output-token budget
 *   (`stop_reason: max_tokens`). Distinct from a stall/timeout: the call returned,
 *   it just ran out of budget. Deterministic, so it is not retried (T2/T3).
 * - `over_budget`: the call exceeded Phoenix's own generation bounds (wall-clock
 *   or byte budget) and was aborted — the runaway case where the provider's cap
 *   is unenforced (G4). Distinct from `timeout` (a stall): the call was actively
 *   producing, just past the budget. Deterministic, so it is not retried.
 */
export type CallOutcome = 'ok' | 'timeout' | 'error' | 'empty' | 'truncated' | 'over_budget';

/**
 * Health of a call, derivable from records alone (O1).
 * - healthy: in-flight and making progress
 * - startup-stalled: started, no first byte within budget
 * - stream-stalled: first byte seen, then silence beyond budget
 * - returned-then-wedged: stream finished but the call never finalized
 * - completed / failed: terminal
 */
export type CallHealth =
  | 'healthy'
  | 'startup-stalled'
  | 'stream-stalled'
  | 'returned-then-wedged'
  | 'exceeded-bounds'
  | 'completed'
  | 'failed';

/** Budgets used to classify in-flight calls. */
export interface HealthBudgets {
  /** Max ms with no first byte before a call is startup-stalled. */
  startupMs: number;
  /** Max ms of stream silence (after first byte) before stream-stalled. */
  streamStallMs: number;
  /** Max ms after stream end with no finalization before returned-then-wedged. */
  wedgeMs: number;
  /**
   * Max total wall-clock ms a single call may run before it is `exceeded-bounds`
   * (G4). Bounds a *steadily-streaming* runaway that the stall budgets miss —
   * needed because claude-cli ignores CLAUDE_CODE_MAX_OUTPUT_TOKENS and can run
   * unbounded. Omit/0 to disable.
   */
  maxDurationMs?: number;
  /** Max total streamed bytes before `exceeded-bounds` (G4). Omit/0 to disable. */
  maxBytes?: number;
}

export const DEFAULT_BUDGETS: HealthBudgets = {
  startupMs: 60_000,
  streamStallMs: 45_000,
  wedgeMs: 30_000,
  maxDurationMs: 300_000, // 5 min — a generation past this is a runaway, not work
  maxBytes: 262_144,      // 256 KB ≈ 8× the 29 KB reference web-experience module
};

/** Reconstructable record of one LLM call. */
export interface CallRecord {
  callId: string;
  stage: string;
  /** Target module / IU name, if the call belongs to one. */
  target?: string;
  attempt: number;
  provider: string;
  model: string;
  promptBytes: number;
  startedAt: number;
  ttfbAt?: number;
  /** When the provider's output stream ended (stdout closed). */
  streamEndedAt?: number;
  endedAt?: number;
  /** When the most recent byte arrived (for stream-stall detection). */
  lastByteAt?: number;
  bytesStreamed: number;
  tokens?: number;
  outcome?: CallOutcome;
  /** Provider stop reason, when reported (e.g. `end_turn`, `max_tokens`). */
  stopReason?: string;
  errorText?: string;
}

/** A single journal event as persisted to JSONL. */
export interface JournalEvent {
  ts: number;
  type: string;
  [key: string]: unknown;
}

/** Fields needed to open a call record. */
export interface CallStartInfo {
  stage: string;
  target?: string;
  attempt: number;
  provider: string;
  model: string;
  promptBytes: number;
}

/** Fields needed to close a call record. */
export interface CallEndInfo {
  outcome: CallOutcome;
  bytesStreamed?: number;
  tokens?: number;
  stopReason?: string;
  errorText?: string;
}

/** Live snapshot persisted to state.json and consumed by the status surface. */
export interface RunSnapshot {
  runId: string;
  startedAt: number;
  endedAt?: number;
  outcome?: string;
  stage?: string;
  stages: { name: string; startedAt: number; endedAt?: number; outcome?: string }[];
  calls: CallRecord[];
}

function now(): number {
  return Date.now();
}

/** Generate a sortable, collision-resistant run id. */
export function generateRunId(): string {
  const d = new Date();
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  const stamp =
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  const rand = Math.random().toString(16).slice(2, 8);
  return `run-${stamp}-${rand}`;
}

export class RunJournal {
  readonly runId: string;
  readonly dir: string;
  private eventsPath: string;
  private statePath: string;
  private calls = new Map<string, CallRecord>();
  private stages: RunSnapshot['stages'] = [];
  private currentStage?: string;
  private startedAt = now();
  private endedAt?: number;
  private outcome?: string;
  private callSeq = 0;

  constructor(phoenixRoot: string, runId?: string) {
    this.runId = runId ?? generateRunId();
    this.dir = join(phoenixRoot, 'runs', this.runId);
    mkdirSync(this.dir, { recursive: true });
    this.eventsPath = join(this.dir, 'events.jsonl');
    this.statePath = join(this.dir, 'state.json');
  }

  // ─── Generic event sink ────────────────────────────────────────────────

  /** Append a typed event. Other stages use this for non-call events. */
  event(type: string, data: Record<string, unknown> = {}): void {
    const ev: JournalEvent = { ts: now(), type, ...data };
    appendFileSync(this.eventsPath, JSON.stringify(ev) + '\n', 'utf8');
  }

  // ─── Run / stage lifecycle ─────────────────────────────────────────────

  startRun(meta: Record<string, unknown> = {}): void {
    this.startedAt = now();
    this.event('run_start', { runId: this.runId, ...meta });
    this.persist();
  }

  endRun(outcome: string, meta: Record<string, unknown> = {}): void {
    this.endedAt = now();
    this.outcome = outcome;
    this.event('run_end', { outcome, ...meta });
    this.persist();
  }

  startStage(name: string, meta: Record<string, unknown> = {}): void {
    this.currentStage = name;
    this.stages.push({ name, startedAt: now() });
    this.event('stage_start', { stage: name, ...meta });
    this.persist();
  }

  endStage(name: string, outcome = 'ok', meta: Record<string, unknown> = {}): void {
    const s = [...this.stages].reverse().find(st => st.name === name && st.endedAt === undefined);
    if (s) {
      s.endedAt = now();
      s.outcome = outcome;
    }
    if (this.currentStage === name) this.currentStage = undefined;
    this.event('stage_end', { stage: name, outcome, ...meta });
    this.persist();
  }

  // ─── Call lifecycle ────────────────────────────────────────────────────

  /** Open a call record. Returns the callId used by the remaining hooks. */
  startCall(info: CallStartInfo): string {
    const callId = `${this.runId}-c${String(++this.callSeq).padStart(4, '0')}`;
    const rec: CallRecord = {
      callId,
      stage: info.stage,
      target: info.target,
      attempt: info.attempt,
      provider: info.provider,
      model: info.model,
      promptBytes: info.promptBytes,
      startedAt: now(),
      bytesStreamed: 0,
    };
    this.calls.set(callId, rec);
    this.event('call_start', { ...info, callId });
    this.persist();
    return callId;
  }

  /** Record time-to-first-byte. */
  firstByte(callId: string): void {
    const rec = this.calls.get(callId);
    if (!rec || rec.ttfbAt !== undefined) return;
    const t = now();
    rec.ttfbAt = t;
    rec.lastByteAt = t;
    this.event('call_first_byte', { callId });
    this.persist();
  }

  /** Record cumulative streamed bytes (liveness heartbeat). */
  progress(callId: string, bytesStreamed: number): void {
    const rec = this.calls.get(callId);
    if (!rec) return;
    rec.bytesStreamed = bytesStreamed;
    rec.lastByteAt = now();
    this.event('call_progress', { callId, bytesStreamed });
    this.persist();
  }

  /** Record that the provider's output stream ended (stdout closed). */
  streamEnd(callId: string): void {
    const rec = this.calls.get(callId);
    if (!rec) return;
    rec.streamEndedAt = now();
    this.event('call_stream_end', { callId });
    this.persist();
  }

  /** Finalize a call. */
  endCall(callId: string, info: CallEndInfo): void {
    const rec = this.calls.get(callId);
    if (!rec) return;
    rec.endedAt = now();
    rec.outcome = info.outcome;
    if (info.bytesStreamed !== undefined) rec.bytesStreamed = info.bytesStreamed;
    if (info.tokens !== undefined) rec.tokens = info.tokens;
    if (info.stopReason !== undefined) rec.stopReason = info.stopReason;
    if (info.errorText !== undefined) rec.errorText = info.errorText;
    this.event('call_end', { callId, ...info });
    this.persist();
  }

  // ─── Reads ─────────────────────────────────────────────────────────────

  getCall(callId: string): CallRecord | undefined {
    return this.calls.get(callId);
  }

  callList(): CallRecord[] {
    return [...this.calls.values()];
  }

  /** Calls that have started but not finalized. */
  activeCalls(): CallRecord[] {
    return this.callList().filter(c => c.endedAt === undefined);
  }

  snapshot(): RunSnapshot {
    return {
      runId: this.runId,
      startedAt: this.startedAt,
      endedAt: this.endedAt,
      outcome: this.outcome,
      stage: this.currentStage,
      stages: this.stages.map(s => ({ ...s })),
      calls: this.callList().map(c => ({ ...c })),
    };
  }

  private persist(): void {
    writeFileSync(this.statePath, JSON.stringify(this.snapshot(), null, 2), 'utf8');
  }

  // ─── Static helpers ────────────────────────────────────────────────────

  /**
   * Classify a call's health from its record alone (O1).
   * `at` defaults to now so live and post-hoc classification share logic.
   */
  static classify(rec: CallRecord, budgets: HealthBudgets = DEFAULT_BUDGETS, at: number = now()): CallHealth {
    if (rec.outcome === 'ok') return 'completed';
    // A truncation (over budget) is a resolved call, not a stall — terminal.
    if (rec.outcome === 'truncated') return 'completed';
    if (rec.endedAt !== undefined) return 'failed';

    // Generation bounds (G4) — checked BEFORE the stall budgets so a runaway that
    // is *still streaming* (never silent) is caught. claude-cli ignores the output
    // cap, so without this a runaway only trips a stall budget after it finally
    // goes silent — minutes/hundreds-of-KB too late.
    if (budgets.maxDurationMs && at - rec.startedAt > budgets.maxDurationMs) return 'exceeded-bounds';
    if (budgets.maxBytes && rec.bytesStreamed > budgets.maxBytes) return 'exceeded-bounds';

    // Stream finished but the call never finalized → caller is wedged.
    if (rec.streamEndedAt !== undefined) {
      return at - rec.streamEndedAt > budgets.wedgeMs ? 'returned-then-wedged' : 'healthy';
    }
    // No parsed first-content token yet. Liveness is BYTE GROWTH, not elapsed time
    // (W1): a call still receiving output bytes is healthy regardless of how slow
    // its first parsed token is — e.g. a large stream-json assistant message is one
    // long line, so `ttfbAt` (set on the first parsed text) doesn't fire until the
    // whole SPA has streamed, while `lastByteAt` advances on every chunk. Measuring
    // from `startedAt` here latched `startup-stalled` and killed calls mid-stream.
    // Only a call with no byte growth for the startup budget is genuinely stalled.
    if (rec.ttfbAt === undefined) {
      return at - (rec.lastByteAt ?? rec.startedAt) > budgets.startupMs ? 'startup-stalled' : 'healthy';
    }
    // First content seen — check for stream silence (byte growth) the same way.
    const sinceLastByte = at - (rec.lastByteAt ?? rec.ttfbAt);
    return sinceLastByte > budgets.streamStallMs ? 'stream-stalled' : 'healthy';
  }

  /** List run ids under `.phoenix/runs/`, newest first. */
  static listRuns(phoenixRoot: string): string[] {
    const runsDir = join(phoenixRoot, 'runs');
    if (!existsSync(runsDir)) return [];
    return readdirSync(runsDir, { withFileTypes: true })
      .filter(d => d.isDirectory() && d.name.startsWith('run-'))
      .map(d => d.name)
      .sort()
      .reverse();
  }

  /** Read a persisted run's state snapshot (after the fact). */
  static readState(phoenixRoot: string, runId: string): RunSnapshot | null {
    const p = join(phoenixRoot, 'runs', runId, 'state.json');
    if (!existsSync(p)) return null;
    return JSON.parse(readFileSync(p, 'utf8')) as RunSnapshot;
  }

  /** Replay a persisted run's raw events (after the fact). */
  static readEvents(phoenixRoot: string, runId: string): JournalEvent[] {
    const p = join(phoenixRoot, 'runs', runId, 'events.jsonl');
    if (!existsSync(p)) return [];
    return readFileSync(p, 'utf8')
      .split('\n')
      .filter(line => line.trim().length > 0)
      .map(line => JSON.parse(line) as JournalEvent);
  }
}
