/**
 * Supervised run (PRD O15, O16).
 *
 * The unattended controller: sense → classify → decide → act → record. It runs
 * the pipeline (canonicalize → plan → generate → scaffold → acceptance) under a
 * single run lock, a run journal, the watchdog, and a config-driven policy, and
 * exposes one live status surface that answers "what's happening / is it stuck /
 * how far along". Completed modules are skipped on resume.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import type { Clause } from '../models/clause.js';
import type { ResolvedTarget } from '../models/architecture.js';
import type { LLMProvider } from '../llm/provider.js';
import type { ImplementationUnit } from '../models/iu.js';
import { canonicalize } from '../canonicalizer-llm.js';
import { planIUs, analyzePlan } from '../iu-planner.js';
import { deriveInterfaces, deriveServices, generateScaffold } from '../scaffold.js';
import { generateAll } from '../regen.js';
import type { RegenContext } from '../regen.js';
import { ManifestManager } from '../manifest.js';
import { CanonicalStore } from '../store/canonical-store.js';
import { saveIUs } from '../iu-planner-io.js';
import { RunJournal } from '../observe/journal.js';
import type { RunSnapshot } from '../observe/journal.js';
import { KeepAwake, abortAllInFlight } from '../observe/watchdog.js';
import { acquireRunLock, installTeardown } from './lock.js';
import { writeScaffoldFiles } from './scaffold-writer.js';
import { runAcceptance } from './acceptance.js';
import type { AcceptanceResult } from './acceptance.js';
import { computeResumePlan } from './resume.js';
import type { RunPolicy } from './policy.js';

export interface RunOptions {
  projectRoot: string;
  phoenixDir: string;
  clauses: Clause[];
  arch: ResolvedTarget | null;
  llm: LLMProvider | null;
  policy: RunPolicy;
  resume: boolean;
  forceScaffold: boolean;
  /** Run the acceptance boot+route checks (needs installed deps). */
  runtimeChecks: boolean;
  /** Stage/line logger. */
  log: (msg: string) => void;
}

export interface RunResult {
  ok: boolean;
  runId: string;
  acceptance?: AcceptanceResult;
  failedStage?: string;
  error?: string;
}

/**
 * Render the live status surface (O15): current stage, current module, per-call
 * health, retries/outcomes, and progress. Used both as a heartbeat and for
 * post-hoc inspection of a persisted run.
 */
export function renderRunStatus(snap: RunSnapshot, totalModules?: number): string[] {
  const now = Date.now();
  const lines: string[] = [];
  const stage = snap.stage ?? (snap.endedAt ? 'done' : '—');
  const elapsed = Math.round(((snap.endedAt ?? now) - snap.startedAt) / 1000);
  lines.push(`stage: ${stage}  ·  elapsed ${elapsed}s${snap.outcome ? `  ·  outcome ${snap.outcome}` : ''}`);

  const calls = snap.calls;
  const done = calls.filter(c => c.outcome === 'ok').length;
  const failed = calls.filter(c => c.endedAt && c.outcome !== 'ok').length;
  const active = calls.filter(c => c.endedAt === undefined);
  const total = totalModules !== undefined ? `/${totalModules}` : '';
  lines.push(`calls: ${calls.length} total · ${done} ok · ${failed} failed · ${active.length} active${total ? `  ·  modules ${done}${total}` : ''}`);

  for (const c of active) {
    const health = RunJournal.classify(c, undefined, now);
    const secs = Math.round((now - c.startedAt) / 1000);
    lines.push(`  ⏳ ${c.target ?? c.stage} — ${secs}s, ${c.bytesStreamed}B, ${health}`);
  }
  return lines;
}

export async function runSupervised(opts: RunOptions): Promise<RunResult> {
  const { projectRoot, phoenixDir, clauses, arch, llm, policy, log } = opts;

  const lock = acquireRunLock(phoenixDir);
  const keepAwake = new KeepAwake();
  keepAwake.start();
  const journal = new RunJournal(phoenixDir);

  let totalModules = 0;
  let heartbeat: NodeJS.Timeout | undefined;

  const cleanup = () => {
    if (heartbeat) clearInterval(heartbeat);
    abortAllInFlight();
    keepAwake.stop();
    lock.release();
  };
  const uninstall = installTeardown(() => {
    journal.event('run_aborted', { reason: 'signal' });
    cleanup();
  });

  try {
    journal.startRun({ arch: arch?.architecture.name ?? 'none', provider: llm ? `${llm.name}/${llm.model}` : 'stubs' });
    log(`run ${journal.runId}`);

    // Live status heartbeat (≥ every 5s — O2/O15).
    heartbeat = setInterval(() => {
      const snap = journal.snapshot();
      if (snap.calls.some(c => c.endedAt === undefined)) {
        for (const line of renderRunStatus(snap, totalModules)) log(`  ${line}`);
      }
    }, 5_000);
    (heartbeat as unknown as { unref?: () => void }).unref?.();

    // ── Canonicalize ────────────────────────────────────────────────────
    journal.startStage('canonicalize');
    const canon = await canonicalize(clauses, llm, { journal });
    new CanonicalStore(phoenixDir).saveNodes(canon.nodes);
    journal.endStage('canonicalize', 'ok', { mode: canon.stats.mode, nodes: canon.nodes.length });
    log(`canonicalize: ${canon.nodes.length} nodes (${canon.stats.mode})`);

    // ── Plan ────────────────────────────────────────────────────────────
    journal.startStage('plan');
    const ius = planIUs(canon.nodes, clauses);
    saveIUs(phoenixDir, ius);
    const report = analyzePlan(ius, canon.nodes, clauses, { sizeThreshold: policy.sizeThreshold });
    totalModules = ius.length;
    journal.endStage('plan', 'ok', { modules: ius.length, oversized: report.oversizedCount });
    log(`plan: ${ius.length} modules${report.oversizedCount ? `, ${report.oversizedCount} oversized ⚠` : ''}`);

    // Write shared architecture files so generation typechecks resolve imports.
    if (arch) {
      for (const [filePath, content] of Object.entries(arch.runtime.sharedFiles)) {
        const full = join(projectRoot, filePath);
        mkdirSync(dirname(full), { recursive: true });
        writeFileSync(full, content, 'utf8');
      }
    }

    // ── Generate (with resume) ──────────────────────────────────────────
    journal.startStage('generate');
    const interfaces = deriveInterfaces(ius, canon.nodes);
    const { completed, pending } = opts.resume
      ? computeResumePlan(phoenixDir, projectRoot, ius)
      : { completed: [] as ImplementationUnit[], pending: ius };
    if (completed.length > 0) log(`resume: skipping ${completed.length} completed module(s)`);

    const regenCtx: RegenContext = {
      llm: llm ?? undefined,
      canonNodes: canon.nodes,
      allIUs: ius,
      projectRoot,
      target: arch,
      interfaces,
      journal,
      budgets: policy.budgets,
      onProgress: (iu, status, msg) => {
        if (status === 'done') log(`  ✔ ${iu.name}`);
        else if (status === 'error') log(`  ✖ ${iu.name}: ${msg ?? 'failed'}`);
      },
    };

    const manifestManager = new ManifestManager(phoenixDir);
    const results = await generateAll(pending, regenCtx);
    for (const result of results) {
      for (const [filePath, content] of result.files) {
        const full = join(projectRoot, filePath);
        mkdirSync(dirname(full), { recursive: true });
        writeFileSync(full, content, 'utf8');
      }
      manifestManager.recordIU(result.manifest);
    }
    journal.endStage('generate', 'ok', { generated: results.length, skipped: completed.length });

    // ── Scaffold ────────────────────────────────────────────────────────
    journal.startStage('scaffold');
    const services = deriveServices(ius);
    const scaffold = generateScaffold(services, projectRoot.split('/').pop() ?? 'app', arch, interfaces);
    const scaffoldReport = writeScaffoldFiles(projectRoot, phoenixDir, scaffold.files, { force: opts.forceScaffold });
    const handEdits = scaffoldReport.filter(e => e.status === 'kept-hand-edited');
    if (handEdits.length > 0) log(`scaffold: kept ${handEdits.length} hand-edited file(s) ⚠`);
    journal.endStage('scaffold', 'ok', { files: scaffoldReport.length });

    // ── Acceptance gate (O12) ───────────────────────────────────────────
    journal.startStage('acceptance');
    const acceptance = await runAcceptance({ projectRoot, skipRuntime: !opts.runtimeChecks });
    journal.endStage('acceptance', acceptance.ok ? 'ok' : 'failed', {
      checks: acceptance.checks.map(c => ({ name: c.name, ok: c.ok })),
    });
    for (const c of acceptance.checks) log(`  ${c.ok ? '✔' : '✖'} ${c.name}: ${c.detail}`);

    const ok = acceptance.ok;
    journal.endRun(ok ? 'ok' : 'failed');
    return {
      ok,
      runId: journal.runId,
      acceptance,
      failedStage: ok ? undefined : 'acceptance',
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    journal.endRun('error', { error: message });
    return { ok: false, runId: journal.runId, error: message };
  } finally {
    uninstall();
    cleanup();
  }
}
