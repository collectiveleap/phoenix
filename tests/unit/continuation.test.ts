/**
 * #24 — a large module that exceeds one bounded call is assembled by continuing
 * across calls and stitching the raw chunks. A non-converging generation still
 * hard-fails at the cap (preserving #8's runaway guard), and the behavior is
 * togglable for A/B comparison.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { generateIU, stripOverlap } from '../../src/regen.js';
import { planIUs } from '../../src/iu-planner.js';
import { parseSpec } from '../../src/spec-parser.js';
import { extractCanonicalNodes } from '../../src/canonicalizer.js';
import { RunJournal } from '../../src/observe/journal.js';
import type { LLMProvider, GenerateOptions, StreamHooks } from '../../src/llm/provider.js';

/** Emits a scripted sequence of chunks; a `truncated` chunk reports `max_tokens`. */
class ChunkProvider implements LLMProvider {
  readonly name = 'chunk';
  readonly model = 'test';
  calls = 0;
  constructor(private chunks: Array<{ text: string; truncated: boolean }>) {}
  generate(p: string, o?: GenerateOptions): Promise<string> { return this.generateStream(p, o); }
  async generateStream(_p: string, _o?: GenerateOptions, hooks?: StreamHooks): Promise<string> {
    const c = this.chunks[Math.min(this.calls, this.chunks.length - 1)];
    this.calls++;
    hooks?.onFirstByte?.();
    hooks?.onChunk?.(c.text.length, c.text);
    hooks?.onStopReason?.(c.truncated ? 'max_tokens' : 'end_turn');
    hooks?.onStreamEnd?.();
    return c.text;
  }
}

function makeIU() {
  const clauses = parseSpec('# Auth\n\nUsers must authenticate with email.', 'test.md');
  const canon = extractCanonicalNodes(clauses);
  return { iu: planIUs(canon, clauses)[0], canon };
}

const ENV = ['PHOENIX_GENERATE_CONTINUATIONS', 'PHOENIX_GENERATE_MAX_CONTINUATIONS'] as const;
const saved: Record<string, string | undefined> = {};
afterEach(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    delete saved[k];
  }
});
function setEnv(k: typeof ENV[number], v: string) { saved[k] = process.env[k]; process.env[k] = v; }

describe('#24: continuation across calls assembles a large module', () => {
  it('stitches truncated chunks until a call completes within bounds', async () => {
    const { iu, canon } = makeIU();
    const provider = new ChunkProvider([
      { text: 'MARKER_ONE ', truncated: true },
      { text: 'MARKER_TWO ', truncated: true },
      { text: 'MARKER_THREE', truncated: false },
    ]);
    const result = await generateIU(iu, { llm: provider, canonNodes: canon });

    const code = result.files.get(iu.output_files[0])!;
    expect(code).toContain('MARKER_ONE');
    expect(code).toContain('MARKER_TWO');
    expect(code).toContain('MARKER_THREE');
    expect(code).toContain('MARKER_ONE MARKER_TWO MARKER_THREE'); // concatenated, no gap/dup
    expect(provider.calls).toBe(3); // 1 initial + 2 continuations
    expect(result.failed).toBeUndefined();
  });

  it('a non-converging generation hard-fails at the cap (no stub)', async () => {
    setEnv('PHOENIX_GENERATE_MAX_CONTINUATIONS', '2');
    const { iu, canon } = makeIU();
    const provider = new ChunkProvider([{ text: 'never-ends ', truncated: true }]); // always truncates
    const result = await generateIU(iu, { llm: provider, canonNodes: canon });

    expect(result.files.size).toBe(0);
    expect(result.failed?.reason).toBe('over_output_budget');
    expect(provider.calls).toBe(3); // 1 initial + 2 continuations, then hard-fail
  });

  it('toggle off (PHOENIX_GENERATE_CONTINUATIONS=0) hard-fails on the first bound', async () => {
    setEnv('PHOENIX_GENERATE_CONTINUATIONS', '0');
    const { iu, canon } = makeIU();
    const provider = new ChunkProvider([{ text: 'partial ', truncated: true }]);
    const result = await generateIU(iu, { llm: provider, canonNodes: canon });

    expect(result.failed?.reason).toBe('over_output_budget');
    expect(provider.calls).toBe(1); // no continuation attempted
  });
});

describe('#24: continuation is measurable from the journal', () => {
  it('emits generation_continuation per round and a converged generation_assembled', async () => {
    const root = mkdtempSync(join(tmpdir(), 'phoenix-cont-'));
    const journal = new RunJournal(root);
    journal.startRun();
    const { iu, canon } = makeIU();
    const provider = new ChunkProvider([
      { text: 'A ', truncated: true },
      { text: 'B', truncated: false },
    ]);
    await generateIU(iu, { llm: provider, canonNodes: canon, journal });

    const events = RunJournal.readEvents(root, journal.runId);
    expect(events.filter(e => e.type === 'generation_continuation')).toHaveLength(1);
    const assembled = events.find(e => e.type === 'generation_assembled');
    expect(assembled?.converged).toBe(true);
    expect(assembled?.continuations).toBe(1);
  });
});

describe('#24: stripOverlap removes a duplicated seam', () => {
  it('drops the longest suffix of accumulated that prefixes the chunk', () => {
    expect(stripOverlap('hello world', 'world peace')).toBe(' peace');
    expect(stripOverlap('abc', 'abcdef')).toBe('def');     // full re-emit of the tail
    expect(stripOverlap('foo', 'bar')).toBe('bar');         // no overlap → unchanged
    expect(stripOverlap('', 'anything')).toBe('anything');  // nothing to overlap
  });
});
