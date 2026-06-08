/**
 * W1–W4 — output growth is liveness; the startup-stall is not latched.
 * Regression for WEBUI-WATCHDOG-STICKY-STALL: a call streaming ~63 KB while
 * `ttfbAt` is still unset (single-line stream-json) was latched `startup-stalled`
 * and killed mid-stream.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RunJournal, DEFAULT_BUDGETS } from '../../src/observe/journal.js';
import type { CallRecord, HealthBudgets } from '../../src/observe/journal.js';
import { supervisedGenerate } from '../../src/observe/watchdog.js';
import type { LLMProvider, GenerateOptions, StreamHooks } from '../../src/llm/provider.js';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const rec = (over: Partial<CallRecord>): CallRecord => ({
  callId: 'c', stage: 'generate', target: 'Web Experience', attempt: 0,
  provider: 'p', model: 'm', promptBytes: 10, startedAt: 0, bytesStreamed: 0, ...over,
});

describe('W1: output growth is liveness — a streaming call is never killed as stalled', () => {
  it('stays healthy while bytes grow, even with no parsed first token and elapsed > startupMs', () => {
    // Replay the diagnosed trace: ttfbAt never set, bytes climbing, last chunk recent.
    const r = rec({ ttfbAt: undefined, bytesStreamed: 63015, startedAt: 0, lastByteAt: 217_000 });
    // 217s elapsed (≫ 60s startupMs) but the last byte arrived ~1s ago.
    expect(RunJournal.classify(r, DEFAULT_BUDGETS, 218_000)).toBe('healthy');
  });
});

describe('W2: the stall state is not latched', () => {
  it('returns startup-stalled when idle, then healthy on the next byte-growth tick', () => {
    const idle = rec({ ttfbAt: undefined, bytesStreamed: 1134, startedAt: 0, lastByteAt: 0 });
    expect(RunJournal.classify(idle, DEFAULT_BUDGETS, 70_000)).toBe('startup-stalled'); // 70s no growth
    const resumed = { ...idle, bytesStreamed: 58631, lastByteAt: 71_000 };               // bytes grew
    expect(RunJournal.classify(resumed, DEFAULT_BUDGETS, 71_500)).toBe('healthy');
  });
});

describe('W4: genuine no-progress is still caught', () => {
  it('flags startup-stalled when bytes are flat past the startup budget', () => {
    const flat = rec({ ttfbAt: undefined, bytesStreamed: 1134, startedAt: 0, lastByteAt: 0 });
    expect(RunJournal.classify(flat, DEFAULT_BUDGETS, 61_000)).toBe('startup-stalled');
  });
});

/** Streams growing RAW bytes (no parsed text → no onFirstByte) then completes — a single-line SPA. */
class StreamingNoParseProvider implements LLMProvider {
  readonly name = 'snp';
  readonly model = 'test';
  generate(p: string, o?: GenerateOptions): Promise<string> { return this.generateStream(p, o); }
  async generateStream(_p: string, o?: GenerateOptions, hooks?: StreamHooks): Promise<string> {
    hooks?.onChunk?.(1134, '');               // init envelope — bytes, no content delta
    for (let i = 1; i <= 6; i++) {
      await sleep(40);
      if (o?.signal?.aborted) throw new Error('killed by SIGKILL');
      hooks?.onChunk?.(1134 + i * 10000, ''); // growing raw bytes, still no parsed token
    }
    hooks?.onFirstByte?.();                    // parsed text finally arrives at the end
    hooks?.onChunk?.(70000, 'export const x = 1;');
    hooks?.onStopReason?.('end_turn');
    hooks?.onStreamEnd?.();
    return 'export const x = 1;';
  }
}

describe('W3 (integration): a call streaming bytes (no parsed token yet) completes, not killed', () => {
  let phoenixRoot: string;
  beforeEach(() => { phoenixRoot = mkdtempSync(join(tmpdir(), 'phoenix-ww-')); });

  it('is not killed while bytes grow and produces its output', async () => {
    const journal = new RunJournal(phoenixRoot);
    journal.startRun();
    // Tiny startup budget: pre-fix this killed at ~100ms despite the bytes growing.
    const budgets: HealthBudgets = { ...DEFAULT_BUDGETS, startupMs: 100, streamStallMs: 100 };

    const out = await supervisedGenerate(
      journal, new StreamingNoParseProvider(), 'p', undefined,
      { stage: 'generate', target: 'Web Experience', attempt: 0 }, { budgets, pollMs: 20 },
    );

    expect(out).toBe('export const x = 1;');
    const events = RunJournal.readEvents(phoenixRoot, journal.runId);
    expect(events.some(e => e.type === 'watchdog_kill')).toBe(false);
    expect(events.find(e => e.type === 'call_end')?.outcome).toBe('ok');
  });
});
