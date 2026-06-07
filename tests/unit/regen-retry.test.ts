import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { generateIU } from '../../src/regen.js';
import { planIUs } from '../../src/iu-planner.js';
import { parseSpec } from '../../src/spec-parser.js';
import { extractCanonicalNodes } from '../../src/canonicalizer.js';
import { RunJournal } from '../../src/observe/journal.js';
import { DEFAULT_POLICY } from '../../src/harness/policy.js';
import type { LLMProvider, GenerateOptions, StreamHooks } from '../../src/llm/provider.js';

/** Fails its first `failures` calls (simulating the startup hang), then succeeds. */
class FlakyProvider implements LLMProvider {
  readonly name = 'flaky';
  readonly model = 'test';
  calls = 0;
  constructor(private failures: number, private response: string) {}
  generate(p: string, o?: GenerateOptions): Promise<string> { return this.generateStream(p, o); }
  async generateStream(_p: string, _o?: GenerateOptions, hooks?: StreamHooks): Promise<string> {
    this.calls++;
    if (this.calls <= this.failures) throw new Error('startup hang: no first byte');
    hooks?.onFirstByte?.();
    hooks?.onChunk?.(this.response.length, this.response);
    hooks?.onStreamEnd?.();
    return this.response;
  }
}

describe('Generation retry (B6: ride out the intermittent startup hang)', () => {
  let projectRoot: string;
  let phoenixRoot: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'phoenix-retry-proj-'));
    phoenixRoot = mkdtempSync(join(tmpdir(), 'phoenix-retry-phx-'));
  });

  function makeIU() {
    const clauses = parseSpec('# Auth\n\nUsers must authenticate with email.', 'test.md');
    const canon = extractCanonicalNodes(clauses);
    return { iu: planIUs(canon, clauses)[0], canon };
  }

  it('retries a failed generation up to maxRetries and returns real code (not a stub)', async () => {
    const { iu, canon } = makeIU();
    const provider = new FlakyProvider(2, 'export const x = 1;\n');
    const journal = new RunJournal(phoenixRoot);
    journal.startRun();

    const result = await generateIU(iu, {
      llm: provider,
      canonNodes: canon,
      projectRoot,
      journal,
      maxRetries: 3,
      backoffMs: 0,
    });

    // 2 failures + 1 success = 3 generation calls; the real response survived.
    expect(provider.calls).toBe(3);
    const content = [...result.files.values()][0];
    expect(content).toContain('export const x = 1');

    const events = RunJournal.readEvents(phoenixRoot, journal.runId);
    expect(events.filter(e => e.type === 'generate_retry')).toHaveLength(2);
  });

  it('falls back to a stub only after exhausting maxRetries', async () => {
    const { iu, canon } = makeIU();
    const provider = new FlakyProvider(99, 'never returned');
    const result = await generateIU(iu, {
      llm: provider,
      canonNodes: canon,
      projectRoot,
      maxRetries: 2,
      backoffMs: 0,
    });

    // 1 initial + 2 retries = 3 attempts, all fail → stub fallback.
    expect(provider.calls).toBe(3);
    expect([...result.files.values()][0]).not.toContain('never returned');
  });

  it('defaults maxRetries high enough to ride the startup hang (B6)', () => {
    expect(DEFAULT_POLICY.maxRetries).toBeGreaterThanOrEqual(3);
  });
});
