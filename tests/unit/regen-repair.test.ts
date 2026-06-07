import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { generateIU } from '../../src/regen.js';
import { planIUs } from '../../src/iu-planner.js';
import { parseSpec } from '../../src/spec-parser.js';
import { extractCanonicalNodes } from '../../src/canonicalizer.js';
import { RunJournal } from '../../src/observe/journal.js';
import type { LLMProvider, GenerateOptions, StreamHooks } from '../../src/llm/provider.js';

/** Counts how many generations it served. */
class CountingProvider implements LLMProvider {
  readonly name = 'counting';
  readonly model = 'test';
  calls = 0;
  constructor(private response: string) {}
  generate(prompt: string, options?: GenerateOptions): Promise<string> {
    return this.generateStream(prompt, options);
  }
  async generateStream(_p: string, _o?: GenerateOptions, hooks?: StreamHooks): Promise<string> {
    this.calls++;
    hooks?.onFirstByte?.();
    hooks?.onChunk?.(this.response.length, this.response);
    hooks?.onStreamEnd?.();
    return this.response;
  }
}

describe('Repair loop (O3 / appendix #1: no phantom repair on a missing tool)', () => {
  let projectRoot: string;
  let phoenixRoot: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'phoenix-regen-proj-'));
    phoenixRoot = mkdtempSync(join(tmpdir(), 'phoenix-regen-phx-'));
  });

  function makeIU() {
    const clauses = parseSpec('# Auth\n\nUsers must authenticate with email.', 'test.md');
    const canon = extractCanonicalNodes(clauses);
    return { iu: planIUs(canon, clauses)[0], canon };
  }

  it('fires exactly one LLM call (no repairs) when the typechecker is unavailable', async () => {
    const { iu, canon } = makeIU();
    const provider = new CountingProvider('export const x = 1;\n');
    const journal = new RunJournal(phoenixRoot);
    journal.startRun();

    // Empty projectRoot has no node_modules/.bin/tsc; this sandbox has no npx.
    await generateIU(iu, {
      llm: provider,
      canonNodes: canon,
      projectRoot,
      journal,
    });

    // Initial generation only — zero repair calls.
    expect(provider.calls).toBe(1);

    // And the journal names it a tool-availability failure, not type errors.
    const events = RunJournal.readEvents(phoenixRoot, journal.runId);
    const tc = events.find(e => e.type === 'typecheck');
    expect(tc?.status).toBe('unavailable');
    expect(events.some(e => e.type === 'repair_capped')).toBe(false);

    // The single generation was journaled as a call (O1).
    expect(events.filter(e => e.type === 'call_start')).toHaveLength(1);
  });
});
