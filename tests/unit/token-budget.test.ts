/**
 * Output-token budget for large modules — evidence for T1–T5.
 * See https://github.com/collectiveleap/phoenix/issues/21.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { generateIU, GENERATE_MAX_TOKENS } from '../../src/regen.js';
import { planIUs, analyzePlan } from '../../src/iu-planner.js';
import { parseSpec } from '../../src/spec-parser.js';
import { extractCanonicalNodes } from '../../src/canonicalizer.js';
import { RunJournal } from '../../src/observe/journal.js';
import type { CallRecord } from '../../src/observe/journal.js';
import type { LLMProvider, GenerateOptions, StreamHooks } from '../../src/llm/provider.js';

/** Records the GenerateOptions it last received; returns fixed code. */
class RecordingProvider implements LLMProvider {
  readonly name = 'rec';
  readonly model = 'test';
  lastOpts?: GenerateOptions;
  constructor(private response = 'export const x = 1;\n') {}
  generate(p: string, o?: GenerateOptions): Promise<string> { return this.generateStream(p, o); }
  async generateStream(_p: string, o?: GenerateOptions, hooks?: StreamHooks): Promise<string> {
    this.lastOpts = o;
    hooks?.onFirstByte?.();
    hooks?.onChunk?.(this.response.length, this.response);
    hooks?.onStopReason?.('end_turn');
    hooks?.onStreamEnd?.();
    return this.response;
  }
}

/** Always streams a partial body and reports a max_tokens truncation. */
class TruncatingProvider implements LLMProvider {
  readonly name = 'trunc';
  readonly model = 'test';
  calls = 0;
  generate(p: string, o?: GenerateOptions): Promise<string> { return this.generateStream(p, o); }
  async generateStream(_p: string, _o?: GenerateOptions, hooks?: StreamHooks): Promise<string> {
    this.calls++;
    hooks?.onFirstByte?.();
    hooks?.onChunk?.(100, 'export const partial = ');
    hooks?.onStopReason?.('max_tokens');
    hooks?.onStreamEnd?.();
    return 'export const partial = ';
  }
}

function makeIU(spec = '# Auth\n\nUsers must authenticate with email.', file = 'test.md') {
  const clauses = parseSpec(spec, file);
  const canon = extractCanonicalNodes(clauses);
  return { iu: planIUs(canon, clauses)[0], canon, clauses };
}

describe('T1: the output token budget fits the module being generated', () => {
  it('passes the raised budget (not 8192) to the provider', async () => {
    const { iu, canon } = makeIU();
    const provider = new RecordingProvider();
    await generateIU(iu, { llm: provider, canonNodes: canon });

    expect(provider.lastOpts?.maxTokens).toBe(GENERATE_MAX_TOKENS);
    expect(GENERATE_MAX_TOKENS).toBeGreaterThan(8192);
    expect(provider.lastOpts?.maxTokens).not.toBe(8192);
  });

  it('honours a per-call ctx.maxTokens override', async () => {
    const { iu, canon } = makeIU();
    const provider = new RecordingProvider();
    await generateIU(iu, { llm: provider, canonNodes: canon, maxTokens: 50000 });
    expect(provider.lastOpts?.maxTokens).toBe(50000);
  });
});

describe('T2: a max_tokens truncation is recognized as truncation, not a stall', () => {
  let phoenixRoot: string;
  beforeEach(() => { phoenixRoot = mkdtempSync(join(tmpdir(), 'phoenix-tb-')); });

  it('records the call outcome as truncated with stop_reason (never a kill)', async () => {
    const { iu, canon } = makeIU();
    const journal = new RunJournal(phoenixRoot);
    journal.startRun();
    await generateIU(iu, { llm: new TruncatingProvider(), canonNodes: canon, journal });

    const events = RunJournal.readEvents(phoenixRoot, journal.runId);
    const end = events.find(e => e.type === 'call_end' && e.outcome === 'truncated');
    expect(end).toBeDefined();
    expect(end?.stopReason).toBe('max_tokens');
    expect(events.some(e => e.type === 'watchdog_kill')).toBe(false);
  });

  it('classify() treats a truncated call as terminal completed, not stalled', () => {
    const rec: CallRecord = {
      callId: 'c1', stage: 'generate', attempt: 0, provider: 'p', model: 'm',
      promptBytes: 10, startedAt: 0, endedAt: 100, bytesStreamed: 32356,
      outcome: 'truncated', stopReason: 'max_tokens',
    };
    // Even far in the future (would be a stall if in-flight) it is terminal.
    expect(RunJournal.classify(rec, undefined, 10_000_000)).toBe('completed');
  });
});

describe('T3: a truncation is not retried; it is reported with the fix', () => {
  let phoenixRoot: string;
  beforeEach(() => { phoenixRoot = mkdtempSync(join(tmpdir(), 'phoenix-tb-')); });
  // With continuation off (#24), a truncation is the deterministic ceiling tested here;
  // continuation behavior is covered in continuation.test.ts.
  afterEach(() => { delete process.env.PHOENIX_GENERATE_CONTINUATIONS; });

  it('makes exactly one attempt, no stub, and reports the remediation', async () => {
    process.env.PHOENIX_GENERATE_CONTINUATIONS = '0';
    const { iu, canon } = makeIU();
    const provider = new TruncatingProvider();
    const journal = new RunJournal(phoenixRoot);
    journal.startRun();

    const result = await generateIU(iu, {
      llm: provider, canonNodes: canon, journal,
      maxRetries: 3, maxRepairs: 2,
    });

    // One attempt — the deterministic ceiling is not retried.
    expect(provider.calls).toBe(1);
    // Hard-failed: no stub substituted, no files written.
    expect(result.failed).toBeDefined();
    expect(result.files.size).toBe(0);
    // The message names the cause and the fix.
    expect(result.failed?.remediation).toMatch(/exceeded the \d+-token budget/);
    expect(result.failed?.remediation).toMatch(/PHOENIX_GENERATE_MAX_TOKENS|split/);

    const events = RunJournal.readEvents(phoenixRoot, journal.runId);
    expect(events.some(e => e.type === 'generate_retry')).toBe(false);
    const failed = events.find(e => e.type === 'module_failed');
    expect(failed?.reason).toBe('over_output_budget');
  });
});

describe('T4: the plan/risk gate flags an over-budget module before generation', () => {
  it('flags a web-UI SPA section as likely to exceed the output token budget', () => {
    const spec = [
      '# Todo App',
      '',
      '## Web Experience',
      '',
      'The page must render the todo list in the browser.',
      'The page must support editing a todo inline.',
      'The page must support deleting a todo.',
      'The page must style the layout with CSS.',
    ].join('\n');
    const { clauses } = makeIU(spec, 'todo.md');
    const canon = extractCanonicalNodes(clauses);
    const ius = planIUs(canon, clauses);

    // Use a small budget so a modest web-UI module trips the flag.
    const report = analyzePlan(ius, canon, clauses, { outputBudget: 1000 });

    const web = report.modules.find(m => m.role === 'web-ui');
    expect(web).toBeDefined();
    expect(web?.overBudget).toBe(true);
    expect(web?.estimate.outputTokens).toBeGreaterThan(1000);

    const warning = report.warnings.find(w => w.kind === 'over-output-budget');
    expect(warning).toBeDefined();
    expect(warning?.remediation).toMatch(/PHOENIX_GENERATE_MAX_TOKENS|split/);
  });

  it('does not flag a small API module under the budget', () => {
    const { iu, canon, clauses } = makeIU();
    const report = analyzePlan([iu], canon, clauses);
    expect(report.warnings.some(w => w.kind === 'over-output-budget')).toBe(false);
  });
});

describe('T5: a large web-UI module generates to completion', () => {
  let phoenixRoot: string;
  beforeEach(() => { phoenixRoot = mkdtempSync(join(tmpdir(), 'phoenix-tb-')); });

  it('writes the full module (>32 KB, non-stub) and records a normal completion', async () => {
    const { iu, canon } = makeIU();
    // A module larger than the old ~32 KB ceiling.
    const big = 'export const data = [\n' +
      Array.from({ length: 2000 }, (_, i) => `  { id: ${i}, name: 'item ${i}' },`).join('\n') +
      '\n];\n';
    expect(Buffer.byteLength(big, 'utf8')).toBeGreaterThan(32_768);

    const provider = new RecordingProvider(big);
    const journal = new RunJournal(phoenixRoot);
    journal.startRun();

    const result = await generateIU(iu, { llm: provider, canonNodes: canon, journal });

    expect(result.failed).toBeUndefined();
    const content = [...result.files.values()][0];
    expect(Buffer.byteLength(content, 'utf8')).toBeGreaterThan(32_768);
    expect(content).toContain("name: 'item 1999'"); // not truncated, not a stub

    const events = RunJournal.readEvents(phoenixRoot, journal.runId);
    const end = events.find(e => e.type === 'call_end');
    expect(end?.outcome).toBe('ok');
    expect(end?.stopReason).toBe('end_turn');
  });
});
