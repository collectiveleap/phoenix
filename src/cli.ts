#!/usr/bin/env node
/**
 * Phoenix VCS — Command Line Interface
 *
 * The primary UX surface for Phoenix. `phoenix status` is the most
 * important command — it must always be explainable, conservative,
 * and correct-enough to rely on.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join, resolve, relative, basename, dirname } from 'node:path';

// Stores
import { SpecStore } from './store/spec-store.js';
import { CanonicalStore } from './store/canonical-store.js';
import { EvidenceStore } from './store/evidence-store.js';
import { ManifestManager } from './manifest.js';

// Phase A
import { parseSpec } from './spec-parser.js';
import { diffClauses } from './diff.js';

// Phase B
import { extractCanonicalNodes, extractCandidates } from './canonicalizer.js';
import { extractCanonicalNodesLLM, canonicalize } from './canonicalizer-llm.js';
import { computeWarmHashes } from './warm-hasher.js';
import { classifyChanges } from './classifier.js';
import { classifyChangesWithLLM } from './classifier-llm.js';
import { DRateTracker } from './d-rate.js';
import { BootstrapStateMachine } from './bootstrap.js';

// Phase C
import { planIUs, analyzePlan } from './iu-planner.js';
import { loadIUs, saveIUs } from './iu-planner-io.js';
import { runSupervised, renderRunStatus } from './harness/run.js';
import { loadPolicy, describePolicy } from './harness/policy.js';
import { acquireRunLock, AlreadyRunningError } from './harness/lock.js';
import { RunJournal } from './observe/journal.js';
import { generateIU, generateAll, WEBUI_STRATEGIES, typecheckFile } from './regen.js';
import type { RegenContext, WebUIMetrics } from './regen.js';
import { probeTypechecker } from './harness/typecheck.js';
import { detectDrift } from './drift.js';
import { extractDependencies } from './dep-extractor.js';
import { validateBoundary } from './boundary-validator.js';

// Phase D
import { evaluatePolicy, evaluateAllPolicies } from './policy-engine.js';
import { computeCascade } from './cascade.js';

// Phase E
import { runShadowPipeline } from './shadow-pipeline.js';

// Phase F
import { parseCommand, routeCommand, getAllCommands } from './bot-router.js';

// Scaffold
import { deriveServices, deriveInterfaces, generateScaffold } from './scaffold.js';

// Inspect
import { collectInspectData, renderInspectHTML, serveInspect } from './inspect.js';

// LLM
import { resolveProvider, describeAvailability, resolveProviderInfo, describeResolution, resolveModelsByRole } from './llm/resolve.js';
import { writeScaffoldFiles } from './harness/scaffold-writer.js';
import type { ScaffoldWriteEntry } from './harness/scaffold-writer.js';
import { preflight } from './harness/preflight.js';
import type { PreflightResult } from './harness/preflight.js';

// Architectures
import { resolveTarget, listArchitectures } from './architectures/index.js';
import type { ResolvedTarget } from './models/architecture.js';

// Audit & Fowler gaps
import { auditIU, auditAll } from './audit.js';
import type { AuditResult, ReadinessLevel } from './audit.js';
import { EvaluationStore } from './store/evaluation-store.js';
import { NegativeKnowledgeStore } from './store/negative-knowledge-store.js';
import type { PaceLayerMetadata } from './models/pace-layer.js';

// Models
import type { Clause } from './models/clause.js';
import { DiffType } from './models/clause.js';
import type { CanonicalNode } from './models/canonical.js';
import type { ImplementationUnit } from './models/iu.js';
import type { Diagnostic } from './models/diagnostic.js';
import type { DriftReport } from './models/manifest.js';
import { DriftStatus } from './models/manifest.js';
import { BootstrapState, DRateLevel } from './models/classification.js';
import type { PolicyEvaluation, CascadeEvent } from './models/evidence.js';

// ─── ANSI Colors ─────────────────────────────────────────────────────────────

const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const BLUE = '\x1b[34m';
const MAGENTA = '\x1b[35m';
const CYAN = '\x1b[36m';
const WHITE = '\x1b[37m';
const BG_RED = '\x1b[41m';
const BG_GREEN = '\x1b[42m';
const BG_YELLOW = '\x1b[43m';

function red(s: string): string { return `${RED}${s}${RESET}`; }
function green(s: string): string { return `${GREEN}${s}${RESET}`; }
function yellow(s: string): string { return `${YELLOW}${s}${RESET}`; }
function blue(s: string): string { return `${BLUE}${s}${RESET}`; }
function magenta(s: string): string { return `${MAGENTA}${s}${RESET}`; }
function cyan(s: string): string { return `${CYAN}${s}${RESET}`; }
function dim(s: string): string { return `${DIM}${s}${RESET}`; }
function bold(s: string): string { return `${BOLD}${s}${RESET}`; }

/** Print a tracked-scaffold-write report (O7): every file, hand-edits flagged. */
function printScaffoldReport(report: ScaffoldWriteEntry[]): void {
  for (const e of report) {
    switch (e.status) {
      case 'created':
        console.log(`    ${green('✔')} ${e.path} ${dim('(created)')}`);
        break;
      case 'updated':
        console.log(`    ${green('✔')} ${e.path} ${dim('(overwritten)')}`);
        break;
      case 'unchanged':
        console.log(`    ${dim('·')} ${dim(`${e.path} (unchanged)`)}`);
        break;
      case 'kept-hand-edited':
        console.log(`    ${yellow('⚠')} ${e.path} ${yellow('(hand-edited — kept; rerun with --force-scaffold to regenerate)')}`);
        break;
      case 'overwritten-hand-edited':
        console.log(`    ${yellow('⚠')} ${e.path} ${yellow('(hand-edited — overwritten)')}`);
        break;
    }
  }
}

function severityColor(severity: string): string {
  switch (severity) {
    case 'error': return `${BG_RED}${WHITE}${BOLD} ERROR ${RESET}`;
    case 'warning': return `${BG_YELLOW}${WHITE}${BOLD} WARN  ${RESET}`;
    case 'info': return `${BG_GREEN}${WHITE}${BOLD} INFO  ${RESET}`;
    default: return severity;
  }
}

function severityIcon(severity: string): string {
  switch (severity) {
    case 'error': return red('✖');
    case 'warning': return yellow('⚠');
    case 'info': return blue('ℹ');
    default: return ' ';
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const VERSION = '0.1.0';

function findPhoenixRoot(from: string = process.cwd()): string | null {
  let dir = resolve(from);
  while (true) {
    if (existsSync(join(dir, '.phoenix'))) return dir;
    const parent = resolve(dir, '..');
    if (parent === dir) return null;
    dir = parent;
  }
}

function requirePhoenixRoot(): { projectRoot: string; phoenixDir: string } {
  const projectRoot = findPhoenixRoot();
  if (!projectRoot) {
    console.error(red('✖ Not a Phoenix project. Run `phoenix init` first.'));
    process.exit(1);
  }
  return { projectRoot, phoenixDir: join(projectRoot, '.phoenix') };
}

function loadBootstrapState(phoenixDir: string): BootstrapStateMachine {
  const statePath = join(phoenixDir, 'state.json');
  if (existsSync(statePath)) {
    const data = JSON.parse(readFileSync(statePath, 'utf8'));
    return BootstrapStateMachine.fromJSON(data);
  }
  return new BootstrapStateMachine();
}

function saveBootstrapState(phoenixDir: string, machine: BootstrapStateMachine): void {
  writeFileSync(join(phoenixDir, 'state.json'), JSON.stringify(machine.toJSON(), null, 2), 'utf8');
}

function loadDRateTracker(phoenixDir: string): DRateTracker {
  const path = join(phoenixDir, 'drate.json');
  if (existsSync(path)) {
    const data = JSON.parse(readFileSync(path, 'utf8'));
    const tracker = new DRateTracker(data.window_size || 100);
    // Re-record stored window
    if (data.window) {
      for (const cls of data.window) {
        tracker.recordOne(cls);
      }
    }
    return tracker;
  }
  return new DRateTracker();
}

function saveDRateTracker(phoenixDir: string, tracker: DRateTracker): void {
  const status = tracker.getStatus();
  writeFileSync(join(phoenixDir, 'drate.json'), JSON.stringify({
    window_size: status.window_size,
    rate: status.rate,
    level: status.level,
    d_count: status.d_count,
    total_count: status.total_count,
  }, null, 2), 'utf8');
}

function findSpecFiles(projectRoot: string): string[] {
  const specDir = join(projectRoot, 'spec');
  if (!existsSync(specDir)) return [];
  return readdirSync(specDir, { recursive: true })
    .map(f => f.toString())
    .filter(f => f.endsWith('.md'))
    .map(f => join(specDir, f));
}

function printDiagnosticTable(diagnostics: Diagnostic[]): void {
  if (diagnostics.length === 0) {
    console.log(green('  No issues found.'));
    return;
  }

  const errors = diagnostics.filter(d => d.severity === 'error');
  const warnings = diagnostics.filter(d => d.severity === 'warning');
  const infos = diagnostics.filter(d => d.severity === 'info');

  for (const group of [
    { items: errors, label: 'Errors' },
    { items: warnings, label: 'Warnings' },
    { items: infos, label: 'Info' },
  ]) {
    if (group.items.length === 0) continue;
    console.log();
    console.log(`  ${bold(group.label)} (${group.items.length}):`);
    for (const d of group.items) {
      console.log(`    ${severityIcon(d.severity)} ${bold(d.category)} ${dim('·')} ${d.subject}`);
      console.log(`      ${d.message}`);
      if (d.recommended_actions.length > 0) {
        console.log(`      ${dim('→')} ${dim(d.recommended_actions[0])}`);
      }
    }
  }
}

// ─── Commands ────────────────────────────────────────────────────────────────

function cmdInit(args?: string[]): void {
  const projectRoot = process.cwd();
  const phoenixDir = join(projectRoot, '.phoenix');

  if (existsSync(phoenixDir)) {
    console.log(yellow('⚠ Phoenix already initialized in this directory.'));
    return;
  }

  mkdirSync(join(phoenixDir, 'store', 'objects'), { recursive: true });
  mkdirSync(join(phoenixDir, 'graphs'), { recursive: true });
  mkdirSync(join(phoenixDir, 'manifests'), { recursive: true });

  const machine = new BootstrapStateMachine();
  saveBootstrapState(phoenixDir, machine);

  // Save architecture choice if specified
  const archArg = args?.find(a => a.startsWith('--arch='))?.split('=')[1];
  if (archArg) {
    const arch = resolveTarget(archArg);
    if (!arch) {
      console.log(red(`✖ Unknown architecture: ${archArg}`));
      console.log(`  Available: ${listArchitectures().join(', ')}`);
      return;
    }
    const configPath = join(phoenixDir, 'config.json');
    const config = existsSync(configPath) ? JSON.parse(readFileSync(configPath, 'utf8')) : {};
    config.architecture = archArg;
    writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
  }

  // Ensure spec/ directory exists
  const specDir = join(projectRoot, 'spec');
  if (!existsSync(specDir)) {
    mkdirSync(specDir, { recursive: true });
  }

  // Create .gitignore
  const gitignorePath = join(phoenixDir, '.gitignore');
  if (!existsSync(gitignorePath)) {
    writeFileSync(gitignorePath, 'store/objects/\n', 'utf8');
  }

  console.log(green('✔ Phoenix initialized.'));
  console.log();
  console.log(`  ${dim('Project root:')}  ${projectRoot}`);
  console.log(`  ${dim('Phoenix dir:')}   ${phoenixDir}`);
  console.log(`  ${dim('State:')}         ${BootstrapState.BOOTSTRAP_COLD}`);
  if (archArg) {
    console.log(`  ${dim('Architecture:')} ${cyan(archArg)}`);
  }
  console.log();
  console.log(`  ${dim('Next steps:')}`);
  console.log(`    1. Add spec documents to ${cyan('spec/')}`);
  console.log(`    2. Run ${cyan('phoenix bootstrap')} to ingest & canonicalize`);
}

async function cmdBootstrap(): Promise<void> {
  const { projectRoot, phoenixDir } = requirePhoenixRoot();

  console.log(bold('🔥 Phoenix Bootstrap'));
  console.log();

  const specStore = new SpecStore(phoenixDir);
  const canonStore = new CanonicalStore(phoenixDir);
  const machine = loadBootstrapState(phoenixDir);

  // Step 1: Find and ingest spec files
  const specFiles = findSpecFiles(projectRoot);
  if (specFiles.length === 0) {
    console.log(yellow('  ⚠ No spec files found in spec/ directory.'));
    console.log(dim(`    Add .md files to ${join(projectRoot, 'spec')} and re-run.`));
    return;
  }

  console.log(`  ${dim('Phase A:')} Clause extraction + cold hashing`);
  let totalClauses = 0;
  for (const specFile of specFiles) {
    const result = specStore.ingestDocument(specFile, projectRoot);
    totalClauses += result.clauses.length;
    console.log(`    ${green('✔')} ${relative(projectRoot, specFile)} → ${result.clauses.length} clauses`);
  }
  console.log(`    ${dim(`Total: ${totalClauses} clauses extracted`)}`);
  console.log();

  // Step 2: Canonicalization
  const llmInfo = resolveProviderInfo(phoenixDir);
  const llmEarly = resolveProvider(phoenixDir);
  console.log(`  ${dim('Phase B:')} Canonicalization + warm context hashing`);
  for (const line of describeResolution(llmInfo)) {
    console.log(`    ${line.startsWith('⚠') ? yellow(line) : dim(line)}`);
  }

  // Collect all clauses
  const allClauses: Clause[] = [];
  for (const specFile of specFiles) {
    const docId = relative(projectRoot, specFile);
    allClauses.push(...specStore.getClauses(docId));
  }

  // Extract canonical nodes (LLM-enhanced when available). Report the mode
  // that ACTUALLY ran — never label rule-based as LLM (O4 / appendix #8).
  const canon = await canonicalize(allClauses, llmEarly);
  const canonNodes = canon.nodes;
  canonStore.saveNodes(canonNodes);
  if (canon.stats.mode === 'llm-normalized') {
    console.log(`    ${green('✔')} ${canonNodes.length} canonical nodes (LLM-normalized: ${canon.stats.llmNodeCount}/${canonNodes.length} via ${llmEarly?.name}/${llmEarly?.model}, ${canon.stats.ruleNodeCount} rule-based)`);
  } else {
    const why = canon.stats.fellBackToRules ? ' (LLM unavailable mid-run — fell back)' : (llmEarly ? ' (LLM produced no nodes — rule-based)' : '');
    console.log(`    ${green('✔')} ${canonNodes.length} canonical nodes (rule-based)${dim(why)}`);
  }

  // Compute warm hashes
  const warmHashes = computeWarmHashes(allClauses, canonNodes);
  console.log(`    ${green('✔')} ${warmHashes.size} warm context hashes computed`);

  // Save warm hashes
  const warmPath = join(phoenixDir, 'graphs', 'warm-hashes.json');
  const warmObj: Record<string, string> = {};
  for (const [k, v] of warmHashes) warmObj[k] = v;
  writeFileSync(warmPath, JSON.stringify(warmObj, null, 2), 'utf8');

  // Mark warm pass complete
  machine.markWarmPassComplete();
  console.log(`    ${green('✔')} System state: ${cyan(machine.getState())}`);
  console.log();

  // Step 3: Plan IUs
  console.log(`  ${dim('Phase C:')} IU planning`);
  const ius = planIUs(canonNodes, allClauses);
  saveIUs(phoenixDir, ius);
  console.log(`    ${green('✔')} ${ius.length} Implementation Units planned`);
  for (const iu of ius) {
    console.log(`      ${dim('·')} ${iu.name} ${dim(`(${iu.risk_tier})`)} → ${iu.output_files.join(', ')}`);
  }
  console.log();

  // Step 4: Generate code
  const llm = resolveProvider(phoenixDir);
  const { hint } = describeAvailability();
  if (llm) {
    console.log(`  ${dim('Phase C:')} Code generation ${dim(`(${llm.name}/${llm.model})`)}`);
  } else {
    console.log(`  ${dim('Phase C:')} Code generation ${dim('(stubs — no LLM)')}`);
    console.log(`    ${dim(hint)}`);
  }

  // Load architecture from config
  const configPath = join(phoenixDir, 'config.json');
  let arch: ResolvedTarget | null = null;
  if (existsSync(configPath)) {
    try {
      const config = JSON.parse(readFileSync(configPath, 'utf8'));
      if (config.architecture) {
        arch = resolveTarget(config.architecture);
        if (arch) console.log(`  ${dim('Architecture:')} ${cyan(arch.architecture.name)} / ${cyan(arch.runtime.name)}`);
      }
    } catch { /* ignore */ }
  }

  // Write shared architecture files BEFORE code generation
  // so the typecheck-retry loop can resolve imports like ../../db.js
  if (arch) {
    for (const [filePath, content] of Object.entries(arch.runtime.sharedFiles)) {
      const fullPath = join(projectRoot, filePath);
      mkdirSync(dirname(fullPath), { recursive: true });
      writeFileSync(fullPath, content, 'utf8');
    }
    // Write package.json with arch deps so tsc can resolve types during generation
    const earlyPkg = {
      name: basename(projectRoot),
      version: '0.1.0',
      type: 'module',
      dependencies: arch.runtime.packages,
      devDependencies: arch.runtime.devPackages,
    };
    const pkgPath = join(projectRoot, 'package.json');
    writeFileSync(pkgPath, JSON.stringify(earlyPkg, null, 2) + '\n', 'utf8');
    // Install so type declarations are available for typecheck-retry
    try {
      execSync('npm install --silent 2>/dev/null', { cwd: projectRoot, stdio: 'pipe', timeout: 60000 });
    } catch { /* best effort */ }
  }

  const interfaces = deriveInterfaces(ius, canonNodes, arch);

  const regenCtx: RegenContext = {
    llm: llm ?? undefined,
    canonNodes,
    allIUs: ius,
    projectRoot,
    target: arch,
    interfaces,
    modelsByRole: resolveModelsByRole(phoenixDir, llm?.name), // per-role model (G2)
    onProgress: (iu, status, msg) => {
      if (status === 'start') process.stdout.write(`    ⏳ ${iu.name}…`);
      else if (status === 'done') process.stdout.write(` ${green('✔')}\n`);
      else if (status === 'error') process.stdout.write(` ${red('✖')} ${dim(msg || 'failed, using stub')}\n`);
    },
  };

  const manifestManager = new ManifestManager(phoenixDir);
  const regenResults = await generateAll(ius, regenCtx);
  for (const result of regenResults) {
    // A hard-failed module (e.g. over the output-token budget) produced no
    // usable output — write nothing and report the remediation (T3).
    if (result.failed) {
      console.log(`    ${red('✖')} ${result.iu_id.slice(0, 8)}… ${dim(result.failed.remediation)}`);
      continue;
    }
    for (const [filePath, content] of result.files) {
      const fullPath = join(projectRoot, filePath);
      mkdirSync(join(fullPath, '..'), { recursive: true });
      writeFileSync(fullPath, content, 'utf8');
    }
    manifestManager.recordIU(result.manifest);
    if (!llm) {
      console.log(`    ${green('✔')} ${result.iu_id.slice(0, 8)}… → ${result.files.size} file(s)`);
    }
  }
  console.log();

  // Step 5: Service scaffold
  console.log(`  ${dim('Scaffold:')} Service wiring + project config`);
  const services = deriveServices(ius);
  const projectName = basename(projectRoot);
  const scaffold = generateScaffold(services, projectName, arch, interfaces);
  // Tracked write: every file is reported; hand-edits are preserved (O7).
  const scaffoldReport = writeScaffoldFiles(projectRoot, phoenixDir, scaffold.files);
  printScaffoldReport(scaffoldReport);
  for (const svc of services) {
    console.log(`    ${green('✔')} ${svc.name} → :${svc.port} (${svc.modules.length} modules)`);
  }
  console.log();

  // Save state
  saveBootstrapState(phoenixDir, machine);

  // Step 6: First trust dashboard
  console.log(`  ${dim('Phase D:')} Trust Dashboard`);
  console.log();
  printTrustDashboard(phoenixDir, projectRoot, machine, ius, canonNodes, allClauses);

  console.log();
  console.log(green('  ✔ Bootstrap complete.'));
  console.log(`    State: ${cyan(machine.getState())}`);
  console.log(`    Run ${cyan('phoenix status')} to see the trust dashboard.`);
}

function cmdStatus(): void {
  const { projectRoot, phoenixDir } = requirePhoenixRoot();
  const machine = loadBootstrapState(phoenixDir);
  const ius = loadIUs(phoenixDir);
  const canonStore = new CanonicalStore(phoenixDir);
  const canonNodes = canonStore.getAllNodes();
  const specStore = new SpecStore(phoenixDir);

  // Collect all clauses
  const allClauses: Clause[] = [];
  const specFiles = findSpecFiles(projectRoot);
  for (const specFile of specFiles) {
    const docId = relative(projectRoot, specFile);
    allClauses.push(...specStore.getClauses(docId));
  }

  console.log();
  console.log(bold('🔥 Phoenix Status'));
  console.log();

  printTrustDashboard(phoenixDir, projectRoot, machine, ius, canonNodes, allClauses);
}

function printTrustDashboard(
  phoenixDir: string,
  projectRoot: string,
  machine: BootstrapStateMachine,
  ius: ImplementationUnit[],
  canonNodes: CanonicalNode[],
  allClauses: Clause[],
): void {
  const diagnostics: Diagnostic[] = [];

  // System state
  const state = machine.getState();
  const stateLabel = state === BootstrapState.STEADY_STATE
    ? green(state)
    : state === BootstrapState.BOOTSTRAP_WARMING
      ? yellow(state)
      : cyan(state);
  console.log(`  ${dim('System State:')} ${stateLabel}`);
  console.log(`  ${dim('Canonical Nodes:')} ${canonNodes.length}`);
  console.log(`  ${dim('Implementation Units:')} ${ius.length}`);
  console.log(`  ${dim('Spec Clauses:')} ${allClauses.length}`);

  // Canon type breakdown
  const typeBreakdown: Record<string, number> = {};
  for (const n of canonNodes) typeBreakdown[n.type] = (typeBreakdown[n.type] ?? 0) + 1;
  const typeParts = Object.entries(typeBreakdown).map(([t, c]) => `${c} ${t}`);
  if (typeParts.length > 0) {
    console.log(`  ${dim('Canon Types:')} ${dim(typeParts.join(', '))}`);
  }

  // Resolution metrics
  let totalEdges = 0;
  let relatesToEdges = 0;
  let orphanCount = 0;
  let maxDegree = 0;
  let withParent = 0;
  const nonContextNodes = canonNodes.filter(n => n.type !== 'CONTEXT');
  for (const n of canonNodes) {
    const deg = n.linked_canon_ids.length;
    if (deg === 0) orphanCount++;
    if (deg > maxDegree) maxDegree = deg;
    if (n.parent_canon_id) withParent++;
    for (const [, edgeType] of Object.entries(n.link_types ?? {})) {
      totalEdges++;
      if (edgeType === 'relates_to') relatesToEdges++;
    }
  }
  if (canonNodes.length > 0) {
    const resDRate = totalEdges > 0 ? ((relatesToEdges / totalEdges) * 100).toFixed(0) : '0';
    const orphanPct = ((orphanCount / canonNodes.length) * 100).toFixed(0);
    const hierPct = nonContextNodes.length > 0 ? ((withParent / nonContextNodes.length) * 100).toFixed(0) : '0';
    console.log(`  ${dim('Resolution:')} ${totalEdges} edges ${dim(`(${resDRate}% relates_to)`)}${dim(',')} max degree ${maxDegree}${dim(',')} ${hierPct}% hierarchy`);
  }

  // Extraction coverage (recompute from current specs)
  if (allClauses.length > 0) {
    const { coverage } = extractCandidates(allClauses);
    const avgCov = coverage.reduce((s, c) => s + c.coverage_pct, 0) / coverage.length;
    const lowCov = coverage.filter(c => c.coverage_pct < 80);
    const covLabel = avgCov >= 95 ? green(`${avgCov.toFixed(0)}%`) : avgCov >= 80 ? yellow(`${avgCov.toFixed(0)}%`) : red(`${avgCov.toFixed(0)}%`);
    console.log(`  ${dim('Coverage:')} ${covLabel} extraction${lowCov.length > 0 ? dim(` (${lowCov.length} clause${lowCov.length !== 1 ? 's' : ''} below 80%)`) : ''}`);
    for (const cov of lowCov) {
      diagnostics.push({
        severity: 'info',
        category: 'canon',
        subject: cov.clause_id.slice(0, 12),
        message: `Extraction coverage ${cov.coverage_pct.toFixed(0)}% (${cov.extracted_sentences + cov.context_sentences}/${cov.total_sentences} sentences)`,
        recommended_actions: cov.uncovered.map(u => `[${u.reason}] ${u.text.slice(0, 60)}`),
      });
    }
  }

  console.log();

  // D-rate
  const dRateTracker = loadDRateTracker(phoenixDir);
  const dRate = dRateTracker.getStatus();
  if (dRate.total_count > 0) {
    const pct = (dRate.rate * 100).toFixed(1);
    let dRateColor: (s: string) => string;
    switch (dRate.level) {
      case DRateLevel.TARGET: dRateColor = green; break;
      case DRateLevel.ACCEPTABLE: dRateColor = green; break;
      case DRateLevel.WARNING: dRateColor = yellow; break;
      case DRateLevel.ALARM: dRateColor = red; break;
    }
    console.log(`  ${dim('D-Rate:')} ${dRateColor(`${pct}%`)} ${dim(`(${dRate.level}, ${dRate.d_count}/${dRate.total_count})`)}`);

    if (dRate.level === DRateLevel.WARNING || dRate.level === DRateLevel.ALARM) {
      if (!machine.shouldSuppressAlarms()) {
        diagnostics.push({
          severity: machine.shouldDowngradeSeverity() ? 'warning' : 'error',
          category: 'd-rate',
          subject: 'Global',
          message: `D-rate ${pct}% (${dRate.level})`,
          recommended_actions: ['Tune classifier or resolve uncertain changes'],
        });
      }
    }
  } else {
    console.log(`  ${dim('D-Rate:')} ${dim('no data')}`);
  }

  // Drift detection
  const manifestManager = new ManifestManager(phoenixDir);
  const manifest = manifestManager.load();
  if (manifest.generated_at) {
    const driftReport = detectDrift(manifest, projectRoot);
    const driftLabel = driftReport.drifted_count === 0 && driftReport.missing_count === 0
      ? green('clean')
      : red(`${driftReport.drifted_count} drifted, ${driftReport.missing_count} missing`);
    console.log(`  ${dim('Drift:')} ${driftLabel} ${dim(`(${driftReport.clean_count} clean)`)}`);

    for (const entry of driftReport.entries) {
      if (entry.status === DriftStatus.DRIFTED) {
        diagnostics.push({
          severity: 'error',
          category: 'drift',
          subject: entry.file_path,
          iu_id: entry.iu_id,
          message: `Working tree differs from generated manifest`,
          recommended_actions: ['Label edit (promote_to_requirement, waiver, or temporary_patch)', 'Or run `phoenix regen` to regenerate'],
        });
      }
      if (entry.status === DriftStatus.MISSING) {
        diagnostics.push({
          severity: 'error',
          category: 'drift',
          subject: entry.file_path,
          iu_id: entry.iu_id,
          message: `Generated file is missing from working tree`,
          recommended_actions: ['Run `phoenix regen` to regenerate'],
        });
      }
    }
  } else {
    console.log(`  ${dim('Drift:')} ${dim('no manifest')}`);
  }

  // Boundary validation
  for (const iu of ius) {
    for (const outputFile of iu.output_files) {
      const fullPath = join(projectRoot, outputFile);
      if (!existsSync(fullPath)) continue;
      const source = readFileSync(fullPath, 'utf8');
      const depGraph = extractDependencies(source, outputFile);
      const boundaryDiags = validateBoundary(depGraph, iu);
      diagnostics.push(...boundaryDiags);
    }
  }

  // Policy evaluation
  const evidenceStore = new EvidenceStore(phoenixDir);
  const allEvidence = evidenceStore.getAll();
  const policyEvals = evaluateAllPolicies(ius, allEvidence);

  let passCount = 0;
  let failCount = 0;
  let incompleteCount = 0;

  for (const eval_ of policyEvals) {
    switch (eval_.verdict) {
      case 'PASS': passCount++; break;
      case 'FAIL': failCount++; break;
      case 'INCOMPLETE': incompleteCount++; break;
    }

    if (eval_.verdict === 'FAIL') {
      diagnostics.push({
        severity: 'error',
        category: 'evidence',
        subject: eval_.iu_name,
        iu_id: eval_.iu_id,
        message: `Evidence failed: ${eval_.failed.join(', ')}`,
        recommended_actions: ['Re-run failing evidence checks', `Risk tier: ${eval_.risk_tier}`],
      });
    } else if (eval_.verdict === 'INCOMPLETE') {
      diagnostics.push({
        severity: 'warning',
        category: 'evidence',
        subject: eval_.iu_name,
        iu_id: eval_.iu_id,
        message: `Missing evidence: ${eval_.missing.join(', ')}`,
        recommended_actions: [`Collect required evidence for ${eval_.risk_tier} tier`],
      });
    }
  }

  console.log(`  ${dim('Evidence:')} ${green(`${passCount} pass`)}, ${failCount > 0 ? red(`${failCount} fail`) : dim(`${failCount} fail`)}, ${incompleteCount > 0 ? yellow(`${incompleteCount} incomplete`) : dim(`${incompleteCount} incomplete`)}`);

  // Cascade effects
  const cascadeEvents = computeCascade(policyEvals, ius);
  if (cascadeEvents.length > 0) {
    console.log(`  ${dim('Cascades:')} ${yellow(`${cascadeEvents.length} active`)}`);
    for (const event of cascadeEvents) {
      for (const action of event.actions) {
        if (action.action === 'BLOCK') {
          diagnostics.push({
            severity: 'error',
            category: 'evidence',
            subject: action.iu_name,
            iu_id: action.iu_id,
            message: `BLOCKED: ${action.reason}`,
            recommended_actions: ['Fix failing evidence before proceeding'],
          });
        } else if (action.action === 'RE_VALIDATE') {
          diagnostics.push({
            severity: 'warning',
            category: 'evidence',
            subject: action.iu_name,
            iu_id: action.iu_id,
            message: `Re-validation needed: ${action.reason}`,
            recommended_actions: ['Re-run typecheck + boundary + tagged tests'],
          });
        }
      }
    }
  } else {
    console.log(`  ${dim('Cascades:')} ${dim('none')}`);
  }

  console.log();

  // Diagnostics table
  console.log(bold('  ─── Diagnostics ───'));
  printDiagnosticTable(diagnostics);
  console.log();

  // Summary line
  const errors = diagnostics.filter(d => d.severity === 'error').length;
  const warnings = diagnostics.filter(d => d.severity === 'warning').length;
  const infos = diagnostics.filter(d => d.severity === 'info').length;

  if (errors === 0 && warnings === 0) {
    console.log(green('  ✔ All clear.'));
  } else {
    const parts: string[] = [];
    if (errors > 0) parts.push(red(`${errors} error${errors !== 1 ? 's' : ''}`));
    if (warnings > 0) parts.push(yellow(`${warnings} warning${warnings !== 1 ? 's' : ''}`));
    if (infos > 0) parts.push(blue(`${infos} info`));
    console.log(`  ${parts.join(', ')}`);
  }
}

function cmdIngest(args: string[]): void {
  const { projectRoot, phoenixDir } = requirePhoenixRoot();
  const specStore = new SpecStore(phoenixDir);
  const verbose = args.includes('-v') || args.includes('--verbose');
  const filteredArgs = args.filter(a => a !== '-v' && a !== '--verbose');

  let files: string[];
  if (filteredArgs.length === 0) {
    files = findSpecFiles(projectRoot);
    if (files.length === 0) {
      console.log(yellow('⚠ No spec files found. Provide a path or add files to spec/.'));
      return;
    }
  } else {
    files = args.map(f => resolve(f));
    for (const f of files) {
      if (!existsSync(f)) {
        console.error(red(`✖ File not found: ${f}`));
        process.exit(1);
      }
    }
  }

  console.log(bold('📥 Spec Ingestion'));
  console.log();

  let totalClauses = 0;
  let totalChanges = 0;

  for (const file of files) {
    const docId = relative(projectRoot, file);

    // Show diff BEFORE ingesting
    const diffs = specStore.diffDocument(file, projectRoot);
    const added = diffs.filter(d => d.diff_type === DiffType.ADDED).length;
    const removed = diffs.filter(d => d.diff_type === DiffType.REMOVED).length;
    const modified = diffs.filter(d => d.diff_type === DiffType.MODIFIED).length;
    const hasChanges = added > 0 || removed > 0 || modified > 0;

    // Now ingest (overwrites stored clauses)
    const result = specStore.ingestDocument(file, projectRoot);
    totalClauses += result.clauses.length;

    if (hasChanges) {
      totalChanges += added + removed + modified;
      console.log(`  ${green('✔')} ${docId} → ${result.clauses.length} clauses`);
      if (added > 0) console.log(`    ${green(`+${added} added`)}`);
      if (removed > 0) console.log(`    ${red(`-${removed} removed`)}`);
      if (modified > 0) console.log(`    ${yellow(`~${modified} modified`)}`);

      // Show which clauses changed
      for (const d of diffs) {
        if (d.diff_type === DiffType.UNCHANGED) continue;
        const pathLabel = d.section_path_after?.join(' > ') || d.section_path_before?.join(' > ') || '';
        const icon = d.diff_type === DiffType.ADDED ? green('+') : d.diff_type === DiffType.REMOVED ? red('-') : yellow('~');
        console.log(`      ${icon} ${pathLabel}`);

        if (verbose && d.diff_type === DiffType.MODIFIED && d.clause_before && d.clause_after) {
          // Show line-level diff of the raw text
          const beforeLines = d.clause_before.raw_text.split('\n');
          const afterLines = d.clause_after.raw_text.split('\n');
          const beforeSet = new Set(beforeLines.map(l => l.trim()));
          const afterSet = new Set(afterLines.map(l => l.trim()));
          for (const line of afterLines) {
            if (!beforeSet.has(line.trim()) && line.trim()) {
              console.log(`        ${green('+ ' + line.trim())}`);
            }
          }
          for (const line of beforeLines) {
            if (!afterSet.has(line.trim()) && line.trim()) {
              console.log(`        ${red('- ' + line.trim())}`);
            }
          }
        } else if (verbose && d.diff_type === DiffType.ADDED && d.clause_after) {
          const lines = d.clause_after.raw_text.split('\n').filter(l => l.trim());
          for (const line of lines.slice(0, 5)) {
            console.log(`        ${green('+ ' + line.trim())}`);
          }
          if (lines.length > 5) console.log(`        ${dim(`... and ${lines.length - 5} more lines`)}`);
        } else if (verbose && d.diff_type === DiffType.REMOVED && d.clause_before) {
          const lines = d.clause_before.raw_text.split('\n').filter(l => l.trim());
          for (const line of lines.slice(0, 5)) {
            console.log(`        ${red('- ' + line.trim())}`);
          }
          if (lines.length > 5) console.log(`        ${dim(`... and ${lines.length - 5} more lines`)}`);
        }
      }
    } else {
      console.log(`  ${green('✔')} ${docId} → ${result.clauses.length} clauses ${dim('(no changes)')}`);
    }
  }

  console.log();
  console.log(`  ${dim(`Total: ${totalClauses} clauses ingested`)}`);
  if (totalChanges > 0) {
    console.log(`  ${dim(`Changes: ${totalChanges} clauses affected`)}`);
    console.log();
    console.log(`  ${dim('Next: run')} ${cyan('phoenix canonicalize')} ${dim('then')} ${cyan('phoenix regen')} ${dim('to update generated code')}`);
  }
}

function cmdDiff(args: string[]): void {
  const { projectRoot, phoenixDir } = requirePhoenixRoot();
  const specStore = new SpecStore(phoenixDir);

  let files: string[];
  if (args.length === 0) {
    files = findSpecFiles(projectRoot);
  } else {
    files = args.map(f => resolve(f));
  }

  console.log(bold('📊 Clause Diff'));
  console.log();

  for (const file of files) {
    if (!existsSync(file)) {
      console.log(red(`  ✖ ${file}: not found`));
      continue;
    }

    const docId = relative(projectRoot, file);
    const diffs = specStore.diffDocument(file, projectRoot);

    const added = diffs.filter(d => d.diff_type === DiffType.ADDED).length;
    const removed = diffs.filter(d => d.diff_type === DiffType.REMOVED).length;
    const modified = diffs.filter(d => d.diff_type === DiffType.MODIFIED).length;
    const moved = diffs.filter(d => d.diff_type === DiffType.MOVED).length;
    const unchanged = diffs.filter(d => d.diff_type === DiffType.UNCHANGED).length;

    console.log(`  ${bold(docId)}`);

    if (diffs.length === 0) {
      console.log(`    ${dim('(no stored clauses to compare against)')}`);
      continue;
    }

    if (added === 0 && removed === 0 && modified === 0 && moved === 0) {
      console.log(`    ${green('✔')} No changes (${unchanged} clauses)`);
      continue;
    }

    if (added > 0) console.log(`    ${green(`+${added} added`)}`);
    if (removed > 0) console.log(`    ${red(`-${removed} removed`)}`);
    if (modified > 0) console.log(`    ${yellow(`~${modified} modified`)}`);
    if (moved > 0) console.log(`    ${blue(`↗${moved} moved`)}`);
    console.log(`    ${dim(`${unchanged} unchanged`)}`);

    // Show details for non-trivial changes
    for (const d of diffs) {
      if (d.diff_type === DiffType.UNCHANGED) continue;
      const pathLabel = d.section_path_after?.join(' > ') || d.section_path_before?.join(' > ') || '';
      switch (d.diff_type) {
        case DiffType.ADDED:
          console.log(`      ${green('+')} ${pathLabel}`);
          break;
        case DiffType.REMOVED:
          console.log(`      ${red('-')} ${pathLabel}`);
          break;
        case DiffType.MODIFIED:
          console.log(`      ${yellow('~')} ${pathLabel}`);
          break;
        case DiffType.MOVED:
          console.log(`      ${blue('↗')} ${d.section_path_before?.join(' > ')} → ${d.section_path_after?.join(' > ')}`);
          break;
      }
    }
    console.log();
  }
}

function cmdClauses(args: string[]): void {
  const { projectRoot, phoenixDir } = requirePhoenixRoot();
  const specStore = new SpecStore(phoenixDir);

  let files: string[];
  if (args.length === 0) {
    files = findSpecFiles(projectRoot);
  } else {
    files = args.map(f => resolve(f));
  }

  console.log(bold('📋 Stored Clauses'));
  console.log();

  for (const file of files) {
    const docId = relative(projectRoot, file);
    const clauses = specStore.getClauses(docId);

    console.log(`  ${bold(docId)} ${dim(`(${clauses.length} clauses)`)}`);
    for (const c of clauses) {
      const path = c.section_path.join(' > ') || '(root)';
      const lines = `L${c.source_line_range[0]}–${c.source_line_range[1]}`;
      const preview = c.normalized_text.slice(0, 80).replace(/\n/g, ' ');
      console.log(`    ${dim(c.clause_id.slice(0, 8))} ${cyan(path)} ${dim(lines)}`);
      console.log(`      ${dim(preview)}${c.normalized_text.length > 80 ? '…' : ''}`);
    }
    console.log();
  }
}

function cmdCanon(): void {
  const { phoenixDir } = requirePhoenixRoot();
  const canonStore = new CanonicalStore(phoenixDir);
  const nodes = canonStore.getAllNodes();

  console.log(bold('📐 Canonical Graph'));
  console.log();
  console.log(`  ${dim(`${nodes.length} nodes`)}`);
  console.log();

  const byType = new Map<string, CanonicalNode[]>();
  for (const node of nodes) {
    const list = byType.get(node.type) || [];
    list.push(node);
    byType.set(node.type, list);
  }

  for (const [type, typeNodes] of byType) {
    const color = type === 'REQUIREMENT' ? green
      : type === 'CONSTRAINT' ? red
      : type === 'INVARIANT' ? magenta
      : blue;
    console.log(`  ${color(bold(type))} (${typeNodes.length})`);
    for (const node of typeNodes) {
      const preview = node.statement.slice(0, 80).replace(/\n/g, ' ');
      const links = node.linked_canon_ids.length > 0
        ? dim(` ← ${node.linked_canon_ids.length} links`)
        : '';
      console.log(`    ${dim(node.canon_id.slice(0, 8))} ${preview}${node.statement.length > 80 ? '…' : ''}${links}`);
    }
    console.log();
  }
}

function cmdPlan(): void {
  const { projectRoot, phoenixDir } = requirePhoenixRoot();
  const canonStore = new CanonicalStore(phoenixDir);
  const specStore = new SpecStore(phoenixDir);

  const canonNodes = canonStore.getAllNodes();
  if (canonNodes.length === 0) {
    console.log(yellow('⚠ No canonical nodes. Run `phoenix bootstrap` or `phoenix ingest` + `phoenix canonicalize` first.'));
    return;
  }

  // Collect clauses
  const allClauses: Clause[] = [];
  const specFiles = findSpecFiles(projectRoot);
  for (const specFile of specFiles) {
    const docId = relative(projectRoot, specFile);
    allClauses.push(...specStore.getClauses(docId));
  }

  const ius = planIUs(canonNodes, allClauses);
  saveIUs(phoenixDir, ius);

  // Inspect the plan BEFORE any generation (O5/O10).
  const report = analyzePlan(ius, canonNodes, allClauses);
  const reportByIu = new Map(report.modules.map(m => [m.iu_id, m]));

  console.log(bold('📦 IU Plan'));
  console.log();
  console.log(`  ${green(`${ius.length} Implementation Units planned`)}`);
  console.log();

  for (const iu of ius) {
    const m = reportByIu.get(iu.iu_id);
    const riskColor = iu.risk_tier === 'critical' ? red
      : iu.risk_tier === 'high' ? yellow
      : iu.risk_tier === 'medium' ? cyan
      : green;
    const flags = `${m?.oversized ? ` ${yellow('⚠ OVERSIZED')}` : ''}${m?.overBudget ? ` ${red('⚠ OVER BUDGET')}` : ''}`;
    console.log(`  ${bold(iu.name)}${flags}`);
    console.log(`    ${dim('ID:')}       ${iu.iu_id.slice(0, 12)}…`);
    console.log(`    ${dim('Risk:')}     ${riskColor(iu.risk_tier)}`);
    console.log(`    ${dim('Kind:')}     ${iu.kind}${m ? ` ${dim('·')} role: ${m.role}` : ''}`);
    console.log(`    ${dim('Sources:')}  ${iu.source_canon_ids.length} canonical nodes${m ? dim(` (~${m.estimate.outputTokens} tok output est.)`) : ''}`);
    console.log(`    ${dim('Output:')}   ${iu.output_files.join(', ')}`);
    if (m && m.headings.length > 0) {
      console.log(`    ${dim('Headings:')} ${m.headings.join(', ')}`);
    }
    console.log(`    ${dim('Evidence:')} ${iu.evidence_policy.required.join(', ')}`);
    if (iu.contract.invariants.length > 0) {
      console.log(`    ${dim('Invariants:')}`);
      for (const inv of iu.contract.invariants) {
        console.log(`      ${dim('·')} ${inv.slice(0, 80)}`);
      }
    }
    console.log();
  }

  // Heading → module mapping (makes one-module-per-heading fragmentation
  // visible before generating — appendix #5).
  console.log(`  ${bold('Heading → Module')}`);
  for (const { heading, module } of report.headingToModule) {
    console.log(`    ${dim(heading)} ${dim('→')} ${module}`);
  }
  console.log();

  if (report.oversizedCount > 0) {
    console.log(`  ${yellow(`⚠ ${report.oversizedCount} module(s) exceed ${report.sizeThreshold} source nodes — generation risk. Consider splitting the spec section.`)}`);
    console.log();
  }

  // Spec-shape feedback (F2/F4): flag heading-structure anti-patterns that will
  // generate poorly, each with the concrete fix, before any code is generated.
  if (report.warnings.length > 0) {
    console.log(`  ${bold(yellow(`⚠ Spec-shape warnings (${report.warnings.length})`))}`);
    for (const w of report.warnings) {
      console.log(`    ${yellow('•')} ${w.message}`);
      console.log(`      ${dim('→ fix:')} ${w.remediation}`);
    }
    console.log();
    console.log(`  ${dim('See docs/SPEC-SHAPE.md for the heading → module rule.')}`);
    console.log();
  } else {
    console.log(`  ${green(`✓ Spec shape looks good — ${ius.length} module(s).`)}`);
    console.log();
  }
}

async function cmdRegen(args: string[]): Promise<void> {
  const { projectRoot, phoenixDir } = requirePhoenixRoot();
  const ius = loadIUs(phoenixDir);

  if (ius.length === 0) {
    console.log(yellow('⚠ No IUs planned. Run `phoenix plan` first.'));
    return;
  }

  // Parse --iu=<id> flag and --stubs flag
  const iuFilter = args.find(a => a.startsWith('--iu='))?.split('=')[1];
  const forceStubs = args.includes('--stubs');
  const targetIUs = iuFilter
    ? ius.filter(iu => iu.iu_id.startsWith(iuFilter) || iu.name === iuFilter)
    : ius;

  if (targetIUs.length === 0) {
    console.log(red(`✖ No IU matching: ${iuFilter}`));
    return;
  }

  const llm = forceStubs ? null : resolveProvider(phoenixDir);
  const canonStore = new CanonicalStore(phoenixDir);
  const canonNodes = canonStore.getAllNodes();

  console.log(bold('⚡ Code Regeneration'));
  if (llm) {
    for (const line of describeResolution(resolveProviderInfo(phoenixDir))) {
      console.log(`  ${line.startsWith('⚠') ? yellow(line) : dim(line)}`);
    }
  } else {
    const { hint } = describeAvailability();
    console.log(`  ${dim('Mode: stubs')}${forceStubs ? '' : ` ${dim('—')} ${dim(hint)}`}`);
  }
  console.log();

  // Load architecture
  const configPath = join(phoenixDir, 'config.json');
  let regenArch: ResolvedTarget | null = null;
  if (existsSync(configPath)) {
    try {
      const cfg = JSON.parse(readFileSync(configPath, 'utf8'));
      if (cfg.architecture) regenArch = resolveTarget(cfg.architecture);
    } catch { /* ignore */ }
  }

  const regenInterfaces = deriveInterfaces(ius, canonNodes, regenArch);

  // Journal + bounds make a single-module regen observable and capturable (G1/G4):
  // the call lifecycle is recorded and a runaway is bounded + its partial output
  // preserved — so the hard module can be reproduced and diagnosed in a minute.
  const policy = loadPolicy(phoenixDir);
  const regenJournal = llm ? new RunJournal(phoenixDir) : undefined;
  regenJournal?.startRun({ command: 'regen', provider: `${llm!.name}/${llm!.model}`, ius: targetIUs.map(i => i.name) });

  const regenCtx: RegenContext = {
    llm: llm ?? undefined,
    canonNodes,
    allIUs: ius,
    projectRoot,
    target: regenArch,
    interfaces: regenInterfaces,
    journal: regenJournal,
    budgets: regenJournal ? policy.budgets : undefined,
    maxRetries: policy.maxRetries,
    maxRepairs: policy.maxRepairs,
    backoffMs: policy.backoffMs,
    modelsByRole: resolveModelsByRole(phoenixDir, llm?.name), // per-role model (G2)
    onProgress: (iu, status, msg) => {
      if (status === 'start') process.stdout.write(`  ⏳ ${msg ?? iu.name}…`);
      else if (status === 'done') process.stdout.write(` ${green('✔')}\n`);
      else if (status === 'error') process.stdout.write(` ${red('✖')} ${dim(msg || 'failed, using stub')}\n`);
    },
  };

  const manifestManager = new ManifestManager(phoenixDir);
  const results = await generateAll(targetIUs, regenCtx);
  regenJournal?.endRun(results.some(r => r.failed) ? 'failed' : 'ok');

  // Per-module diagnostic readout from the journal: output bytes, duration, stop
  // reason, model — so the large-module behavior is visible without a full run (G1).
  const callByTarget = new Map<string, ReturnType<RunJournal['callList']>[number]>();
  for (const c of regenJournal?.callList() ?? []) callByTarget.set(c.target ?? '', c);
  const readout = (iuName: string): string => {
    const c = callByTarget.get(iuName);
    if (!c) return '';
    const ms = c.endedAt && c.startedAt ? c.endedAt - c.startedAt : undefined;
    // First-content latency (D1): with OP1, ttfbAt marks the first content token —
    // for opus this is its think time, used to tune PHOENIX_OPUS_FIRST_CONTENT_MS.
    const ttfbMs = c.ttfbAt && c.startedAt ? c.ttfbAt - c.startedAt : undefined;
    const parts = [
      `${c.bytesStreamed} B`,
      ms !== undefined ? `${(ms / 1000).toFixed(1)}s` : undefined,
      ttfbMs !== undefined ? `ttfb:${(ttfbMs / 1000).toFixed(1)}s` : undefined,
      c.stopReason ? `stop:${c.stopReason}` : `outcome:${c.outcome}`,
      `model:${c.model}`,
    ].filter(Boolean);
    return dim(`    (${parts.join(' · ')})`);
  };

  for (const result of results) {
    const iu = targetIUs.find(i => i.iu_id === result.iu_id);
    const name = iu?.name || result.iu_id.slice(0, 12);
    // A hard-failed module (over the output-token budget T3, or the generation
    // bounds G4) produced no usable output — write nothing, report the remediation
    // and the captured partial-output path, and exit non-zero.
    if (result.failed) {
      console.log(`  ${red('✖')} ${name}: ${dim(result.failed.remediation)}`);
      if (result.failed.partialPath) console.log(`    ${dim('captured partial output →')} ${cyan(result.failed.partialPath)}`);
      const r = readout(name);
      if (r) console.log(r);
      process.exitCode = 1;
      continue;
    }
    for (const [filePath, content] of result.files) {
      const fullPath = join(projectRoot, filePath);
      mkdirSync(join(fullPath, '..'), { recursive: true });
      writeFileSync(fullPath, content, 'utf8');
    }
    manifestManager.recordIU(result.manifest);

    console.log(`  ${green('✔')} ${name}`);
    const r = readout(name);
    if (r) console.log(r);
    if (!llm) {
      for (const [filePath] of result.files) console.log(`    → ${cyan(filePath)}`);
    }
  }
  if (regenJournal) console.log(`  ${dim(`run: ${regenJournal.runId} — inspect with`)} ${cyan(`phoenix runs ${regenJournal.runId}`)}`);

  // Re-generate scaffold wiring
  const allIUs = loadIUs(phoenixDir);
  const allInterfaces = deriveInterfaces(allIUs, canonNodes, regenArch);
  const services = deriveServices(allIUs);
  const scaffold = generateScaffold(services, basename(projectRoot), regenArch, allInterfaces);
  const forceScaffold = args.includes('--force-scaffold');
  const scaffoldReport = writeScaffoldFiles(projectRoot, phoenixDir, scaffold.files, { force: forceScaffold });
  printScaffoldReport(scaffoldReport);

  console.log();
  console.log(`  ${dim(`${results.length} IU(s) regenerated. Scaffold updated.`)}`);
}

/** Print a preflight report (O9): pass/fail per assumption with remediation. */
function printPreflight(result: PreflightResult): void {
  console.log(bold('🚦 Preflight'));
  for (const c of result.checks) {
    const mark = c.ok ? green('✔') : red('✖');
    console.log(`  ${mark} ${c.name}: ${c.ok ? dim(c.detail) : c.detail}`);
    if (!c.ok && c.remediation) console.log(`      ${yellow('→')} ${yellow(c.remediation)}`);
  }
  console.log();
  console.log(result.ok ? green('  All preflight checks passed.') : red('  Preflight failed — fix the above before running.'));
}

function cmdPreflight(args: string[]): void {
  const { projectRoot, phoenixDir } = requirePhoenixRoot();
  // Derive architecture-conditional checks from the bound architecture (like run),
  // not a manual flag: the C-toolchain requirement is a property of the chosen
  // arch's native deps. Unbound ⇒ nothing architecture-derived is asserted (DC5).
  const configPath = join(phoenixDir, 'config.json');
  let arch: ResolvedTarget | null = null;
  if (existsSync(configPath)) {
    try {
      const config = JSON.parse(readFileSync(configPath, 'utf8'));
      if (config.architecture) arch = resolveTarget(config.architecture);
    } catch { /* ignore */ }
  }
  const result = preflight({
    projectRoot,
    phoenixDir,
    requireProvider: !args.includes('--no-provider'),
    minNodeMajor: arch?.runtime.minNodeMajor,
    requireNativeBuild: (arch?.runtime.nativeDeps?.length ?? 0) > 0,
  });
  printPreflight(result);
  if (!result.ok) process.exitCode = 1;
}

/**
 * Unattended supervised run: spec → running, verified app (O15/O16).
 * Preflight-gates, then runs the pipeline under lock/journal/watchdog/policy.
 */
async function cmdRun(args: string[]): Promise<void> {
  const { projectRoot, phoenixDir } = requirePhoenixRoot();
  const dryRun = args.includes('--dry-run');
  const noResume = args.includes('--no-resume');
  const forceScaffold = args.includes('--force-scaffold');
  const runtimeChecks = args.includes('--runtime-checks');
  const install = !args.includes('--no-install');
  const policy = loadPolicy(phoenixDir);

  console.log(bold('🚀 Phoenix Run'));
  console.log();

  // Resolve architecture (same as bootstrap).
  let arch: ResolvedTarget | null = null;
  const configPath = join(phoenixDir, 'config.json');
  if (existsSync(configPath)) {
    try {
      const config = JSON.parse(readFileSync(configPath, 'utf8'));
      if (config.architecture) arch = resolveTarget(config.architecture);
    } catch { /* ignore */ }
  }

  // Preflight (O9) — abort fast with a fix list. Runtime/native requirements
  // come from the selected architecture's declared contract (A1/A4), not from
  // "is any arch selected": only require a C toolchain when the arch declares a
  // native dependency.
  const pf = preflight({
    projectRoot,
    phoenixDir,
    requireProvider: true,
    minNodeMajor: arch?.runtime.minNodeMajor,
    requireNativeBuild: (arch?.runtime.nativeDeps?.length ?? 0) > 0,
  });
  printPreflight(pf);
  console.log();
  if (!pf.ok && !dryRun) {
    console.log(red('✖ Preflight failed — aborting before any generation.'));
    process.exitCode = 1;
    return;
  }

  if (dryRun) {
    console.log(bold('📋 Policy (dry-run)'));
    for (const line of describePolicy(policy)) console.log(`  ${dim(line)}`);
    console.log();
    return;
  }

  // Ingest specs so the pipeline has fresh clauses.
  const specStore = new SpecStore(phoenixDir);
  const specFiles = findSpecFiles(projectRoot);
  for (const f of specFiles) specStore.ingestDocument(f, projectRoot);
  const clauses: Clause[] = [];
  for (const f of specFiles) clauses.push(...specStore.getClauses(relative(projectRoot, f)));

  const llm = resolveProvider(phoenixDir);

  let result;
  try {
    result = await runSupervised({
      projectRoot, phoenixDir, clauses, arch, llm, policy,
      resume: !noResume,
      forceScaffold,
      runtimeChecks,
      install,
      log: (msg) => console.log(`  ${dim(msg)}`),
    });
  } catch (err) {
    if (err instanceof AlreadyRunningError) {
      console.log(red(`✖ ${err.message}`));
      process.exitCode = 1;
      return;
    }
    throw err;
  }

  console.log();
  if (result.ok) {
    console.log(green(`✔ Run ${result.runId} complete — app verified.`));
  } else {
    console.log(red(`✖ Run ${result.runId} not done${result.failedStage ? ` (failed: ${result.failedStage})` : ''}${result.error ? ` — ${result.error}` : ''}.`));
    process.exitCode = 1;
  }
}

/** Inspect persisted runs (O15: answer the three questions post-hoc). */
function cmdRuns(args: string[]): void {
  const { phoenixDir } = requirePhoenixRoot();
  const wanted = args.find(a => !a.startsWith('-'));
  const runIds = RunJournal.listRuns(phoenixDir);
  if (runIds.length === 0) {
    console.log(yellow('⚠ No runs recorded yet. Run `phoenix run`.'));
    return;
  }

  if (!wanted) {
    console.log(bold('🗂  Runs'));
    for (const id of runIds.slice(0, 20)) {
      const snap = RunJournal.readState(phoenixDir, id);
      const outcome = snap?.outcome ?? (snap?.endedAt ? 'done' : 'in-progress');
      console.log(`  ${id} ${dim(`· ${outcome} · ${snap?.calls.length ?? 0} calls`)}`);
    }
    console.log();
    console.log(dim('  phoenix runs <runId> for details'));
    return;
  }

  const snap = RunJournal.readState(phoenixDir, wanted);
  if (!snap) {
    console.log(red(`✖ No such run: ${wanted}`));
    process.exitCode = 1;
    return;
  }
  console.log(bold(`🗂  Run ${snap.runId}`));
  for (const line of renderRunStatus(snap)) console.log(`  ${line}`);
  console.log();
  console.log(bold('  Stages'));
  for (const s of snap.stages) {
    const dur = s.endedAt ? `${Math.round((s.endedAt - s.startedAt) / 1000)}s` : 'running';
    console.log(`    ${s.outcome === 'failed' ? red('✖') : green('✔')} ${s.name} ${dim(`(${dur})`)}`);
  }
}

function cmdDrift(): void {
  const { projectRoot, phoenixDir } = requirePhoenixRoot();
  const manifestManager = new ManifestManager(phoenixDir);
  const manifest = manifestManager.load();

  if (!manifest.generated_at) {
    console.log(yellow('⚠ No generated manifest. Run `phoenix regen` first.'));
    return;
  }

  const report = detectDrift(manifest, projectRoot);

  console.log(bold('🔍 Drift Detection'));
  console.log();

  if (report.drifted_count === 0 && report.missing_count === 0) {
    console.log(`  ${green('✔')} ${report.summary}`);
  } else {
    console.log(`  ${red('✖')} ${report.summary}`);
  }
  console.log();

  for (const entry of report.entries) {
    switch (entry.status) {
      case DriftStatus.CLEAN:
        console.log(`  ${green('✔')} ${entry.file_path}`);
        break;
      case DriftStatus.DRIFTED:
        console.log(`  ${red('✖')} ${entry.file_path} ${red('DRIFTED')}`);
        console.log(`    ${dim('expected:')} ${entry.expected_hash?.slice(0, 12)}…`);
        console.log(`    ${dim('actual:')}   ${entry.actual_hash?.slice(0, 12)}…`);
        console.log(`    ${dim('→ Label this edit: promote_to_requirement | waiver | temporary_patch')}`);
        break;
      case DriftStatus.MISSING:
        console.log(`  ${red('✖')} ${entry.file_path} ${red('MISSING')}`);
        console.log(`    ${dim('→ Run `phoenix regen` to regenerate')}`);
        break;
      case DriftStatus.WAIVED:
        console.log(`  ${yellow('⚠')} ${entry.file_path} ${yellow('WAIVED')}`);
        if (entry.waiver) {
          console.log(`    ${dim('kind:')} ${entry.waiver.kind}`);
          console.log(`    ${dim('reason:')} ${entry.waiver.reason}`);
        }
        break;
    }
  }
}

/**
 * Compare web-ui generation strategies in ONE command (#27): generate the web-ui module body
 * under each listed strategy (skipping aux test-gen + the typecheck-repair loop for a fair raw
 * comparison), per-output typecheck each, and print a table. Cost = N × web-ui generation only.
 */
async function cmdWebUICompare(args: string[]): Promise<void> {
  const { projectRoot, phoenixDir } = requirePhoenixRoot();
  const list = args.find(a => !a.startsWith('-'));
  const names = (list ? list.split(',') : Object.keys(WEBUI_STRATEGIES)).filter(n => WEBUI_STRATEGIES[n]);
  if (names.length === 0) {
    console.log(red(`✖ No valid strategies. Available: ${Object.keys(WEBUI_STRATEGIES).join(', ')}`));
    process.exitCode = 1; return;
  }
  const ius = loadIUs(phoenixDir);
  if (ius.length === 0) { console.log(yellow('⚠ No IUs planned. Run `phoenix plan` first.')); return; }
  const llm = resolveProvider(phoenixDir);
  if (!llm) { console.log(red('✖ webui-compare needs an LLM provider.')); process.exitCode = 1; return; }

  let arch: ResolvedTarget | null = null;
  const configPath = join(phoenixDir, 'config.json');
  if (existsSync(configPath)) {
    try { const cfg = JSON.parse(readFileSync(configPath, 'utf8')); if (cfg.architecture) arch = resolveTarget(cfg.architecture); } catch { /* ignore */ }
  }
  const canonNodes = new CanonicalStore(phoenixDir).getAllNodes();
  const interfaces = deriveInterfaces(ius, canonNodes, arch);
  const webIUs = ius.filter(iu => interfaces.find(e => e.iu_id === iu.iu_id)?.role === 'web-ui');
  if (webIUs.length === 0) { console.log(yellow('⚠ No web-ui module in the plan.')); return; }
  const policy = loadPolicy(phoenixDir);
  const probe = probeTypechecker(projectRoot);

  console.log(bold(`\n🔬 web-ui strategy comparison — ${names.join(', ')}\n`));
  const prevStrategy = process.env.PHOENIX_WEBUI_STRATEGY;
  const prevTokens = process.env.PHOENIX_WEBUI_SLICE_TOKENS;
  process.env.PHOENIX_WEBUI_SLICE_TOKENS = '0'; // force the strategy path regardless of size

  try {
    for (const iu of webIUs) {
      const original = existsSync(join(projectRoot, iu.output_files[0]))
        ? readFileSync(join(projectRoot, iu.output_files[0]), 'utf8') : null;
      console.log(bold(`  ${iu.name}`));
      console.log(`  ${dim('strategy        general  calls  first-token  bytes   typechecks  result')}`);
      for (const name of names) {
        process.env.PHOENIX_WEBUI_STRATEGY = name;
        let metrics: WebUIMetrics | undefined;
        let body: string | undefined; let failReason: string | undefined;
        const journal = new RunJournal(phoenixDir);
        journal.startRun({ command: 'webui-compare', provider: `${llm.name}/${llm.model}`, strategy: name });
        try {
          const res = await generateIU(iu, {
            llm, canonNodes, allIUs: ius, target: arch, interfaces, journal,
            budgets: policy.budgets, maxRetries: policy.maxRetries, backoffMs: policy.backoffMs,
            modelsByRole: resolveModelsByRole(phoenixDir, llm.name),
            skipAuxGeneration: true,                 // compare the body only, not tests/scenarios
            onWebUIMetrics: (m) => { metrics = m; },
          });
          if (res.failed) failReason = res.failed.reason;
          else body = res.files.get(iu.output_files[0]);
        } catch (e) { failReason = e instanceof Error ? e.message : String(e); }
        journal.endRun(failReason ? 'failed' : 'ok');

        let typechecks: string;
        if (body && probe.available) {
          typechecks = typecheckFile(projectRoot, iu.output_files[0], body, probe).status === 'clean' ? green('✓') : red('✗');
        } else typechecks = dim('—');

        const m = metrics;
        const general = WEBUI_STRATEGIES[name].general ? 'yes' : red('NO');
        const ft = m?.reachedFirstToken ? green('✓') : red('✗ stall');
        const kb = body ? `${Math.round(Buffer.byteLength(body, 'utf8') / 1024)} KB` : dim('—');
        const result = failReason ? red(failReason) : green('ok');
        console.log(`  ${name.padEnd(15)} ${general.padEnd(8)} ${String(m?.calls ?? 0).padEnd(6)} ${ft.padEnd(11)} ${kb.padEnd(7)} ${typechecks.padEnd(11)} ${result}`);
      }
      // Restore the original web-ui file (typecheck overwrote it with the last candidate).
      if (original !== null) writeFileSync(join(projectRoot, iu.output_files[0]), original, 'utf8');
      console.log();
    }
  } finally {
    if (prevStrategy === undefined) delete process.env.PHOENIX_WEBUI_STRATEGY; else process.env.PHOENIX_WEBUI_STRATEGY = prevStrategy;
    if (prevTokens === undefined) delete process.env.PHOENIX_WEBUI_SLICE_TOKENS; else process.env.PHOENIX_WEBUI_SLICE_TOKENS = prevTokens;
  }
  console.log(dim('  (generation comparison only — run `phoenix run --runtime-checks` on the winner to verify boot + ui_behavior)\n'));
}

/** List the web-ui generation strategies (#27), tagged general vs spec-specific, with the active one. */
function cmdWebUIStrategies(): void {
  const active = process.env.PHOENIX_WEBUI_STRATEGY ?? 'plan-split';
  console.log('\nWeb-UI generation strategies (#27 experiment harness)\n');
  for (const [name, s] of Object.entries(WEBUI_STRATEGIES)) {
    const tag = s.general ? green('general') : yellow('spec-specific');
    const mark = name === active ? blue(' ← active') : '';
    console.log(`  ${name.padEnd(14)} ${tag}${mark}`);
  }
  console.log('\n  select with PHOENIX_WEBUI_STRATEGY=<name> (default: plan-split)');
  console.log('  per-run metrics are journalled as `webui_strategy` — run the same spec under each to A/B.\n');
}

async function cmdCanonicalize(): Promise<void> {
  const { projectRoot, phoenixDir } = requirePhoenixRoot();
  const specStore = new SpecStore(phoenixDir);
  const canonStore = new CanonicalStore(phoenixDir);

  const allClauses: Clause[] = [];
  const specFiles = findSpecFiles(projectRoot);
  for (const specFile of specFiles) {
    const docId = relative(projectRoot, specFile);
    allClauses.push(...specStore.getClauses(docId));
  }

  if (allClauses.length === 0) {
    console.log(yellow('⚠ No ingested clauses. Run `phoenix ingest` first.'));
    return;
  }

  const llm = resolveProvider(phoenixDir);
  console.log(bold('📐 Canonicalization'));
  for (const line of describeResolution(resolveProviderInfo(phoenixDir))) {
    console.log(`  ${line.startsWith('⚠') ? yellow(line) : dim(line)}`);
  }
  console.log();

  const canon = await canonicalize(allClauses, llm);
  const canonNodes = canon.nodes;
  canonStore.saveNodes(canonNodes);

  const modeLabel = canon.stats.mode === 'llm-normalized'
    ? `LLM-normalized ${canon.stats.llmNodeCount}/${canonNodes.length}`
    : 'rule-based';
  console.log(`  ${green('✔')} ${canonNodes.length} canonical nodes extracted from ${allClauses.length} clauses (${modeLabel})`);

  const byType = new Map<string, number>();
  for (const node of canonNodes) {
    byType.set(node.type, (byType.get(node.type) || 0) + 1);
  }
  for (const [type, count] of byType) {
    console.log(`    ${dim('·')} ${type}: ${count}`);
  }

  // Compute warm hashes
  const warmHashes = computeWarmHashes(allClauses, canonNodes);
  const warmPath = join(phoenixDir, 'graphs', 'warm-hashes.json');
  const warmObj: Record<string, string> = {};
  for (const [k, v] of warmHashes) warmObj[k] = v;
  writeFileSync(warmPath, JSON.stringify(warmObj, null, 2), 'utf8');

  console.log(`  ${green('✔')} ${warmHashes.size} warm context hashes computed`);
}

function cmdEvaluate(args: string[]): void {
  const { phoenixDir } = requirePhoenixRoot();
  const ius = loadIUs(phoenixDir);
  const evidenceStore = new EvidenceStore(phoenixDir);
  const allEvidence = evidenceStore.getAll();

  const iuFilter = args.find(a => a.startsWith('--iu='))?.split('=')[1];
  const targetIUs = iuFilter
    ? ius.filter(iu => iu.iu_id.startsWith(iuFilter) || iu.name === iuFilter)
    : ius;

  const evals = evaluateAllPolicies(targetIUs, allEvidence);

  console.log(bold('📋 Policy Evaluation'));
  console.log();

  for (const eval_ of evals) {
    const verdictColor = eval_.verdict === 'PASS' ? green
      : eval_.verdict === 'FAIL' ? red
      : yellow;

    console.log(`  ${verdictColor(eval_.verdict)} ${bold(eval_.iu_name)} ${dim(`(${eval_.risk_tier})`)}`);
    if (eval_.satisfied.length > 0) {
      console.log(`    ${green('✔')} ${eval_.satisfied.join(', ')}`);
    }
    if (eval_.missing.length > 0) {
      console.log(`    ${yellow('○')} Missing: ${eval_.missing.join(', ')}`);
    }
    if (eval_.failed.length > 0) {
      console.log(`    ${red('✖')} Failed: ${eval_.failed.join(', ')}`);
    }
    console.log();
  }
}

function cmdCascade(): void {
  const { phoenixDir } = requirePhoenixRoot();
  const ius = loadIUs(phoenixDir);
  const evidenceStore = new EvidenceStore(phoenixDir);
  const allEvidence = evidenceStore.getAll();
  const evals = evaluateAllPolicies(ius, allEvidence);
  const cascadeEvents = computeCascade(evals, ius);

  console.log(bold('🌊 Cascade Effects'));
  console.log();

  if (cascadeEvents.length === 0) {
    console.log(`  ${green('✔')} No cascading failures.`);
    return;
  }

  for (const event of cascadeEvents) {
    console.log(`  ${red('✖')} ${bold(event.source_iu_name)} (${event.failure_kind})`);
    for (const action of event.actions) {
      const icon = action.action === 'BLOCK' ? red('⊘') : yellow('↻');
      console.log(`    ${icon} ${action.iu_name}: ${action.action}`);
      console.log(`      ${dim(action.reason)}`);
    }
    console.log();
  }
}

function cmdBot(args: string[]): void {
  if (args.length === 0) {
    // Show all bot commands
    const commands = getAllCommands();
    console.log(bold('🤖 Phoenix Bots'));
    console.log();
    for (const [bot, cmds] of Object.entries(commands)) {
      console.log(`  ${bold(bot)}: ${cmds.join(', ')}`);
    }
    console.log();
    console.log(dim('  Usage: phoenix bot "BotName: action arg=value"'));
    return;
  }

  const raw = args.join(' ');
  const parsed = parseCommand(raw);

  if ('error' in parsed) {
    console.error(red(`✖ ${parsed.error}`));
    process.exit(1);
  }

  const response = routeCommand(parsed);

  console.log(bold(`🤖 ${response.bot}`));
  console.log();
  console.log(`  ${response.message}`);

  if (response.mutating && response.confirm_id) {
    console.log();
    console.log(dim(`  Confirmation ID: ${response.confirm_id}`));
  }
}

function cmdGraph(): void {
  const { phoenixDir } = requirePhoenixRoot();
  const canonStore = new CanonicalStore(phoenixDir);
  const graph = canonStore.getGraph();
  const ius = loadIUs(phoenixDir);

  console.log(bold('🕸️  Provenance Graph'));
  console.log();

  // Clause → Canon
  const provenanceCount = Object.values(graph.provenance).reduce((sum, arr) => sum + arr.length, 0);
  console.log(`  ${dim('Provenance edges:')} ${provenanceCount}`);
  console.log(`  ${dim('Canon → Canon links:')} ${Object.values(graph.nodes).reduce((sum, n) => sum + n.linked_canon_ids.length, 0)}`);
  console.log(`  ${dim('Canon → IU mappings:')} ${ius.reduce((sum, iu) => sum + iu.source_canon_ids.length, 0)}`);
  console.log();

  // Show IU dependency graph
  if (ius.length > 0) {
    console.log(`  ${bold('IU Dependency Graph:')}`);
    for (const iu of ius) {
      const deps = iu.dependencies.length > 0
        ? iu.dependencies.map(d => {
            const dep = ius.find(i => i.iu_id === d);
            return dep?.name || d.slice(0, 8);
          }).join(', ')
        : dim('(none)');
      console.log(`    ${iu.name} → ${deps}`);
    }
  }
}

async function cmdInspect(args: string[]): Promise<void> {
  const { projectRoot, phoenixDir } = requirePhoenixRoot();
  const machine = loadBootstrapState(phoenixDir);
  const ius = loadIUs(phoenixDir);
  const canonStore = new CanonicalStore(phoenixDir);
  const canonNodes = canonStore.getAllNodes();
  const specStore = new SpecStore(phoenixDir);
  const manifestManager = new ManifestManager(phoenixDir);
  const manifest = manifestManager.load();

  // Collect all clauses
  const allClauses: Clause[] = [];
  const specFiles = findSpecFiles(projectRoot);
  for (const specFile of specFiles) {
    const docId = relative(projectRoot, specFile);
    allClauses.push(...specStore.getClauses(docId));
  }

  // Drift
  let driftReport = null;
  if (manifest.generated_at) {
    driftReport = detectDrift(manifest, projectRoot);
  }

  const projectName = basename(projectRoot);
  const data = collectInspectData(
    projectName,
    machine.getState(),
    allClauses,
    canonNodes,
    ius,
    manifest,
    driftReport,
    projectRoot,
  );

  const html = renderInspectHTML(data);
  const dataJson = JSON.stringify(data);

  // Parse --port flag
  const portArg = args.find(a => a.startsWith('--port='))?.split('=')[1];
  const port = portArg ? parseInt(portArg, 10) : 0; // 0 = random

  const instance = serveInspect(html, port, dataJson);
  await instance.ready;

  console.log();
  console.log(bold('🔥 Phoenix Inspect'));
  console.log();
  console.log(`  ${cyan(`http://localhost:${instance.port}`)}`);
  console.log();
  console.log(`  ${dim(`${data.stats.specFiles} specs → ${data.stats.clauses} clauses → ${data.stats.canonNodes} canon → ${data.stats.ius} IUs → ${data.stats.generatedFiles} files`)}`);
  console.log(`  ${dim(`${data.stats.edgeCount} provenance edges`)}`);
  console.log();
  console.log(dim('  Press Ctrl+C to stop.'));

  // Keep process alive
  await new Promise(() => {});
}

// ─── Replacement Audit (Fowler Ch. 4) ────────────────────────────────────────

function cmdAudit(args: string[]): void {
  const { phoenixDir } = requirePhoenixRoot();
  const ius = loadIUs(phoenixDir);
  const evalStore = new EvaluationStore(phoenixDir);
  const nkStore = new NegativeKnowledgeStore(phoenixDir);

  if (ius.length === 0) {
    console.log(yellow('⚠ No Implementation Units found. Run `phoenix plan` first.'));
    return;
  }

  // Build coverage map
  const evalCoverages = new Map<string, any>();
  for (const iu of ius) {
    evalCoverages.set(iu.iu_id, evalStore.coverage(iu));
  }

  // Load pace layers (from iu metadata or defaults)
  const paceLayers = new Map<string, PaceLayerMetadata>();
  // TODO: load from .phoenix/pace-layers.json when populated

  const nk = nkStore.getActive();
  const previousMasses = new Map<string, number>();
  // TODO: load from previous manifest cycle

  // Filter by --iu if specified
  const iuArg = args.find(a => a.startsWith('--iu='));
  const targetIUs = iuArg
    ? ius.filter(iu => iu.iu_id === iuArg.slice(5) || iu.name === iuArg.slice(5))
    : ius;

  const results = auditAll(targetIUs, evalCoverages, paceLayers, nk, previousMasses);

  console.log();
  console.log(bold('🔥 Phoenix Replacement Audit'));
  console.log(dim('  "Could I replace this implementation entirely and have its dependents not notice?"'));
  console.log();

  // Summary counts
  const readinessCounts: Record<ReadinessLevel, number> = {
    regenerable: 0, evaluable: 0, observable: 0, opaque: 0,
  };
  for (const r of results) readinessCounts[r.readiness]++;

  console.log(
    `  ${green(`● ${readinessCounts.regenerable} regenerable`)}  ` +
    `${blue(`◐ ${readinessCounts.evaluable} evaluable`)}  ` +
    `${yellow(`○ ${readinessCounts.observable} observable`)}  ` +
    `${red(`◌ ${readinessCounts.opaque} opaque`)}`
  );
  console.log();

  // Per-IU details
  for (const result of results) {
    const readinessIcon = readinessToIcon(result.readiness);
    const scoreColor = result.score >= 75 ? green : result.score >= 50 ? yellow : red;

    console.log(`  ${readinessIcon} ${bold(result.iu_name)} ${dim(`(${result.iu_id})`)} — ${scoreColor(`${result.score}/100`)} ${dim(result.readiness)}`);

    // Dimension summary
    const dims = [
      result.boundary_clarity,
      result.evaluation_coverage,
      result.blast_radius,
      result.deletion_safety,
      result.pace_layer,
      result.conceptual_mass,
      result.negative_knowledge,
    ];
    for (const d of dims) {
      const icon = d.status === 'good' ? green('✓') : d.status === 'warning' ? yellow('⚠') : red('✖');
      console.log(`    ${icon} ${dim(d.name + ':')} ${d.detail}`);
    }

    // Blockers
    if (result.blockers.length > 0) {
      console.log(`    ${red('Blockers:')}`);
      for (const b of result.blockers) {
        const sev = b.severity === 'error' ? red('✖') : yellow('⚠');
        console.log(`      ${sev} ${b.message}`);
        console.log(`        ${dim('→ ' + b.recommended_action)}`);
      }
    }

    // Recommendations
    if (result.recommendations.length > 0) {
      console.log(`    ${cyan('Recommendations:')}`);
      for (const r of result.recommendations) {
        console.log(`      ${dim('→')} ${r}`);
      }
    }

    console.log();
  }

  // Overall verdict
  const totalScore = results.length > 0
    ? Math.round(results.reduce((sum, r) => sum + r.score, 0) / results.length)
    : 0;
  const totalBlockers = results.reduce((sum, r) => sum + r.blockers.length, 0);

  console.log(dim('  ─────────────────────────────────────────'));
  console.log(`  ${bold('Overall:')} ${totalScore}/100 avg score, ${totalBlockers} blocker(s)`);
  console.log(`  ${dim('Trust > cleverness.')}`);
  console.log();
}

function readinessToIcon(readiness: ReadinessLevel): string {
  switch (readiness) {
    case 'regenerable': return green('●');
    case 'evaluable': return blue('◐');
    case 'observable': return yellow('○');
    case 'opaque': return red('◌');
  }
}

function cmdVersion(): void {
  console.log(`Phoenix VCS v${VERSION}`);
}

function cmdHelp(): void {
  console.log(`
${bold('🔥 Phoenix VCS')} — Regenerative Version Control
${dim(`v${VERSION}`)}

${bold('Usage:')} phoenix <command> [options]

${bold('Getting Started:')}
  ${cyan('init')}                 Initialize a new Phoenix project
  ${cyan('bootstrap')}            Full bootstrap: ingest → canonicalize → plan → generate
  ${cyan('run')}                  Unattended supervised run (journal, watchdog, acceptance gate)
                         ${dim('--dry-run  Print preflight + policy without generating')}
                         ${dim('--no-resume / --force-scaffold / --runtime-checks')}
  ${cyan('preflight')}            Verify the toolchain before a run (O9)
  ${cyan('runs')} [runId]         Inspect supervised run journals (O15)

${bold('Spec Management:')}
  ${cyan('ingest')} [files...]     Ingest spec documents (default: all in spec/)
  ${cyan('diff')} [files...]       Show clause diffs vs stored state
  ${cyan('clauses')} [files...]    List stored clauses

${bold('Canonical Graph:')}
  ${cyan('canonicalize')}          Extract canonical nodes from ingested clauses
  ${cyan('canon')}                 Show the canonical graph

${bold('Implementation:')}
  ${cyan('plan')}                  Plan Implementation Units from canonical graph
  ${cyan('regen')} [--iu=<id>]    Regenerate code (all or specific IU)
                         ${dim('Uses LLM if ANTHROPIC_API_KEY or OPENAI_API_KEY is set')}
                         ${dim('--stubs  Force stub generation (skip LLM)')}

${bold('Verification:')}
  ${cyan('status')}                Trust dashboard — the primary UX
  ${cyan('drift')}                 Check generated files for drift
  ${cyan('evaluate')} [--iu=<id>] Evaluate evidence against policy
  ${cyan('cascade')}               Show cascade failure effects
  ${cyan('audit')} [--iu=<id>]    Replacement audit — readiness per IU

${bold('Inspection:')}
  ${cyan('inspect')} [--port=N]    Interactive pipeline visualisation (opens browser)
  ${cyan('graph')}                 Show provenance graph summary
  ${cyan('bot')} "<command>"       Route a bot command (e.g., "SpecBot: help")

${bold('Meta:')}
  ${cyan('version')}               Show version
  ${cyan('help')}                  Show this help

${dim('Trust > cleverness.')}
`);
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];
  const commandArgs = args.slice(1);

  switch (command) {
    case 'init':
      cmdInit(commandArgs);
      break;
    case 'bootstrap':
      await cmdBootstrap();
      break;
    case 'status':
      cmdStatus();
      break;
    case 'ingest':
      cmdIngest(commandArgs);
      break;
    case 'diff':
      cmdDiff(commandArgs);
      break;
    case 'clauses':
      cmdClauses(commandArgs);
      break;
    case 'canonicalize':
    case 'canon-extract':
      await cmdCanonicalize();
      break;
    case 'canon':
      cmdCanon();
      break;
    case 'plan':
      cmdPlan();
      break;
    case 'preflight':
      cmdPreflight(commandArgs);
      break;
    case 'run':
      await cmdRun(commandArgs);
      break;
    case 'runs':
      cmdRuns(commandArgs);
      break;
    case 'webui-strategies':
      cmdWebUIStrategies();
      break;
    case 'webui-compare':
      await cmdWebUICompare(commandArgs);
      break;
    case 'regen':
    case 'regenerate':
      await cmdRegen(commandArgs);
      break;
    case 'drift':
      cmdDrift();
      break;
    case 'evaluate':
    case 'eval':
      cmdEvaluate(commandArgs);
      break;
    case 'cascade':
      cmdCascade();
      break;
    case 'audit':
      cmdAudit(commandArgs);
      break;
    case 'inspect':
      await cmdInspect(commandArgs);
      break;
    case 'graph':
      cmdGraph();
      break;
    case 'bot':
      cmdBot(commandArgs);
      break;
    case 'version':
    case '--version':
    case '-v':
      cmdVersion();
      break;
    case 'help':
    case '--help':
    case '-h':
    case undefined:
      cmdHelp();
      break;
    default:
      console.error(red(`✖ Unknown command: ${command}`));
      console.error(dim('  Run `phoenix help` for available commands.'));
      process.exit(1);
  }
}

main().catch(err => {
  console.error(red(`✖ ${err.message || err}`));
  process.exit(1);
});
