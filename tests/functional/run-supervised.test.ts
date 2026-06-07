import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runSupervised } from '../../src/harness/run.js';
import { parseSpec } from '../../src/spec-parser.js';
import { acquireRunLock, AlreadyRunningError } from '../../src/harness/lock.js';
import { DEFAULT_POLICY } from '../../src/harness/policy.js';
import { RunJournal } from '../../src/observe/journal.js';
import type { LLMProvider, GenerateOptions, StreamHooks } from '../../src/llm/provider.js';

class FakeProvider implements LLMProvider {
  readonly name = 'fake';
  readonly model = 'test';
  calls = 0;
  generate(p: string, o?: GenerateOptions) { return this.generateStream(p, o); }
  async generateStream(_p: string, _o?: GenerateOptions, hooks?: StreamHooks): Promise<string> {
    this.calls++;
    const code = 'export function handler() { return { ok: true }; }\n';
    hooks?.onFirstByte?.();
    hooks?.onChunk?.(code.length, code);
    hooks?.onStreamEnd?.();
    return code;
  }
}

const SPEC = `# Todo\n\n## Tasks\n\n- The system must let users create a task.\n- The system must let users list tasks.\n\n## Health\n\n- The service must expose a health endpoint.`;

describe('Supervised run (O15/O16: unattended pipeline under the harness)', () => {
  let projectRoot: string;
  let phoenixDir: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'phoenix-run-proj-'));
    phoenixDir = mkdtempSync(join(tmpdir(), 'phoenix-run-phx-'));
  });

  function opts(provider: LLMProvider, resume = true) {
    return {
      projectRoot, phoenixDir,
      clauses: parseSpec(SPEC, 'spec/app.md'),
      arch: null,
      llm: provider,
      policy: { ...DEFAULT_POLICY, budgets: { startupMs: 5_000, streamStallMs: 5_000, wedgeMs: 5_000 } },
      resume,
      forceScaffold: false,
      runtimeChecks: false,
      install: false,
      log: () => {},
    };
  }

  it('runs the full pipeline and records every stage + LLM call in the journal', async () => {
    const provider = new FakeProvider();
    const result = await runSupervised(opts(provider));

    const snap = RunJournal.readState(phoenixDir, result.runId)!;
    const stageNames = snap.stages.map(s => s.name);
    expect(stageNames).toEqual(expect.arrayContaining(['canonicalize', 'plan', 'generate', 'scaffold', 'acceptance']));
    // Every LLM call is journaled (O1).
    expect(snap.calls.length).toBeGreaterThan(0);
    expect(snap.calls.every(c => c.outcome === 'ok')).toBe(true);
    // The run finalized (not left in-progress).
    expect(snap.endedAt).toBeDefined();
  });

  it('skips completed modules on a resumed run (O13/O16)', async () => {
    const first = new FakeProvider();
    await runSupervised(opts(first));
    const firstCalls = first.calls;
    expect(firstCalls).toBeGreaterThan(0);

    // Second run with resume → completed modules are not regenerated.
    const second = new FakeProvider();
    const result = await runSupervised(opts(second));

    const events = RunJournal.readEvents(phoenixDir, result.runId);
    // No generation-stage LLM calls happened on the resumed run.
    const genCalls = events.filter(e => e.type === 'call_start' && e.stage === 'generate');
    expect(genCalls).toHaveLength(0);
    const genEnd = events.find(e => e.type === 'stage_end' && e.stage === 'generate')!;
    expect(Number(genEnd.skipped ?? 0)).toBeGreaterThan(0);
  });

  it('refuses to start when another run holds the lock (O11)', async () => {
    const held = acquireRunLock(phoenixDir);
    // Simulate a live foreign owner.
    const { writeFileSync } = await import('node:fs');
    writeFileSync(held.path, String(process.ppid || process.pid));
    await expect(runSupervised(opts(new FakeProvider()))).rejects.toBeInstanceOf(AlreadyRunningError);
    held.release();
  });
});
