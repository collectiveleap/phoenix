/**
 * Regression suite for the reference failures in change-notes/OBSERVABILITY-HARNESS-OUTCOMES.md
 * (Appendix #1–#10). Each test reproduces a failure mode from the stress-test
 * session and asserts the harness now prevents or auto-recovers from it (O16),
 * leaving a journal entry where applicable.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';

import { RunJournal } from '../../src/observe/journal.js';
import { supervisedGenerate, KeepAwake } from '../../src/observe/watchdog.js';
import { generateIU } from '../../src/regen.js';
import { canonicalize } from '../../src/canonicalizer-llm.js';
import { planIUs, analyzePlan } from '../../src/iu-planner.js';
import { parseSpec } from '../../src/spec-parser.js';
import { extractCanonicalNodes } from '../../src/canonicalizer.js';
import { writeScaffoldFiles } from '../../src/harness/scaffold-writer.js';
import { runAcceptance } from '../../src/harness/acceptance.js';
import { acquireRunLock, AlreadyRunningError } from '../../src/harness/lock.js';
import { computeResumePlan } from '../../src/harness/resume.js';
import { ManifestManager } from '../../src/manifest.js';
import { sha256 } from '../../src/semhash.js';
import type { LLMProvider, GenerateOptions, StreamHooks } from '../../src/llm/provider.js';

// ── Test providers ──────────────────────────────────────────────────────────

class CountingProvider implements LLMProvider {
  readonly name = 'counting';
  readonly model = 'test';
  calls = 0;
  constructor(private response = 'export const x = 1;\n') {}
  generate(p: string, o?: GenerateOptions) { return this.generateStream(p, o); }
  async generateStream(_p: string, _o?: GenerateOptions, hooks?: StreamHooks): Promise<string> {
    this.calls++;
    hooks?.onFirstByte?.();
    hooks?.onChunk?.(this.response.length, this.response);
    hooks?.onStreamEnd?.();
    return this.response;
  }
}

class ScriptedProvider implements LLMProvider {
  readonly name = 'scripted';
  readonly model = 'test';
  constructor(private s: { ttfbMs: number; chunks: { delayMs: number; text: string }[]; tailMs: number }) {}
  generate(p: string, o?: GenerateOptions) { return this.generateStream(p, o); }
  generateStream(_p: string, options?: GenerateOptions, hooks?: StreamHooks): Promise<string> {
    return new Promise((resolve, reject) => {
      const timers: NodeJS.Timeout[] = [];
      let aborted = false;
      let out = '';
      let bytes = 0;
      const onAbort = () => { if (aborted) return; aborted = true; timers.forEach(clearTimeout); reject(new Error('killed by SIGKILL')); };
      if (options?.signal) { if (options.signal.aborted) return onAbort(); options.signal.addEventListener('abort', onAbort, { once: true }); }
      let t = this.s.ttfbMs;
      timers.push(setTimeout(() => { if (!aborted) hooks?.onFirstByte?.(); }, this.s.ttfbMs));
      for (const c of this.s.chunks) { t += c.delayMs; const at = t; timers.push(setTimeout(() => { if (aborted) return; out += c.text; bytes += c.text.length; hooks?.onChunk?.(bytes, c.text); }, at)); }
      timers.push(setTimeout(() => { if (!aborted) { hooks?.onStreamEnd?.(); resolve(out || 'ok'); } }, t + this.s.tailMs));
    });
  }
}

describe('Appendix regression suite (O16)', () => {
  let projectRoot: string;
  let phoenixDir: string;
  const ctx = { stage: 'generate', target: 'ModA', attempt: 0 };
  const smallBudgets = { startupMs: 40, streamStallMs: 50, wedgeMs: 40 };

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'phoenix-rgx-proj-'));
    phoenixDir = mkdtempSync(join(tmpdir(), 'phoenix-rgx-phx-'));
  });

  it('#1 phantom-error repair loop: missing typechecker fires ZERO repair calls', async () => {
    const provider = new CountingProvider();
    const journal = new RunJournal(phoenixDir);
    journal.startRun();
    const clauses = parseSpec('# Auth\n\n- Users must authenticate.', 'spec/a.md');
    const canon = extractCanonicalNodes(clauses);
    const iu = planIUs(canon, clauses)[0];

    await generateIU(iu, { llm: provider, canonNodes: canon, projectRoot, journal });

    expect(provider.calls).toBe(1); // initial generation only
    const events = RunJournal.readEvents(phoenixDir, journal.runId);
    expect(events.find(e => e.type === 'typecheck')?.status).toBe('unavailable');
  });

  it('#2 pipe-holding watchdog: a fast call is NOT delayed for the timeout', async () => {
    const journal = new RunJournal(phoenixDir);
    journal.startRun();
    const fast = new ScriptedProvider({ ttfbMs: 5, chunks: [{ delayMs: 5, text: 'ok' }], tailMs: 5 });
    const start = Date.now();
    // Huge budget — a sleep-based watchdog would still block; a polling one doesn't.
    await supervisedGenerate(journal, fast, 'p', undefined, ctx, { budgets: { startupMs: 60_000, streamStallMs: 60_000, wedgeMs: 60_000 }, pollMs: 10 });
    expect(Date.now() - start).toBeLessThan(1_000);
    expect(RunJournal.readEvents(phoenixDir, journal.runId).some(e => e.type === 'watchdog_kill')).toBe(false);
  });

  it('#3 concurrent-run clobber: a second run cannot acquire the lock', () => {
    const first = acquireRunLock(phoenixDir);
    writeFileSync(first.path, String(process.ppid || process.pid)); // live foreign owner
    expect(() => acquireRunLock(phoenixDir)).toThrow(AlreadyRunningError);
    first.release();
  });

  it('#4 stream stall on large output: a stalled stream is killed (slow≠dead distinguished)', async () => {
    const journal = new RunJournal(phoenixDir);
    journal.startRun();
    const stalling = new ScriptedProvider({ ttfbMs: 5, chunks: [{ delayMs: 5, text: 'x' }], tailMs: 10_000 });
    await expect(supervisedGenerate(journal, stalling, 'p', undefined, ctx, { budgets: smallBudgets, pollMs: 10 }))
      .rejects.toThrow(/Watchdog killed/);
    const kill = RunJournal.readEvents(phoenixDir, journal.runId).find(e => e.type === 'watchdog_kill');
    expect(kill?.health).toBe('stream-stalled');
  });

  it('#5 plan fragmentation: heading→module mapping makes the split visible', () => {
    const clauses = parseSpec('# App\n\n## Auth\n\n- Users must authenticate.\n\n## Billing\n\n- Payments must be processed.\n\n## Reports\n\n- Reports must be generated.', 'spec/app.md');
    const canon = extractCanonicalNodes(clauses);
    const ius = planIUs(canon, clauses);
    const report = analyzePlan(ius, canon, clauses);
    // Multiple distinct headings surface in the mapping — fragmentation is not hidden.
    const headings = new Set(report.headingToModule.map(h => h.heading));
    expect(headings.size).toBeGreaterThan(1);
    expect(report.modules.length).toBe(ius.length);
  });

  it('#6 silent config overwrite: a hand-edited tsconfig is preserved and reported', () => {
    writeScaffoldFiles(projectRoot, phoenixDir, [['tsconfig.json', '{"a":1}']]);
    writeFileSync(join(projectRoot, 'tsconfig.json'), '{"handEdit":true}');
    const report = writeScaffoldFiles(projectRoot, phoenixDir, [['tsconfig.json', '{"a":2}']]);
    expect(report[0].status).toBe('kept-hand-edited');
    expect(readFileSync(join(projectRoot, 'tsconfig.json'), 'utf8')).toContain('handEdit');
  });

  it('#7 done-but-broken: the acceptance gate fails and names the broken check', async () => {
    const repoTsc = join(process.cwd(), 'node_modules', '.bin', 'tsc');
    mkdirSync(join(projectRoot, 'node_modules', '.bin'), { recursive: true });
    writeFileSync(join(projectRoot, 'node_modules', '.bin', 'tsc'), `#!/bin/sh\nexec "${repoTsc}" "$@"\n`, { mode: 0o755 });
    mkdirSync(join(projectRoot, 'src'), { recursive: true });
    writeFileSync(join(projectRoot, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, noEmit: true }, include: ['src'] }));
    writeFileSync(join(projectRoot, 'src', 'broken.ts'), 'export const n: number = "nope";\n');

    const result = await runAcceptance({ projectRoot, skipRuntime: true });
    expect(result.ok).toBe(false);
    expect(result.checks.find(c => c.name === 'typecheck')!.ok).toBe(false);
  });

  it('#8 mislabeled stage: rule-based canonicalization is never labelled LLM', async () => {
    const clauses = parseSpec('# Auth\n\n- Users must authenticate.', 'spec/a.md');
    const junkLLM = new CountingProvider('no'); // too short → every node falls back to rule
    const { stats } = await canonicalize(clauses, junkLLM);
    expect(stats.llmAttempted).toBe(true);
    expect(stats.llmNodeCount).toBe(0);
    expect(stats.mode).toBe('rule-based');
  });

  it('#9 throttled watchdog: wall-clock polling kills a startup-stall; keep-awake is available', async () => {
    const ka = new KeepAwake();
    expect(() => { ka.start(); ka.stop(); }).not.toThrow();

    const journal = new RunJournal(phoenixDir);
    journal.startRun();
    const neverFirstByte = new ScriptedProvider({ ttfbMs: 10_000, chunks: [], tailMs: 0 });
    await expect(supervisedGenerate(journal, neverFirstByte, 'p', undefined, ctx, { budgets: smallBudgets, pollMs: 10 }))
      .rejects.toThrow(/Watchdog killed/);
    const kill = RunJournal.readEvents(phoenixDir, journal.runId).find(e => e.type === 'watchdog_kill');
    expect(kill?.health).toBe('startup-stalled');
  });

  it('#10 resume gap: a relaunched run skips already-completed modules', () => {
    const clauses = parseSpec('# App\n\n## Auth\n\n- Users must authenticate.\n\n## Billing\n\n- Payments must be processed.', 'spec/app.md');
    const canon = extractCanonicalNodes(clauses);
    const ius = planIUs(canon, clauses);
    const mgr = new ManifestManager(phoenixDir);

    // Complete the first module.
    const iu = ius[0];
    const files: Record<string, { path: string; content_hash: string; size: number }> = {};
    for (const rel of iu.output_files) {
      const content = `// done ${iu.name}\n`;
      const full = join(projectRoot, rel);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, content);
      files[rel] = { path: rel, content_hash: sha256(content), size: content.length };
    }
    mgr.recordIU({ iu_id: iu.iu_id, iu_name: iu.name, files, regen_metadata: { model_id: 'm', promptpack_hash: 'h', toolchain_version: 't', generated_at: 'now' } });

    const plan = computeResumePlan(phoenixDir, projectRoot, ius);
    expect(plan.completed.map(i => i.iu_id)).toContain(iu.iu_id);
    expect(plan.pending.map(i => i.iu_id)).not.toContain(iu.iu_id);
    expect(existsSync(join(projectRoot, iu.output_files[0]))).toBe(true);
  });
});
