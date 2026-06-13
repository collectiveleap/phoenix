/**
 * Supervised run (PRD O15, O16).
 *
 * The unattended controller: sense → classify → decide → act → record. It runs
 * the pipeline (canonicalize → plan → generate → scaffold → acceptance) under a
 * single run lock, a run journal, the watchdog, and a config-driven policy, and
 * exposes one live status surface that answers "what's happening / is it stuck /
 * how far along". Completed modules are skipped on resume.
 */

import { mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import type { Clause } from '../models/clause.js';
import type { ResolvedTarget } from '../models/architecture.js';
import type { LLMProvider } from '../llm/provider.js';
import { resolveModelsByRole } from '../llm/resolve.js';
import type { ImplementationUnit } from '../models/iu.js';
import { canonicalize } from '../canonicalizer-llm.js';
import { planIUs, analyzePlan } from '../iu-planner.js';
import { deriveInterfaces, deriveServices, generateScaffold, generateProjectConfig } from '../scaffold.js';
import { generateAll } from '../regen.js';
import type { RegenContext } from '../regen.js';
import { ManifestManager } from '../manifest.js';
import { CanonicalStore } from '../store/canonical-store.js';
import { saveIUs } from '../iu-planner-io.js';
import { RunJournal } from '../observe/journal.js';
import type { RunSnapshot } from '../observe/journal.js';
import { KeepAwake, abortAllInFlight } from '../observe/watchdog.js';
import { acquireRunLock, installTeardown } from './lock.js';
import { writeScaffoldFiles, pruneScaffoldFiles } from './scaffold-writer.js';
import { provision } from './provision.js';
import { runAcceptance } from './acceptance.js';
import { checkInterfaceContracts } from './contract-check.js';
import { produceEvidence, evaluateEvidence } from './evidence-gate.js';
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
  /** Install deps + build native deps before generating (B1/B2). */
  install: boolean;
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
    const ius = planIUs(canon.nodes, clauses, { roleSurfaces: arch?.architecture.roleSurfaces });
    saveIUs(phoenixDir, ius);
    const report = analyzePlan(ius, canon.nodes, clauses, { sizeThreshold: policy.sizeThreshold });
    totalModules = ius.length;
    journal.endStage('plan', 'ok', { modules: ius.length, oversized: report.oversizedCount });
    log(`plan: ${ius.length} modules${report.oversizedCount ? `, ${report.oversizedCount} oversized ⚠` : ''}`);

    // Derive the project shape once; reused for prune, provision, and scaffold.
    const projectName = projectRoot.split('/').pop() ?? 'app';
    const services = deriveServices(ius);
    const interfaces = deriveInterfaces(ius, canon.nodes, arch);
    const scaffold = generateScaffold(services, projectName, arch, interfaces);
    const manifestManager = new ManifestManager(phoenixDir);

    // ── Own the output tree (B5) ────────────────────────────────────────
    // Before writing anything, prune files a previous run / architecture wrote
    // that this run will not produce — e.g. a prior arch's shared `src/db.ts`,
    // or modules from an earlier plan — so the acceptance typecheck never trips
    // on foreign files. Current-plan files are kept, so resume is unaffected.
    const keep = new Set<string>([
      ...ius.flatMap(iu => iu.output_files),
      ...scaffold.files.keys(),
    ]);
    const prunedModules = manifestManager.pruneToPaths(keep);
    for (const rel of prunedModules) {
      const full = join(projectRoot, rel);
      if (existsSync(full)) rmSync(full, { force: true });
    }
    const prunedScaffold = pruneScaffoldFiles(projectRoot, phoenixDir, keep);
    const prunedTotal = prunedModules.length + prunedScaffold.length;
    if (prunedTotal > 0) log(`prune: removed ${prunedTotal} stale file(s)`);

    // Write shared architecture files (tracked) so generation typechecks resolve
    // imports — and so the writer records Phoenix as their owner for future prunes.
    if (arch) {
      writeScaffoldFiles(projectRoot, phoenixDir, Object.entries(arch.runtime.sharedFiles));
    }

    // ── Provision (B1/B2): write config, install deps, build native deps ──
    // Phoenix installs the architecture's declared deps and builds any native
    // ones, so per-module typecheck and the acceptance boot both have them —
    // the user never runs `pnpm add`/`rebuild`. Config files are written via the
    // scaffold writer (tracked in the manifest) so the later full scaffold sees
    // them unchanged, not as a hand edit.
    if (arch && opts.install) {
      journal.startStage('provision');
      const configFiles = generateProjectConfig(services, projectName, arch);
      writeScaffoldFiles(projectRoot, phoenixDir, configFiles);
      const prov = provision({
        projectRoot,
        nativeDeps: arch.runtime.nativeDeps,
        browserDeps: arch.runtime.browserDeps,
        log,
      });
      for (const s of prov.steps) log(`  ${s.ok ? '✔' : '✖'} ${s.name}: ${s.detail}`);
      journal.endStage('provision', prov.ok ? 'ok' : 'failed', {
        pm: prov.pm,
        steps: prov.steps.map(s => ({ name: s.name, ok: s.ok })),
      });
      if (!prov.ok) {
        journal.endRun('failed');
        return {
          ok: false,
          runId: journal.runId,
          failedStage: 'provision',
          error: prov.steps.find(s => !s.ok)?.detail,
        };
      }
    }

    // ── Generate (with resume) ──────────────────────────────────────────
    journal.startStage('generate');
    const { completed, pending } = opts.resume
      ? computeResumePlan(phoenixDir, projectRoot, ius, interfaces)
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
      maxRetries: policy.maxRetries,
      maxRepairs: policy.maxRepairs,
      backoffMs: policy.backoffMs,
      modelsByRole: resolveModelsByRole(phoenixDir, llm?.name), // per-role model (G2)
      log,
      onProgress: (iu, status, msg) => {
        if (status === 'done') log(`  ✔ ${iu.name}`);
        else if (status === 'error') log(`  ✖ ${iu.name}: ${msg ?? 'failed'}`);
      },
    };

    const results = await generateAll(pending, regenCtx);
    const failedModules: { name: string; remediation: string }[] = [];
    for (const result of results) {
      // A hard-failed module (e.g. over the output-token budget) produced no
      // usable output — write nothing, record nothing, report the remediation (T3).
      if (result.failed) {
        const iu = pending.find(u => u.iu_id === result.iu_id);
        failedModules.push({ name: iu?.name ?? result.iu_id, remediation: result.failed.remediation });
        continue;
      }
      for (const [filePath, content] of result.files) {
        const full = join(projectRoot, filePath);
        mkdirSync(dirname(full), { recursive: true });
        writeFileSync(full, content, 'utf8');
      }
      manifestManager.recordIU(result.manifest);
    }
    if (failedModules.length > 0) {
      const detail = failedModules.map(m => m.remediation).join(' ');
      journal.endStage('generate', 'failed', {
        generated: results.length - failedModules.length,
        failed: failedModules.length,
        skipped: completed.length,
        modules: failedModules.map(m => m.name),
      });
      journal.endRun('failed', { failedStage: 'generate', error: detail });
      return {
        ok: false,
        runId: journal.runId,
        failedStage: 'generate',
        error: `${failedModules.length} module(s) exceeded the output token budget — ${detail}`,
      };
    }
    journal.endStage('generate', 'ok', { generated: results.length, skipped: completed.length });

    // ── Scaffold ────────────────────────────────────────────────────────
    journal.startStage('scaffold');
    const scaffoldReport = writeScaffoldFiles(projectRoot, phoenixDir, scaffold.files, { force: opts.forceScaffold });
    const handEdits = scaffoldReport.filter(e => e.status === 'kept-hand-edited');
    if (handEdits.length > 0) log(`scaffold: kept ${handEdits.length} hand-edited file(s) ⚠`);
    journal.endStage('scaffold', 'ok', { files: scaffoldReport.length });

    // ── Acceptance gate (O12) ───────────────────────────────────────────
    journal.startStage('acceptance');
    const acceptance = await runAcceptance({ projectRoot, skipRuntime: !opts.runtimeChecks });

    // Cross-module interface contract (C3 + provider conformance): static, runs
    // regardless of runtime checks — a UI that calls an address no module serves
    // must not pass as "verified".
    const contract = checkInterfaceContracts(projectRoot, ius, interfaces, arch?.runtime.interfaceDialect, { checkProviders: true });
    acceptance.checks.push({
      name: 'cross-module-contract',
      ok: contract.ok,
      detail: contract.ok
        ? (contract.checked === 0 ? 'no runtime interface contracts to check' : `${contract.checked} module(s) — all calls resolve`)
        : contract.violations.map(v => v.detail).join('; '),
    });
    if (contract.violations.length > 0) {
      journal.event('contract_violations', { count: contract.violations.length, violations: contract.violations });
    }

    // Evidence policy (PRD: code → evidence → policy decision). Turn the gate's
    // checks into per-IU evidence and evaluate each module's declared policy: a
    // required type that was produced and FAILED makes the run not verified;
    // a type not produced this run is reported INCOMPLETE (surfaced, not fatal).
    const evidence = produceEvidence(ius, acceptance.checks, contract.violations, new Date().toISOString());
    const ev = evaluateEvidence(ius, evidence);
    journal.event('evidence_policy', {
      verdicts: ev.verdicts.map(v => ({ iu: v.iu_name, verdict: v.verdict, satisfied: v.satisfied, missing: v.missing, failed: v.failed })),
    });
    for (const v of ev.verdicts) {
      if (v.verdict === 'FAIL') log(`  ✖ evidence(${v.iu_name}): failed ${v.failed.join(', ')}`);
      else if (v.verdict === 'INCOMPLETE') log(`  • evidence(${v.iu_name}): incomplete — ${v.missing.join(', ')} not produced (run --runtime-checks)`);
    }

    const gateOk = acceptance.ok && contract.ok && !ev.anyFailed;
    journal.endStage('acceptance', gateOk ? 'ok' : 'failed', {
      checks: acceptance.checks.map(c => ({ name: c.name, ok: c.ok })),
    });
    for (const c of acceptance.checks) log(`  ${c.ok ? '✔' : '✖'} ${c.name}: ${c.detail}`);

    const ok = gateOk;
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
