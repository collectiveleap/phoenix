/**
 * G4 — Phoenix-side generation bounds + capture + diagnosability.
 * See change-notes/GENERATION-RELIABILITY-OUTCOMES.md and LARGE-MODULE-GENERATION-DIAGNOSIS.md.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { generateIU, budgetsForModel, OPUS_FIRST_CONTENT_MS, OPUS_MAX_DURATION_MS } from '../../src/regen.js';
import { planIUs } from '../../src/iu-planner.js';
import { parseSpec } from '../../src/spec-parser.js';
import { extractCanonicalNodes } from '../../src/canonicalizer.js';
import { RunJournal, DEFAULT_BUDGETS } from '../../src/observe/journal.js';
import type { CallRecord, HealthBudgets } from '../../src/observe/journal.js';
import { supervisedGenerate } from '../../src/observe/watchdog.js';
import { BoundsExceededError } from '../../src/observe/instrument.js';
import type { LLMProvider, GenerateOptions, StreamHooks } from '../../src/llm/provider.js';

/** Streams forever (~chunk every 10ms) until aborted — simulates a claude-cli runaway. */
class RunawayProvider implements LLMProvider {
  readonly name = 'runaway';
  readonly model = 'test';
  calls = 0;
  constructor(private chunkBytes = 200) {}
  generate(p: string, o?: GenerateOptions): Promise<string> { return this.generateStream(p, o); }
  generateStream(_p: string, o?: GenerateOptions, hooks?: StreamHooks): Promise<string> {
    this.calls++;
    hooks?.onFirstByte?.();
    let total = 0;
    return new Promise<string>((resolve, reject) => {
      const iv = setInterval(() => {
        if (o?.signal?.aborted) { clearInterval(iv); clearTimeout(safety); reject(new Error('killed by SIGKILL')); return; }
        total += this.chunkBytes;
        hooks?.onChunk?.(total, 'x'.repeat(this.chunkBytes));
      }, 10);
      // Safety: never hang the test if the bound somehow doesn't fire.
      const safety = setTimeout(() => { clearInterval(iv); resolve('x'.repeat(total)); }, 8000);
    });
  }
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/**
 * Mimics opus (OP1/OP3): an envelope-only heartbeat (onChunk, no content), then a
 * silent "thinking" gap, then first content + a clean completion. Crucially it
 * fires onFirstByte only with content — exactly the contract OP1 gives claude-cli.
 */
class EnvelopeThenContentProvider implements LLMProvider {
  readonly name = 'opus-like';
  readonly model = 'opus';
  constructor(private thinkMs: number) {}
  generate(p: string, o?: GenerateOptions): Promise<string> { return this.generateStream(p, o); }
  async generateStream(_p: string, o?: GenerateOptions, hooks?: StreamHooks): Promise<string> {
    hooks?.onChunk?.(1114, ''); // init envelope — heartbeat only, NO content
    await sleep(this.thinkMs);  // silent thinking
    if (o?.signal?.aborted) throw new Error('killed by SIGKILL'); // pre-OP1 would kill here
    hooks?.onFirstByte?.();     // first CONTENT
    hooks?.onChunk?.(1200, 'export const x = 1;');
    hooks?.onStopReason?.('end_turn');
    hooks?.onStreamEnd?.();
    return 'export const x = 1;';
  }
}

/** Emits a small complete response immediately. */
class CleanProvider implements LLMProvider {
  readonly name = 'clean';
  readonly model = 'test';
  generate(p: string, o?: GenerateOptions): Promise<string> { return this.generateStream(p, o); }
  async generateStream(_p: string, _o?: GenerateOptions, hooks?: StreamHooks): Promise<string> {
    hooks?.onFirstByte?.();
    hooks?.onChunk?.(20, 'export const x = 1;');
    hooks?.onStopReason?.('end_turn');
    hooks?.onStreamEnd?.();
    return 'export const x = 1;';
  }
}

function makeIU() {
  const clauses = parseSpec('# Auth\n\nUsers must authenticate with email.', 'test.md');
  const canon = extractCanonicalNodes(clauses);
  return { iu: planIUs(canon, clauses)[0], canon };
}

describe('G4: classify() flags an in-flight runaway as exceeded-bounds (before any stall)', () => {
  const base = (over: Partial<CallRecord>): CallRecord => ({
    callId: 'c', stage: 'generate', attempt: 0, provider: 'p', model: 'm',
    promptBytes: 10, startedAt: 1000, ttfbAt: 1000, lastByteAt: 9_000, bytesStreamed: 0, ...over,
  });

  it('trips on the byte budget while still actively streaming', () => {
    const rec = base({ bytesStreamed: 300_000 }); // > default 262_144, last byte recent (not stalled)
    expect(RunJournal.classify(rec, DEFAULT_BUDGETS, 9_000)).toBe('exceeded-bounds');
  });

  it('trips on the wall-clock budget', () => {
    const rec = base({ bytesStreamed: 100, lastByteAt: 9_000 });
    // 9_000_000 - 1000 startedAt = way over the 300_000ms budget
    expect(RunJournal.classify(rec, DEFAULT_BUDGETS, 9_000_000)).toBe('exceeded-bounds');
  });

  it('does not trip when under both budgets', () => {
    const rec = base({ bytesStreamed: 1000, lastByteAt: 9_000 });
    expect(RunJournal.classify(rec, DEFAULT_BUDGETS, 9_500)).toBe('healthy');
  });
});

describe('G4: the watchdog bounds a runaway as over_budget, not a stall', () => {
  let phoenixRoot: string;
  const budgets: HealthBudgets = { ...DEFAULT_BUDGETS, maxBytes: 1000 };
  beforeEach(() => { phoenixRoot = mkdtempSync(join(tmpdir(), 'phoenix-g4-')); });

  it('aborts with a BoundsExceededError and records generation_bounds_exceeded', async () => {
    const journal = new RunJournal(phoenixRoot);
    journal.startRun();
    const provider = new RunawayProvider(200);

    await expect(
      supervisedGenerate(journal, provider, 'p', undefined, { stage: 'generate', target: 'Big', attempt: 0 }, { budgets, pollMs: 20 }),
    ).rejects.toBeInstanceOf(BoundsExceededError);

    const events = RunJournal.readEvents(phoenixRoot, journal.runId);
    expect(events.some(e => e.type === 'generation_bounds_exceeded')).toBe(true);
    expect(events.some(e => e.type === 'watchdog_kill')).toBe(false);
    const end = events.find(e => e.type === 'call_end');
    expect(end?.outcome).toBe('over_budget');
  });

  it('journals the full call lifecycle (first_byte/progress/end) for a normal call (closes the §B gap)', async () => {
    const journal = new RunJournal(phoenixRoot);
    journal.startRun();
    await supervisedGenerate(journal, new CleanProvider(), 'p', undefined, { stage: 'generate', target: 'Small', attempt: 0 }, { budgets, pollMs: 20 });

    const events = RunJournal.readEvents(phoenixRoot, journal.runId);
    expect(events.some(e => e.type === 'call_first_byte')).toBe(true);
    expect(events.some(e => e.type === 'call_progress')).toBe(true);
    const end = events.find(e => e.type === 'call_end');
    expect(end?.outcome).toBe('ok');
  });
});

describe('G1: a journaled single-module regen exposes the diagnostic readout fields', () => {
  let phoenixRoot: string;
  beforeEach(() => { phoenixRoot = mkdtempSync(join(tmpdir(), 'phoenix-g1-')); });

  it('records bytes, duration, stop reason, and model for the module call', async () => {
    const { iu, canon } = makeIU();
    const journal = new RunJournal(phoenixRoot);
    journal.startRun();
    await generateIU(iu, { llm: new CleanProvider(), canonNodes: canon, journal });

    // This is exactly what `phoenix regen --iu=<id>` reads to print its readout.
    const call = journal.callList().find(c => c.target === iu.name)!;
    expect(call).toBeDefined();
    expect(call.bytesStreamed).toBeGreaterThan(0);
    expect(call.ttfbAt).toBeDefined();              // duration computable (ended - started)
    expect(call.endedAt).toBeDefined();
    expect(call.stopReason).toBe('end_turn');
    expect(call.model).toBe('test');
    expect(call.outcome).toBe('ok');
  });
});

describe('G4: regen hard-fails a bounds runaway (no stub, no retry) and captures the partial output', () => {
  let phoenixRoot: string;
  beforeEach(() => { phoenixRoot = mkdtempSync(join(tmpdir(), 'phoenix-g4-')); });

  it('returns a failed result with a captured partial-output path, one attempt only', async () => {
    const { iu, canon } = makeIU();
    const journal = new RunJournal(phoenixRoot);
    journal.startRun();
    const provider = new RunawayProvider(2000); // trips maxBytes fast

    const result = await generateIU(iu, {
      llm: provider, canonNodes: canon, journal,
      budgets: { ...DEFAULT_BUDGETS, maxBytes: 1000 },
      maxRetries: 3,
    });

    expect(result.failed).toBeDefined();
    expect(result.failed?.reason).toBe('over_generation_bounds');
    expect(result.files.size).toBe(0);
    expect(provider.calls).toBe(1); // deterministic — not retried

    // Partial output captured and inspectable.
    expect(result.failed?.partialPath).toBeTruthy();
    expect(existsSync(result.failed!.partialPath!)).toBe(true);
    expect(readFileSync(result.failed!.partialPath!, 'utf8').length).toBeGreaterThan(0);

    const events = RunJournal.readEvents(phoenixRoot, journal.runId);
    expect(events.some(e => e.type === 'generate_retry')).toBe(false);
    expect(events.find(e => e.type === 'module_failed')?.reason).toBe('over_generation_bounds');
  }, 15000);
});

describe('OP2: the first-content/duration budget is sized to the model', () => {
  const base = { ...DEFAULT_BUDGETS, startupMs: 60_000, maxDurationMs: 300_000 };

  it('raises startupMs and maxDurationMs for an opus model', () => {
    const b = budgetsForModel(base, 'opus');
    expect(b.startupMs).toBe(OPUS_FIRST_CONTENT_MS);
    expect(b.maxDurationMs).toBe(OPUS_MAX_DURATION_MS);
    // matches full ids too
    expect(budgetsForModel(base, 'claude-opus-4-8').startupMs).toBe(OPUS_FIRST_CONTENT_MS);
  });

  it('leaves non-opus models unchanged', () => {
    expect(budgetsForModel(base, 'sonnet')).toEqual(base);
    expect(budgetsForModel(base, undefined)).toEqual(base);
  });

  it('never shrinks an already-larger configured budget', () => {
    const big = { ...base, startupMs: OPUS_FIRST_CONTENT_MS + 100_000 };
    expect(budgetsForModel(big, 'opus').startupMs).toBe(OPUS_FIRST_CONTENT_MS + 100_000);
  });
});

describe('OP1+OP3: a model that thinks before emitting is not killed during the silent phase', () => {
  let phoenixRoot: string;
  beforeEach(() => { phoenixRoot = mkdtempSync(join(tmpdir(), 'phoenix-op-')); });

  it('survives an envelope-then-silence longer than streamStallMs, then completes', async () => {
    const journal = new RunJournal(phoenixRoot);
    journal.startRun();
    // think 500ms: longer than the 200ms stream-stall budget, but shorter than the
    // 2000ms first-content (startup) budget. Pre-OP1 the envelope would have set
    // ttfb → stream-stall kill at ~200ms. With OP1 the call stays in startup.
    const provider = new EnvelopeThenContentProvider(500);
    const budgets = { ...DEFAULT_BUDGETS, startupMs: 2000, streamStallMs: 200 };

    const out = await supervisedGenerate(
      journal, provider, 'p', undefined,
      { stage: 'generate', target: 'Think', attempt: 0 },
      { budgets, pollMs: 20 },
    );

    expect(out).toBe('export const x = 1;');
    const events = RunJournal.readEvents(phoenixRoot, journal.runId);
    expect(events.some(e => e.type === 'watchdog_kill')).toBe(false);
    expect(events.some(e => e.type === 'generation_bounds_exceeded')).toBe(false);
    expect(events.find(e => e.type === 'call_end')?.outcome).toBe('ok');
  });
});
