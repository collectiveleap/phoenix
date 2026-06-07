import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { canonicalize } from '../../src/canonicalizer-llm.js';
import { parseSpec } from '../../src/spec-parser.js';
import { RunJournal } from '../../src/observe/journal.js';
import type { LLMProvider } from '../../src/llm/provider.js';

const SPEC = `# Auth Service

## Requirements

- Users must authenticate with email and password
- Failed login attempts are rate-limited to 5 per minute`;

function mockLLM(response: string): LLMProvider {
  return {
    name: 'mock',
    model: 'mock-1',
    generate: vi.fn().mockResolvedValue(response),
    generateStream: vi.fn().mockResolvedValue(response),
  };
}

describe('Canonicalization honesty (O4 / appendix #8)', () => {
  const clauses = parseSpec(SPEC, 'spec/auth.md');
  let phoenixRoot: string;

  beforeEach(() => {
    phoenixRoot = mkdtempSync(join(tmpdir(), 'phoenix-canon-'));
  });

  it('reports rule-based when no LLM is present (never mislabels)', async () => {
    const { stats } = await canonicalize(clauses, null);
    expect(stats.mode).toBe('rule-based');
    expect(stats.llmAttempted).toBe(false);
    expect(stats.llmNodeCount).toBe(0);
  });

  it('reports rule-based when the LLM produced no usable nodes', async () => {
    // LLM returns an unusably-short response → every node falls back to rule.
    // Mode must stay honest and NOT claim llm-normalized.
    const llm = mockLLM('no');
    const { stats } = await canonicalize(clauses, llm);
    expect(stats.llmAttempted).toBe(true);
    expect(stats.llmNodeCount).toBe(0);
    expect(stats.mode).toBe('rule-based');
  });

  it('reports llm-normalized only when the LLM actually produced nodes', async () => {
    const llm = mockLLM('{"statement": "The system shall authenticate users via email and password"}');
    const { stats } = await canonicalize(clauses, llm);
    expect(stats.mode).toBe('llm-normalized');
    expect(stats.llmNodeCount).toBeGreaterThan(0);
    expect(stats.llmCalls).toBeGreaterThan(0);
  });

  it('records every LLM call and per-clause classification in the journal (O1/O4)', async () => {
    const journal = new RunJournal(phoenixRoot);
    journal.startRun();
    const llm = mockLLM('{"statement": "normalized"}');
    const { stats } = await canonicalize(clauses, llm, { journal });

    const events = RunJournal.readEvents(phoenixRoot, journal.runId);
    // Every classification has a reason recorded.
    const classifications = events.filter(e => e.type === 'classification');
    expect(classifications.length).toBeGreaterThan(0);
    expect(classifications.every(e => typeof e.reason === 'string' && (e.reason as string).length > 0)).toBe(true);
    // Every LLM call appears as a journaled call.
    expect(events.filter(e => e.type === 'call_start')).toHaveLength(stats.llmCalls);
  });
});
