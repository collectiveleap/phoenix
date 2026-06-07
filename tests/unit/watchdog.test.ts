import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RunJournal } from '../../src/observe/journal.js';
import { supervisedGenerate } from '../../src/observe/watchdog.js';
import type { LLMProvider, GenerateOptions, StreamHooks } from '../../src/llm/provider.js';

/** A provider whose timing is fully scriptable, honouring AbortSignal. */
class ScriptedProvider implements LLMProvider {
  readonly name = 'scripted';
  readonly model = 'test';
  constructor(private script: { ttfbMs: number; chunks: { delayMs: number; text: string }[]; tailMs: number }) {}

  generate(prompt: string, options?: GenerateOptions): Promise<string> {
    return this.generateStream(prompt, options);
  }

  generateStream(_prompt: string, options?: GenerateOptions, hooks?: StreamHooks): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const timers: NodeJS.Timeout[] = [];
      let aborted = false;
      let out = '';
      let bytes = 0;

      const onAbort = () => {
        if (aborted) return;
        aborted = true;
        timers.forEach(clearTimeout);
        reject(new Error('killed by SIGKILL (aborted)'));
      };
      if (options?.signal) {
        if (options.signal.aborted) return onAbort();
        options.signal.addEventListener('abort', onAbort, { once: true });
      }

      let t = this.script.ttfbMs;
      timers.push(setTimeout(() => { if (!aborted) hooks?.onFirstByte?.(); }, this.script.ttfbMs));
      for (const c of this.script.chunks) {
        t += c.delayMs;
        const at = t;
        timers.push(setTimeout(() => {
          if (aborted) return;
          out += c.text;
          bytes += Buffer.byteLength(c.text, 'utf8');
          hooks?.onChunk?.(bytes, c.text);
        }, at));
      }
      timers.push(setTimeout(() => {
        if (aborted) return;
        hooks?.onStreamEnd?.();
        resolve(out || 'ok');
      }, t + this.script.tailMs));
    });
  }
}

describe('Watchdog (O2/O8: stalls detected and killed without a human)', () => {
  let phoenixRoot: string;
  const ctx = { stage: 'generate', target: 'ModA', attempt: 0 };

  beforeEach(() => {
    phoenixRoot = mkdtempSync(join(tmpdir(), 'phoenix-watchdog-'));
  });

  it('lets a healthy call complete and records ok', async () => {
    const j = new RunJournal(phoenixRoot);
    j.startRun();
    const provider = new ScriptedProvider({ ttfbMs: 10, chunks: [{ delayMs: 10, text: 'abc' }], tailMs: 10 });
    const text = await supervisedGenerate(j, provider, 'p', undefined, ctx, {
      budgets: { startupMs: 500, streamStallMs: 500, wedgeMs: 500 },
      pollMs: 10,
    });
    expect(text).toBe('abc');
    const rec = j.callList()[0];
    expect(rec.outcome).toBe('ok');
  });

  it('kills a startup-stalled call (no first byte) — appendix #4 startup half', async () => {
    const j = new RunJournal(phoenixRoot);
    j.startRun();
    // First byte never arrives within budget.
    const provider = new ScriptedProvider({ ttfbMs: 10_000, chunks: [], tailMs: 0 });
    await expect(
      supervisedGenerate(j, provider, 'p', undefined, ctx, {
        budgets: { startupMs: 40, streamStallMs: 10_000, wedgeMs: 10_000 },
        pollMs: 10,
      }),
    ).rejects.toThrow(/Watchdog killed/);

    const rec = j.callList()[0];
    expect(rec.outcome).toBe('timeout');
    const kill = RunJournal.readEvents(phoenixRoot, j.runId).find(e => e.type === 'watchdog_kill');
    expect(kill?.health).toBe('startup-stalled');
  });

  it('kills a stream-stalled call (first byte then silence) — appendix #4 stream half', async () => {
    const j = new RunJournal(phoenixRoot);
    j.startRun();
    // First byte quick, one chunk, then a long gap before the next/end.
    const provider = new ScriptedProvider({ ttfbMs: 10, chunks: [{ delayMs: 10, text: 'x' }], tailMs: 10_000 });
    await expect(
      supervisedGenerate(j, provider, 'p', undefined, ctx, {
        budgets: { startupMs: 10_000, streamStallMs: 50, wedgeMs: 10_000 },
        pollMs: 10,
      }),
    ).rejects.toThrow(/Watchdog killed/);

    const kill = RunJournal.readEvents(phoenixRoot, j.runId).find(e => e.type === 'watchdog_kill');
    expect(kill?.health).toBe('stream-stalled');
  });
});
