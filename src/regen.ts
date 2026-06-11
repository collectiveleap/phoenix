/**
 * Regeneration Engine — generates code for each IU.
 *
 * Two modes:
 * - Stub mode (no LLM): produces typed skeletons with throw stubs.
 * - LLM mode: sends IU contract + canonical requirements to an LLM
 *   and produces real, working implementations.
 *
 * The LLM provider is pluggable (Anthropic, OpenAI, etc.)
 * and auto-detected from env vars.
 */

import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname, posix as posixPath } from 'node:path';
import type { ImplementationUnit } from './models/iu.js';
import type { CanonicalNode } from './models/canonical.js';
import type { IUManifest, RegenMetadata, FileManifestEntry } from './models/manifest.js';
import type { LLMProvider, GenerateOptions } from './llm/provider.js';
import { buildPrompt, getSystemPrompt, buildTestPrompt, getTestSystemPrompt, buildUiScenarioPrompt, getUiSystemPrompt, buildContinuationPrompt } from './llm/prompt.js';
import type { ResolvedTarget } from './models/architecture.js';
import { DEFAULT_ROLE_SURFACES } from './models/architecture.js';
import type { InterfaceContract } from './models/interface-contract.js';
import type { InterfaceEntry } from './scaffold.js';
import { sha256 } from './semhash.js';
import { probeTypechecker, typecheckProject } from './harness/typecheck.js';
import type { TypecheckResult } from './harness/typecheck.js';
import { recordedGenerate, TruncationError, BoundsExceededError } from './observe/instrument.js';
import { supervisedGenerate } from './observe/watchdog.js';
import { isTruncationStopReason } from './llm/provider.js';
import type { RunJournal, HealthBudgets } from './observe/journal.js';

const TOOLCHAIN_VERSION = 'phoenix-regen/0.1.0';

/**
 * A module whose generated output exceeded the output-token budget (T3). This is
 * deterministic — retrying hits the identical ceiling — so it is never retried;
 * the module hard-fails with an actionable remediation instead of a stub.
 */
export class OutputBudgetExceededError extends Error {
  readonly iuName: string;
  readonly budget: number;
  readonly remediation: string;
  /** Accumulated output when a non-converging continuation hit the cap (#24), for capture. */
  partialText?: string;
  constructor(iuName: string, budget: number) {
    const remediation =
      `${iuName} output exceeded the ${budget}-token budget — ` +
      `raise PHOENIX_GENERATE_MAX_TOKENS or split the spec section.`;
    super(remediation);
    this.name = 'OutputBudgetExceededError';
    this.iuName = iuName;
    this.budget = budget;
    this.remediation = remediation;
  }
}

export interface RegenResult {
  iu_id: string;
  files: Map<string, string>;    // path → content
  manifest: IUManifest;
  /**
   * Set when the module hard-failed and produced no usable output — e.g. its
   * output exceeded the token budget (T3) or the generation bounds (G4). The
   * caller skips writing files for a failed result and reports the remediation;
   * no stub is substituted. `partialPath` points at the captured partial output
   * (when any was produced) so a runaway can be inspected.
   */
  failed?: { reason: string; remediation: string; partialPath?: string };
}

export interface RegenContext {
  /** LLM provider for real code generation. Omit for stub mode. */
  llm?: LLMProvider;
  /** All canonical nodes (needed for LLM prompt context). */
  canonNodes?: CanonicalNode[];
  /** All IUs (for sibling module context). */
  allIUs?: ImplementationUnit[];
  /** Project root directory (for typecheck-and-retry). */
  projectRoot?: string;
  /** Architecture target (e.g., sqlite-web-api). */
  target?: ResolvedTarget | null;
  /** Interface registry — shared mount paths for all IUs. */
  interfaces?: InterfaceEntry[];
  /** Run journal — when present, every LLM call and typecheck self-records (O1/O3). */
  journal?: RunJournal;
  /** Watchdog stall budgets — when present (with a journal), calls are supervised (O2/O8). */
  budgets?: HealthBudgets;
  /** Max generation retries on a hard call failure (e.g. the startup hang). Default 0. */
  maxRetries?: number;
  /** Max typecheck-repair iterations before reporting a capped loop. Default 2. */
  maxRepairs?: number;
  /** Backoff between generation retries, in ms (× attempt). Default 0. */
  backoffMs?: number;
  /** Output-token budget for generation calls. Default GENERATE_MAX_TOKENS. */
  maxTokens?: number;
  /**
   * Per-role model overrides (G2), e.g. `{ 'web-ui': 'opus', 'api': 'sonnet' }`.
   * A module's role (from `interfaces`) selects the model for its generation
   * calls; unset roles fall back to the provider's default model.
   */
  modelsByRole?: Record<string, string>;
  /** Callback for progress reporting. */
  onProgress?: (iu: ImplementationUnit, status: 'start' | 'done' | 'error', message?: string) => void;
}

/**
 * Generate code for a single IU.
 * Uses LLM if provided in context, otherwise falls back to stubs.
 */
export async function generateIU(iu: ImplementationUnit, ctx?: RegenContext): Promise<RegenResult> {
  const files = new Map<string, string>();
  // Effective model = per-role override (G2) or the provider's default — recorded
  // in the manifest so you can see which model produced which module.
  const modelOverride = ctx ? pickModelForIU(iu, ctx) : undefined;
  const effectiveModel = modelOverride ?? ctx?.llm?.model;
  const modelId = ctx?.llm ? `${ctx.llm.name}/${effectiveModel}` : 'stub-generator/1.0';

  for (const outputPath of iu.output_files) {
    let content: string;

    if (ctx?.llm && ctx.canonNodes) {
      ctx.onProgress?.(iu, 'start', `Generating ${iu.name} via ${ctx.llm.name}/${effectiveModel}…`);
      try {
        content = await generateWithLLM(iu, ctx);
        ctx.onProgress?.(iu, 'done');
      } catch (err) {
        // A generation-bounds runaway (G4) is deterministic-enough and was already
        // captured — hard-fail with the partial output preserved, never a stub.
        if (err instanceof BoundsExceededError) {
          const partialPath = writePartial(ctx, iu, outputPath, err.partialText);
          const remediation =
            `${iu.name} exceeded the generation ${err.bound} bound ` +
            `(${err.bytes} B, ${err.elapsedMs} ms) — likely a runaway. Inspect the captured output` +
            `${partialPath ? ` at ${partialPath}` : ''}, narrow the spec section, or try a more capable model.`;
          ctx.onProgress?.(iu, 'error', remediation);
          ctx.journal?.event('module_failed', {
            iu: iu.name, reason: 'over_generation_bounds', bound: err.bound, remediation, partialPath,
          });
          return failedResult(iu, modelId, 'over_generation_bounds', remediation, partialPath);
        }
        // Over budget (truncation) is deterministic — hard-fail the module with
        // a remediation rather than retrying or substituting a stub (T3).
        if (err instanceof OutputBudgetExceededError || err instanceof TruncationError) {
          const e = err instanceof OutputBudgetExceededError
            ? err
            : new OutputBudgetExceededError(iu.name, ctx.maxTokens ?? GENERATE_MAX_TOKENS);
          const partialText = err instanceof TruncationError ? err.partialText
            : err instanceof OutputBudgetExceededError ? err.partialText : undefined;
          const partialPath = partialText ? writePartial(ctx, iu, outputPath, partialText) : undefined;
          ctx.onProgress?.(iu, 'error', e.remediation);
          ctx.journal?.event('module_failed', {
            iu: iu.name, reason: 'over_output_budget', remediation: e.remediation, partialPath,
          });
          return failedResult(iu, modelId, 'over_output_budget', e.remediation, partialPath);
        }
        const msg = err instanceof Error ? err.message : String(err);
        ctx.onProgress?.(iu, 'error', msg);
        // Fall back to stub on other (transient) LLM failures.
        content = ctx.target ? generateArchStub(iu) : generateModule(iu);
      }
    } else {
      content = ctx?.target ? generateArchStub(iu) : generateModule(iu);
    }

    files.set(outputPath, content);
  }

  // Behavioral tests (Phase 2): for provider (api) modules, compile a test file
  // from the spec — independent of the code just generated. The smoke test stays
  // as the floor; this adds real behavioral assertions.
  if (ctx?.llm && ctx.canonNodes && ctx.target) {
    const entry = ctx.interfaces?.find(e => e.iu_id === iu.iu_id);
    const out = iu.output_files[0];
    if (entry?.role === 'api' && entry.contract && out) {
      const dir = out.split('/').slice(0, -1).join('/');
      const base = out.split('/').pop()!.replace(/\.ts$/, '');
      const importPath = `../${base}.js`;
      const raw = await generateTestsWithLLM(iu, ctx, importPath, entry.contract);
      if (raw) {
        const testPath = `${dir}/__tests__/${base}.behavior.test.ts`;
        // Fix shared-file import depth for the __tests__/ location (I1), regardless
        // of what the model emitted.
        let testCode = rebaseTestImports(raw, testPath, Object.keys(ctx.target.runtime.sharedFiles ?? {}));
        // Mount the router at its prefix so the suite's absolute-path requests resolve (#3):
        // a bare router serves at '/', but the contract paths the test addresses are
        // mount-prefixed — mirror app.ts's wiring deterministically.
        testCode = mountTestRouter(testCode, importPath, entry.mount_path);
        files.set(testPath, testCode);
        ctx.journal?.event('behavioral_tests', { iu: iu.name, module: base });
      }
    }

    // rendered-ui surface: compile Playwright UI scenarios from the spec (Phase 4 of
    // the surface-driven evals). The page's behavior is defined relative to the API
    // round-trips it drives, so pass its dependency contracts — never the markup.
    const surfaces = entry
      ? (ctx.target.architecture.roleSurfaces?.[entry.role] ?? DEFAULT_ROLE_SURFACES[entry.role] ?? [])
      : [];
    if (entry && out && surfaces.includes('rendered-ui') && ctx.target.runtime.uiGuidance) {
      const dir = out.split('/').slice(0, -1).join('/');
      const base = out.split('/').pop()!.replace(/\.ts$/, '');
      const depContracts = iu.dependencies
        .map(depId => ctx.interfaces?.find(e => e.iu_id === depId)?.contract)
        .filter((c): c is InterfaceContract => !!c);
      const raw = await generateUiScenariosWithLLM(iu, ctx, depContracts);
      if (raw) {
        files.set(`${dir}/__tests__/${base}.ui.spec.ts`, raw);
        ctx.journal?.event('ui_scenarios', { iu: iu.name, module: base });
      }
    }
  }

  // Build manifest entries
  const fileEntries: Record<string, FileManifestEntry> = {};
  for (const [path, content] of files) {
    fileEntries[path] = {
      path,
      content_hash: sha256(content),
      size: content.length,
    };
  }

  const now = new Date().toISOString();
  const promptpackHash = sha256(JSON.stringify(iu.contract));

  const metadata: RegenMetadata = {
    model_id: modelId,
    promptpack_hash: promptpackHash,
    toolchain_version: TOOLCHAIN_VERSION,
    generated_at: now,
  };

  // Record the interface contracts this module consumed (its provider deps), so a
  // later provider-contract change invalidates and regenerates this consumer.
  const consumed: Record<string, string> = {};
  for (const depId of iu.dependencies) {
    const hash = ctx?.interfaces?.find(e => e.iu_id === depId)?.contract?.contract_hash;
    if (hash) consumed[depId] = hash;
  }

  return {
    iu_id: iu.iu_id,
    files,
    manifest: {
      iu_id: iu.iu_id,
      iu_name: iu.name,
      files: fileEntries,
      regen_metadata: metadata,
      ...(Object.keys(consumed).length > 0 ? { consumed_contracts: consumed } : {}),
    },
  };
}

/**
 * Mount the imported router at its registered prefix so the generated test exercises
 * it the way `app.ts` does (#3). A bare router serves its routes at '/', but the suite —
 * fed the module's mount-prefixed contract paths — addresses the absolute mount path,
 * so every request 404s. Deterministically rewrite the prescribed `import mod from
 * '<path>'` into a router mounted at its prefix, so absolute requests resolve regardless
 * of what the model emitted. Mirrors the runtime wiring; never relies on the model.
 */
function mountTestRouter(code: string, importPath: string, mountPath: string): string {
  if (!mountPath || mountPath === '/') return code;
  const esc = importPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`import\\s+mod\\s+from\\s+(['"\`])${esc}\\1\\s*;?`);
  if (!re.test(code)) return code; // model deviated from the prescribed import — best-effort
  return code.replace(re,
    `import __phoenixRouter from '${importPath}';\n` +
    `import { Hono as __PhoenixHono } from 'hono';\n` +
    `const mod = new __PhoenixHono().route('${mountPath}', __phoenixRouter);`);
}

/**
 * Pick the model for an IU's generation calls (G2): the per-role override from
 * `ctx.modelsByRole` keyed by the module's role (from the interface registry),
 * or undefined to use the provider's default model.
 */
function pickModelForIU(iu: ImplementationUnit, ctx: RegenContext): string | undefined {
  if (!ctx.modelsByRole) return undefined;
  const role = ctx.interfaces?.find(e => e.iu_id === iu.iu_id)?.role;
  return role ? ctx.modelsByRole[role] : undefined;
}

/**
 * Re-base shared-file imports in a generated test to the test file's own location
 * (I1). The test lives in `__tests__/` — one level deeper than the module — so a
 * shared-file import the model copied from the module (e.g. `../../db.js`) resolves
 * one directory too high. Rewrite every relative import whose final segment is an
 * architecture shared file to the path correct for the test, regardless of the
 * depth the model emitted. Deterministic; never relies on the model's path math.
 */
function rebaseTestImports(code: string, testPath: string, sharedFiles: string[]): string {
  const testDir = posixPath.dirname(testPath);
  for (const sf of sharedFiles) {
    const noExt = sf.replace(/\.(tsx?|jsx?)$/, ''); // 'src/db.ts' → 'src/db'
    const base = posixPath.basename(noExt);         // 'db'
    let rel = posixPath.relative(testDir, noExt);   // '../../../db'
    if (!rel.startsWith('.')) rel = `./${rel}`;
    const correct = `${rel}.js`;
    // Relative import (`./` or `../…/`) whose final segment is this shared file.
    const re = new RegExp(`(from\\s*['"\`])(?:\\.[^'"\`]*/)?${base}(?:\\.js)?(['"\`])`, 'g');
    code = code.replace(re, `$1${correct}$2`);
  }
  return code;
}

/**
 * Generate a module's behavioral test file FROM ITS SPEC (Phase 2 of
 * GENERATED-EVIDENCE). Independent of the generated implementation — the prompt
 * is built from the canonical clauses + the module's interface, never the code,
 * so the tests assert intended behavior rather than mirroring the implementation.
 * Best-effort: any failure (no LLM, truncation, over-budget) returns null and
 * leaves the smoke test as the floor — a missing test never blocks the module.
 */
async function generateTestsWithLLM(
  iu: ImplementationUnit,
  ctx: RegenContext,
  importPath: string,
  contract: import('./models/interface-contract.js').InterfaceContract | undefined,
): Promise<string | null> {
  const { llm, canonNodes = [], target, journal, budgets } = ctx;
  if (!llm || !target) return null;
  const prompt = buildTestPrompt(iu, canonNodes, importPath, contract, target);
  const opts: GenerateOptions = {
    system: getTestSystemPrompt(target),
    temperature: 0.2,
    maxTokens: ctx.maxTokens ?? GENERATE_MAX_TOKENS,
    model: pickModelForIU(iu, ctx),
  };
  const cc = { stage: 'generate-tests', target: iu.name, attempt: 0 };
  try {
    let raw: string;
    if (journal && budgets) raw = await supervisedGenerate(journal, llm, prompt, opts, cc, { budgets });
    else if (journal) raw = await recordedGenerate(journal, llm, prompt, opts, cc);
    else raw = await llm.generate(prompt, opts);
    const code = cleanCodeResponse(raw);
    return code && code.trim().length > 0 ? code : null;
  } catch {
    return null;
  }
}

/**
 * Generate a page's Playwright UI scenarios FROM ITS SPEC (Phase 4, rendered-ui
 * surface). Independent of the generated markup — the prompt is built from the
 * canonical clauses + the page's dependency API contracts (the round-trips it
 * drives), never the implementation. Best-effort: any failure (no LLM, truncation,
 * over-budget) returns null and leaves the rendered-ui surface unproduced → the gate
 * reports it INCOMPLETE — a missing scenario never blocks the module nor falsely passes it.
 */
async function generateUiScenariosWithLLM(
  iu: ImplementationUnit,
  ctx: RegenContext,
  depContracts: InterfaceContract[],
): Promise<string | null> {
  const { llm, canonNodes = [], target, journal, budgets } = ctx;
  if (!llm || !target) return null;
  const prompt = buildUiScenarioPrompt(iu, canonNodes, depContracts, target);
  const opts: GenerateOptions = {
    system: getUiSystemPrompt(target),
    temperature: 0.2,
    maxTokens: ctx.maxTokens ?? GENERATE_MAX_TOKENS,
    model: pickModelForIU(iu, ctx),
  };
  const cc = { stage: 'generate-ui-scenarios', target: iu.name, attempt: 0 };
  try {
    let raw: string;
    if (journal && budgets) raw = await supervisedGenerate(journal, llm, prompt, opts, cc, { budgets });
    else if (journal) raw = await recordedGenerate(journal, llm, prompt, opts, cc);
    else raw = await llm.generate(prompt, opts);
    const code = cleanCodeResponse(raw);
    return code && code.trim().length > 0 ? code : null;
  } catch {
    return null;
  }
}

/**
 * Build a hard-failed RegenResult: no files, a marker manifest, and the
 * remediation. The caller writes nothing for this IU and reports the failure.
 */
function failedResult(
  iu: ImplementationUnit,
  modelId: string,
  reason: string,
  remediation: string,
  partialPath?: string,
): RegenResult {
  const metadata: RegenMetadata = {
    model_id: modelId,
    promptpack_hash: sha256(JSON.stringify(iu.contract)),
    toolchain_version: TOOLCHAIN_VERSION,
    generated_at: new Date().toISOString(),
  };
  return {
    iu_id: iu.iu_id,
    files: new Map(),
    manifest: { iu_id: iu.iu_id, iu_name: iu.name, files: {}, regen_metadata: metadata },
    failed: { reason, remediation, partialPath },
  };
}

/**
 * Persist the partial output of a failed/bounded generation so a runaway can be
 * inspected (G1/G4). Writes under the run's `partial/` dir when a journal is
 * present, else next to the intended output file as `<output>.partial`. Returns
 * the path written, or undefined if there was nothing to write.
 */
function writePartial(ctx: RegenContext, iu: ImplementationUnit, outputPath: string, text: string): string | undefined {
  if (!text || text.length === 0) return undefined;
  const base = `${outputPath.replace(/[\\/]/g, '__')}.partial`;
  const dest = ctx.journal
    ? join(ctx.journal.dir, 'partial', base)
    : ctx.projectRoot
      ? join(ctx.projectRoot, `${outputPath}.partial`)
      : undefined;
  if (!dest) return undefined;
  try {
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, text, 'utf8');
    return dest;
  } catch {
    return undefined;
  }
}

/**
 * Generate code for all IUs. Runs sequentially to respect LLM rate limits.
 */
export async function generateAll(ius: ImplementationUnit[], ctx?: RegenContext): Promise<RegenResult[]> {
  const results: RegenResult[] = [];
  for (const iu of ius) {
    results.push(await generateIU(iu, ctx));
  }
  return results;
}

// ─── LLM Generation ─────────────────────────────────────────────────────────

/** Default typecheck-repair iteration cap when `ctx.maxRepairs` is unset. */
const MAX_RETRIES = 2;

/**
 * Output-token budget for module generation. The old hardcoded 8192 truncated a
 * full inline-HTML web-UI module at ~32 KB — the model hit the cap, the stream
 * froze, and the watchdog killed+retried it futilely (see TOKEN-BUDGET-DIAGNOSIS).
 * 32000 tokens ≈ 120 KB of output, comfortably above a normal SPA module.
 * Override per-run with PHOENIX_GENERATE_MAX_TOKENS or `ctx.maxTokens`.
 *
 * NOTE: for the claude-cli provider this value is only honoured because
 * `ClaudeCliProvider` forwards it to the CLI via CLAUDE_CODE_MAX_OUTPUT_TOKENS;
 * the CLI has no max-output-tokens flag.
 */
export const GENERATE_MAX_TOKENS = Number(process.env.PHOENIX_GENERATE_MAX_TOKENS) || 32000;

/**
 * Opus reasons before emitting output, so its time-to-first-content can far exceed
 * the default 60s first-content budget — it was being killed mid-thinking (OP2).
 * Give an opus generate call a larger first-content budget and a larger total
 * duration bound (so a legitimate long think + stream isn't false-tripped by the
 * G4 runaway bound). Both env-overridable.
 */
export const OPUS_FIRST_CONTENT_MS = Number(process.env.PHOENIX_OPUS_FIRST_CONTENT_MS) || 240_000;
export const OPUS_MAX_DURATION_MS = Number(process.env.PHOENIX_OPUS_MAX_DURATION_MS) || 600_000;

/**
 * Adjust watchdog budgets for the model that will run the call (OP2). An opus
 * model gets a larger first-content (`startupMs`) budget and a larger total
 * duration bound; other models are unchanged. Never shrinks an explicitly-larger
 * configured budget.
 */
export function budgetsForModel(budgets: HealthBudgets, model: string | undefined): HealthBudgets {
  if (!model || !/opus/i.test(model)) return budgets;
  return {
    ...budgets,
    startupMs: Math.max(budgets.startupMs, OPUS_FIRST_CONTENT_MS),
    maxDurationMs: Math.max(budgets.maxDurationMs ?? 0, OPUS_MAX_DURATION_MS),
  };
}

/** Default continuation-round cap before a non-converging generation hard-fails. */
const DEFAULT_MAX_CONTINUATIONS = 4;

/**
 * Strip the seam overlap when appending a continuation chunk (#24): if the model
 * re-emitted some of the tail it was shown, drop the longest suffix of `accumulated`
 * that is a prefix of `chunk`, so the concatenation never duplicates at the join.
 * Bounded scan (the overlap is at the seam, not arbitrarily deep).
 */
export function stripOverlap(accumulated: string, chunk: string): string {
  const max = Math.min(accumulated.length, chunk.length, 4000);
  for (let k = max; k > 0; k--) {
    if (accumulated.endsWith(chunk.slice(0, k))) return chunk.slice(k);
  }
  return chunk;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/**
 * Generate code for an IU using an LLM provider.
 *
 * Two modes:
 * - Template mode (when runtime target provides moduleTemplate): LLM fills in
 *   marked sections only. Structure is guaranteed by the template.
 * - Freeform mode (no template): LLM generates the entire module.
 *
 * Both modes include typecheck-and-retry.
 */
async function generateWithLLM(iu: ImplementationUnit, ctx: RegenContext): Promise<string> {
  const llm = ctx.llm;
  if (!llm) throw new Error('generateWithLLM requires an LLM provider');
  const { canonNodes = [], allIUs, projectRoot, target, interfaces, journal, budgets } = ctx;

  // Find sibling interface entries in the same service
  const iuDir = iu.output_files[0]?.split('/').slice(0, -1).join('/');
  const siblingIUIds = new Set(
    allIUs
      ?.filter(other => other.iu_id !== iu.iu_id && other.output_files[0]?.startsWith(iuDir || ''))
      .map(other => other.iu_id) ?? []
  );
  const siblingEntries = interfaces?.filter(e => siblingIUIds.has(e.iu_id)) ?? [];

  const systemPrompt = getSystemPrompt(target);
  const prompt = buildPrompt(iu, canonNodes, siblingEntries, target);
  const template = target?.runtime.moduleTemplate;

  // Route every LLM call through the journal when one is present (O1). When
  // watchdog budgets are also set, supervise the call so stalls are killed
  // (O2/O8); otherwise record-only; otherwise plain generation.
  const callLLM = async (p: string, opts: GenerateOptions, attempt: number): Promise<string> => {
    if (journal && budgets) {
      // Size the first-content/duration budgets to the model actually running the
      // call (OP2) — opus needs longer to first content than the 60s default.
      const callBudgets = budgetsForModel(budgets, opts.model ?? llm.model);
      return supervisedGenerate(journal, llm, p, opts, { stage: 'generate', target: iu.name, attempt }, { budgets: callBudgets });
    }
    if (journal) {
      return recordedGenerate(journal, llm, p, opts, { stage: 'generate', target: iu.name, attempt });
    }
    // No-journal path: still observe the stop reason so an over-budget call is
    // surfaced as a TruncationError, not silently returned and repaired futilely.
    let stopReason: string | undefined;
    const text = await llm.generateStream(p, opts, { onStopReason: r => { stopReason = r; } });
    if (isTruncationStopReason(stopReason)) {
      throw new TruncationError(stopReason!, Buffer.byteLength(text, 'utf8'), text);
    }
    return text;
  };

  // Generation retry (B6): a hard call failure — notably the known intermittent
  // startup hang (#45269) — is ridden out by retrying the generation call up to
  // `maxRetries` times with backoff, rather than dropping to a stub on the first
  // miss. Reliability of the call is the harness's job, not the user's.
  const maxRetries = ctx.maxRetries ?? 0;
  const backoffMs = ctx.backoffMs ?? 0;
  const maxTokens = ctx.maxTokens ?? GENERATE_MAX_TOKENS;
  const model = pickModelForIU(iu, ctx); // per-role model override (G2); undefined ⇒ provider default

  // Produce the raw module output, continuing across calls when a single call
  // exceeds its byte/duration bound (#24): a large module is assembled from several
  // bounded chunks instead of failing as a runaway. A module that fits one call
  // returns immediately. A non-converging generation hard-fails at MAX_CONTINUATIONS,
  // preserving #8's runaway guard.
  const isBounded = (e: unknown): e is BoundsExceededError | TruncationError =>
    e instanceof BoundsExceededError || e instanceof TruncationError;

  // Read the toggle/cap per call so a run can A/B without a restart (#24).
  const continuationsEnabled = process.env.PHOENIX_GENERATE_CONTINUATIONS !== '0';
  const maxContinuations = Number(process.env.PHOENIX_GENERATE_MAX_CONTINUATIONS) || DEFAULT_MAX_CONTINUATIONS;

  const generateRaw = async (opts: GenerateOptions): Promise<string> => {
    let accumulated: string;
    try {
      return await callLLM(prompt, opts, 0); // completed within bounds — no continuation
    } catch (err) {
      if (!continuationsEnabled || !isBounded(err)) throw err;
      accumulated = err.partialText ?? '';
    }
    for (let round = 1; round <= maxContinuations; round++) {
      journal?.event('generation_continuation', {
        iu: iu.name, round, bytesSoFar: Buffer.byteLength(accumulated, 'utf8'),
      });
      try {
        const chunk = await callLLM(buildContinuationPrompt(prompt, accumulated), opts, round);
        accumulated += stripOverlap(accumulated, chunk);
        journal?.event('generation_assembled', {
          iu: iu.name, totalBytes: Buffer.byteLength(accumulated, 'utf8'), continuations: round, converged: true,
        });
        return accumulated; // a call completed within bounds → the model finished
      } catch (err) {
        if (!isBounded(err)) throw err;
        accumulated += stripOverlap(accumulated, err.partialText ?? '');
      }
    }
    journal?.event('generation_assembled', {
      iu: iu.name, totalBytes: Buffer.byteLength(accumulated, 'utf8'), continuations: maxContinuations, converged: false,
    });
    const capErr = new OutputBudgetExceededError(iu.name, maxTokens); // non-converging runaway → hard-fail
    capErr.partialText = accumulated; // preserve what was assembled, for capture
    throw capErr;
  };

  const generateOnce = async (): Promise<string> => {
    const opts: GenerateOptions = { system: systemPrompt, temperature: template ? 0.1 : 0.2, maxTokens, model };
    const raw = await generateRaw(opts);
    return template ? assembleFromTemplate(template, raw, iu) : cleanCodeResponse(raw);
  };

  let code: string;
  for (let genAttempt = 0; ; genAttempt++) {
    try {
      code = await generateOnce();
      break;
    } catch (err) {
      // Truncation (T3), a bounds runaway (G4), and a non-converging continuation
      // (#24, OutputBudgetExceededError) are deterministic — retrying hits the same
      // ceiling. Do not count them toward maxRetries; surface immediately so the
      // module hard-fails with the captured evidence.
      if (err instanceof TruncationError || err instanceof BoundsExceededError || err instanceof OutputBudgetExceededError) throw err;
      if (genAttempt >= maxRetries) throw err;
      journal?.event('generate_retry', {
        iu: iu.name,
        attempt: genAttempt + 1,
        of: maxRetries,
        error: err instanceof Error ? err.message : String(err),
      });
      if (backoffMs > 0) await sleep(backoffMs * (genAttempt + 1));
    }
  }

  // Typecheck-and-repair loop (O3). A missing/broken typechecker is a hard
  // failure that fires ZERO repair calls — never mistaken for type errors.
  if (projectRoot && iu.output_files[0]) {
    const probe = probeTypechecker(projectRoot);
    if (!probe.available) {
      journal?.event('typecheck', { iu: iu.name, status: 'unavailable', detail: probe.detail, repairCalls: 0 });
      ctx.onProgress?.(iu, 'error', `typecheck tool unavailable: ${probe.detail}`);
    } else {
      const maxRepairs = ctx.maxRepairs ?? MAX_RETRIES;
      let prevCount: number | null = null;
      for (let attempt = 0; attempt <= maxRepairs; attempt++) {
        const result = typecheckFile(projectRoot, iu.output_files[0], code, probe);

        if (result.status === 'clean') {
          journal?.event('typecheck', { iu: iu.name, status: 'clean', command: result.command, iteration: attempt });
          break;
        }
        if (result.status === 'unavailable') {
          // Tool vanished mid-loop — stop; never repair on a tool failure (#1).
          journal?.event('typecheck', { iu: iu.name, status: 'unavailable', detail: result.detail });
          ctx.onProgress?.(iu, 'error', `typecheck tool unavailable: ${result.detail}`);
          break;
        }

        // status === 'errors' — record the per-iteration error-count delta.
        const delta = prevCount === null ? null : result.count - prevCount;
        journal?.event('typecheck', {
          iu: iu.name, status: 'errors', iteration: attempt,
          errorCount: result.count, delta, converging: delta === null ? null : delta < 0,
          command: result.command,
        });
        prevCount = result.count;

        if (attempt === maxRepairs) {
          // Verified, still failing — report the capped loop (O3).
          journal?.event('repair_capped', { iu: iu.name, remainingErrors: result.count, maxRepairs });
          break;
        }

        // Feed errors back to the LLM with the current code.
        const fixResponse = await callLLM(
          buildFixPrompt(code, result.errors),
          { system: systemPrompt, temperature: 0.1, maxTokens, model },
          attempt + 1,
        );
        code = template ? assembleFromTemplate(template, fixResponse, iu) : cleanCodeResponse(fixResponse);
      }
    }
  }

  // Bind the consumer to the interface contract (C1): deterministically repair any
  // call that addresses an operation the registry doesn't declare. The architecture's
  // dialect owns the transport-specific repair; without a dialect, fall back to the
  // legacy fetch-path repair. The registry is the ground truth either way.
  const dialect = target?.runtime.interfaceDialect;
  const contracts = (interfaces ?? []).map(e => e.contract).filter((c): c is NonNullable<typeof c> => !!c);
  if (dialect && contracts.length > 0) {
    code = dialect.bindConsumer(code, contracts);
  } else if (interfaces && interfaces.length > 0) {
    code = repairFetchPaths(code, interfaces);
  }

  return code;
}

/**
 * Repair LLM-generated code using the template as a structural guarantee.
 *
 * The LLM generates a full module. This function:
 * 1. Strips any imports the LLM wrote and replaces with template imports
 * 2. Ensures `export default router` exists
 * 3. Ensures `_phoenix` metadata exists
 * 4. Ensures `const router = new Hono()` exists
 *
 * This is more robust than section parsing — accepts whatever the LLM
 * generates and fixes the structural parts that must be exact.
 */
function assembleFromTemplate(template: string, llmResponse: string, iu: ImplementationUnit): string {
  let code = cleanCodeResponse(llmResponse);

  // Extract the template's fixed header (imports)
  const templateLines = template.split('\n');
  const headerEnd = templateLines.findIndex(l => l.includes('__MIGRATIONS__'));
  const templateHeader = templateLines.slice(0, Math.max(headerEnd, 0)).join('\n');

  // Strip LLM's import lines — we'll use the template's
  const codeLines = code.split('\n');
  const bodyLines = codeLines.filter(line => {
    const trimmed = line.trim();
    // Remove import statements that the template already provides
    if (trimmed.startsWith('import ') && (
      trimmed.includes('hono') ||
      trimmed.includes('db.js') ||
      trimmed.includes('better-sqlite3') ||
      trimmed.includes('zod')
    )) return false;
    return true;
  });
  let body = bodyLines.join('\n').trim();

  // Remove any duplicate "const router = new Hono()" — template has one, LLM might add another
  const routerDecls = (body.match(/const router\s*=\s*new Hono\(\)/g) ?? []).length;
  if (routerDecls > 1) {
    // Keep only the first occurrence
    let found = false;
    body = body.split('\n').filter(line => {
      if (line.includes('const router') && line.includes('new Hono()')) {
        if (found) return false;
        found = true;
      }
      return true;
    }).join('\n');
  }

  // Remove any "export default router" — we'll add it at the end
  body = body.replace(/\nexport\s+default\s+router\s*;?\s*/g, '\n');

  // Remove any existing _phoenix export
  body = body.replace(/\/\*\*[^]*?_phoenix[^]*?\*\/\s*export\s+const\s+_phoenix\s*=\s*\{[^}]*\}\s*as\s+const\s*;?\s*/g, '');
  body = body.replace(/export\s+const\s+_phoenix\s*=\s*\{[^}]*\}\s*as\s+const\s*;?\s*/g, '');

  // Ensure router declaration exists
  if (!body.includes('const router') && !body.includes('new Hono()')) {
    body = 'const router = new Hono();\n\n' + body;
  }

  // Build the phoenix metadata
  const phoenixMeta = `/** @internal Phoenix VCS traceability — do not remove. */
export const _phoenix = {
  iu_id: '${iu.iu_id}',
  name: '${iu.name}',
  risk_tier: '${iu.risk_tier}',
  canon_ids: [${iu.source_canon_ids.length} as const],
} as const;`;

  // Fix SQL double-quote issue globally: SQLite treats "x" as column name, needs 'x'
  // Replace ALL double-quoted SQL keywords that should be single-quoted
  body = body.replace(/datetime\("now"\)/g, "datetime('now')");
  body = body.replace(/date\("now"\)/g, "date('now')");
  body = body.replace(/WHEN "(\w+)" THEN/g, "WHEN '$1' THEN");
  body = body.replace(/DEFAULT "([^"]+)"/g, "DEFAULT '$1'");
  body = body.replace(/< datetime\("now"\)/g, "< datetime('now')");
  body = body.replace(/< date\("now"\)/g, "< date('now')");
  // Catch any remaining datetime/date with double quotes
  body = body.replace(/datetime\s*\(\s*"now"\s*\)/g, "datetime('now')");
  body = body.replace(/date\s*\(\s*"now"\s*\)/g, "date('now')");

  // Assemble: template header + LLM body + exports + metadata
  return `${templateHeader}\n\n${body}\n\nexport default router;\n\n${phoenixMeta}\n`;
}

const MINIMAL_TSCONFIG = JSON.stringify({
  compilerOptions: {
    target: 'ES2022',
    module: 'Node16',
    moduleResolution: 'Node16',
    strict: true,
    esModuleInterop: true,
    skipLibCheck: true,
    outDir: 'dist',
    rootDir: 'src',
  },
  include: ['src'],
}, null, 2);

/**
 * Typecheck a single file by writing it to disk and running the resolved tsc.
 * Returns a structured result distinguishing clean / type-errors / tool-
 * unavailable (the last is never treated as type errors — appendix #1).
 */
function typecheckFile(
  projectRoot: string,
  filePath: string,
  content: string,
  probe?: ReturnType<typeof probeTypechecker>,
): TypecheckResult {
  const fullPath = join(projectRoot, filePath);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, content, 'utf8');

  // Ensure tsconfig.json exists for tsc
  const tsconfigPath = join(projectRoot, 'tsconfig.json');
  if (!existsSync(tsconfigPath)) {
    writeFileSync(tsconfigPath, MINIMAL_TSCONFIG, 'utf8');
  }

  return typecheckProject(projectRoot, filePath, probe);
}

/**
 * Build a prompt asking the LLM to fix typecheck errors.
 */
function buildFixPrompt(code: string, errors: string): string {
  return `The following TypeScript module has compilation errors. Fix them.

## Current code:
\`\`\`typescript
${code}
\`\`\`

## TypeScript errors:
${errors}

## Rules:
- Output ONLY the fixed TypeScript module. No markdown fences, no explanation.
- Do NOT import external packages. Use only Node.js built-in modules.
- For WebSocket features, use node:http — do NOT import 'ws'.
- For DOM/browser code, use string HTML templates — no DOM APIs.
- The code must compile under strict mode.
- Keep all existing exports and the _phoenix metadata constant.

Output the complete fixed TypeScript module now.`;
}

/**
 * Repair fetch() paths in generated code to match the interface registry.
 *
 * The LLM may invent paths (e.g., /todos instead of /tasks). The interface
 * registry is the ground truth for mount paths. This scans for fetch('/<path>')
 * calls and rewrites any that look like a pluralized or synonymous variant of
 * a registry entry's resource name.
 */
function repairFetchPaths(code: string, interfaces: InterfaceEntry[]): string {
  // Build a map from possible wrong paths to correct mount paths.
  // For each API entry (e.g., name="Tasks", mount_path="/tasks"),
  // generate common LLM mistakes: singular, plural, synonyms.
  const corrections = new Map<string, string>();
  for (const entry of interfaces) {
    if (entry.role === 'web-ui' || !entry.mount_path) continue;
    const name = entry.name.toLowerCase();
    // The mount path is derived from the IU name, but the LLM might use
    // the spec's domain language instead. Common patterns:
    // "Tasks" mounted at /tasks, but LLM writes /todos, /todo, /task
    // We can't predict all synonyms, but we can detect fetch paths that
    // don't match ANY registry entry and try to map them.
    corrections.set(entry.mount_path, entry.mount_path); // identity
  }

  const validPaths = new Set(interfaces.filter(e => e.role === 'api').map(e => e.mount_path));

  // Find all fetch('/<path>') or fetch("/<path>") or fetch(`/<path>`) calls
  // and check if the base path matches a valid mount path.
  code = code.replace(
    /fetch\(\s*(['"`])(\/.+?)\1/g,
    (match, quote, fetchPath) => {
      // Extract the base path: /todos/123 → /todos, /tasks?foo=bar → /tasks
      const basePath = '/' + fetchPath.slice(1).split(/[/?]/)[0];

      // If it already matches a valid mount path, leave it alone
      if (validPaths.has(basePath)) return match;

      // Try to find the best matching registry entry by comparing the
      // fetch path's resource name against registry entry names
      const fetchResource = basePath.slice(1).toLowerCase(); // "todos"
      let bestMatch: InterfaceEntry | null = null;
      let bestScore = 0;

      for (const entry of interfaces) {
        if (entry.role === 'web-ui' || !entry.mount_path) continue;
        const entryResource = entry.mount_path.slice(1).toLowerCase(); // "tasks"
        const entryName = entry.name.toLowerCase(); // "tasks"

        // Score: how similar is the fetch resource to this entry?
        // Check if they share a common stem or if one contains the other
        const score = resourceSimilarity(fetchResource, entryResource, entryName);
        if (score > bestScore) {
          bestScore = score;
          bestMatch = entry;
        }
      }

      if (bestMatch && bestScore > 0) {
        const correctedPath = fetchPath.replace(basePath, bestMatch.mount_path);
        return `fetch(${quote}${correctedPath}${quote}`;
      }

      return match;
    }
  );

  // Also fix template literal fetch paths: fetch(`/todos/${id}`)
  code = code.replace(
    /fetch\(\s*`(\/.+?)`/g,
    (match, fetchPath) => {
      const firstSegment = fetchPath.slice(1).split(/[/`$?]/)[0];
      const basePath = '/' + firstSegment;

      if (validPaths.has(basePath)) return match;

      const fetchResource = firstSegment.toLowerCase();
      let bestMatch: InterfaceEntry | null = null;
      let bestScore = 0;

      for (const entry of interfaces) {
        if (entry.role === 'web-ui' || !entry.mount_path) continue;
        const entryResource = entry.mount_path.slice(1).toLowerCase();
        const entryName = entry.name.toLowerCase();
        const score = resourceSimilarity(fetchResource, entryResource, entryName);
        if (score > bestScore) {
          bestScore = score;
          bestMatch = entry;
        }
      }

      if (bestMatch && bestScore > 0) {
        const correctedPath = fetchPath.replace(basePath, bestMatch.mount_path);
        return `fetch(\`${correctedPath}\``;
      }

      return match;
    }
  );

  return code;
}

/**
 * Score how similar a fetch resource name is to a registry entry.
 * Returns 0 for no match, higher for better matches.
 */
function resourceSimilarity(fetchResource: string, entryResource: string, entryName: string): number {
  // Exact match
  if (fetchResource === entryResource) return 10;

  // Singular/plural variants: "todo" vs "todos", "task" vs "tasks"
  const fetchStem = fetchResource.replace(/s$/, '').replace(/ies$/, 'y');
  const entryStem = entryResource.replace(/s$/, '').replace(/ies$/, 'y');
  const nameStem = entryName.replace(/s$/, '').replace(/ies$/, 'y');

  if (fetchStem === entryStem) return 8;
  if (fetchStem === nameStem) return 8;

  // Common synonyms for task-like resources
  const synonymGroups = [
    ['task', 'todo', 'item', 'ticket'],
    ['project', 'workspace', 'board', 'category'],
    ['user', 'account', 'profile', 'member'],
  ];

  for (const group of synonymGroups) {
    const fetchInGroup = group.includes(fetchStem);
    const entryInGroup = group.includes(entryStem) || group.includes(nameStem);
    if (fetchInGroup && entryInGroup) return 5;
  }

  return 0;
}

/**
 * Strip markdown code fences from LLM response.
 */
function cleanCodeResponse(raw: string): string {
  let code = raw.trim();

  // Remove ```typescript ... ``` or ```ts ... ``` or ``` ... ```
  const fenceMatch = code.match(/^```(?:typescript|ts)?\s*\n([\s\S]*?)\n```\s*$/);
  if (fenceMatch) {
    code = fenceMatch[1];
  }

  // Also handle case where there's text before/after the fence
  const innerMatch = code.match(/```(?:typescript|ts)?\s*\n([\s\S]*?)\n```/);
  if (innerMatch && innerMatch[1].includes('export')) {
    code = innerMatch[1];
  }

  return code;
}

// ─── Module Generation ───────────────────────────────────────────────────────

/**
 * Generate a minimal Hono router stub for architecture mode.
 * Ensures fallback code still produces a valid default-export router.
 */
function generateArchStub(iu: ImplementationUnit): string {
  return `import { Hono } from 'hono';

const router = new Hono();

router.get('/', (c) => c.json({ stub: true, module: '${iu.name}', message: 'Not yet implemented' }));

export default router;

/** @internal Phoenix VCS traceability — do not remove. */
export const _phoenix = {
  iu_id: '${iu.iu_id}',
  name: '${iu.name}',
  risk_tier: '${iu.risk_tier}',
  canon_ids: [${iu.source_canon_ids.length} as const],
} as const;
`;
}

/**
 * Generate a natural TypeScript module from an IU contract.
 */
function generateModule(iu: ImplementationUnit): string {
  const lines: string[] = [];
  const moduleName = toPascalCase(iu.name);
  const configName = `${moduleName}Config`;

  // Header
  lines.push(`/**`);
  lines.push(` * ${iu.name}`);
  lines.push(` *`);
  lines.push(` * AUTO-GENERATED by Phoenix VCS — DO NOT EDIT DIRECTLY`);
  lines.push(` * Risk Tier: ${iu.risk_tier}`);
  lines.push(` */`);
  lines.push('');

  // Config interface from constraints/invariants
  if (iu.contract.invariants.length > 0) {
    const fields = iu.contract.invariants
      .map(inv => ({ inv, field: constraintToConfigField(inv) }))
      .filter((x): x is { inv: string; field: { name: string; type: string } } => x.field !== null);

    if (fields.length > 0) {
      lines.push(`/**`);
      lines.push(` * Configuration and constraints for ${iu.name}.`);
      lines.push(` */`);
      lines.push(`export interface ${configName} {`);
      for (const { inv, field } of fields) {
        lines.push(`  /** ${inv} */`);
        lines.push(`  ${field.name}: ${field.type};`);
      }
      lines.push('}');
      lines.push('');
    }
  }

  // Input/output interfaces
  const inputTypeName = `${moduleName}Input`;
  const outputTypeName = `${moduleName}Result`;

  if (iu.contract.inputs.length > 0) {
    lines.push(`export interface ${inputTypeName} {`);
    for (const inp of iu.contract.inputs) {
      lines.push(`  ${inp}: unknown;`);
    }
    lines.push('}');
    lines.push('');
  }

  if (iu.contract.outputs.length > 0) {
    lines.push(`export interface ${outputTypeName} {`);
    for (const out of iu.contract.outputs) {
      lines.push(`  ${out}: unknown;`);
    }
    lines.push('}');
    lines.push('');
  }

  // Extract distinct operations from requirement statements
  const operations = extractOperations(iu);

  // Collect and emit placeholder types referenced by operations
  if (operations.length > 0) {
    const builtinTypes = new Set(['unknown', 'void', 'boolean', 'string', 'number', 'object',
      inputTypeName, outputTypeName, configName]);
    const placeholders = new Set<string>();
    for (const op of operations) {
      for (const t of extractTypeRefs(op.params, op.returnType)) {
        if (!builtinTypes.has(t)) placeholders.add(t);
      }
    }
    if (placeholders.size > 0) {
      for (const t of placeholders) {
        lines.push(`/** Placeholder type — replace with your domain model. */`);
        lines.push(`export type ${t} = Record<string, unknown>;`);
        lines.push('');
      }
    }
  }

  if (operations.length > 0) {
    for (const op of operations) {
      lines.push(`/**`);
      lines.push(` * ${op.description}`);
      lines.push(` */`);
      lines.push(`export function ${op.name}(${op.params}): ${op.returnType} {`);
      lines.push(`  // TODO: implement`);
      lines.push(`  throw new Error('Not implemented: ${op.name}');`);
      lines.push('}');
      lines.push('');
    }
  } else {
    // Fallback: single entry-point function
    const funcName = toCamelCase(iu.name);
    const params = iu.contract.inputs.length > 0
      ? `input: ${inputTypeName}`
      : '';
    const ret = iu.contract.outputs.length > 0 ? outputTypeName : 'void';
    lines.push(`/**`);
    lines.push(` * ${iu.contract.description.split('.')[0] || iu.name}.`);
    lines.push(` */`);
    lines.push(`export function ${funcName}(${params}): ${ret} {`);
    lines.push(`  // TODO: implement`);
    lines.push(`  throw new Error('Not implemented: ${funcName}');`);
    lines.push('}');
    lines.push('');
  }

  // Phoenix metadata (compact)
  lines.push(`/** @internal Phoenix VCS traceability — do not remove. */`);
  lines.push(`export const _phoenix = {`);
  lines.push(`  iu_id: '${iu.iu_id}',`);
  lines.push(`  name: '${iu.name}',`);
  lines.push(`  risk_tier: '${iu.risk_tier}',`);
  lines.push(`  canon_ids: [${iu.source_canon_ids.length} as const],`);
  lines.push('} as const;');
  lines.push('');

  return lines.join('\n');
}

// ─── Operation Extraction ────────────────────────────────────────────────────

interface Operation {
  name: string;
  description: string;
  params: string;
  returnType: string;
}

/**
 * Extract distinct function operations from an IU's canonical requirements.
 * Looks for verb patterns in requirement statements and deduplicates.
 */
function extractOperations(iu: ImplementationUnit): Operation[] {
  const ops: Operation[] = [];
  const seenNames = new Set<string>();

  // Parse requirements for action verbs
  const patterns: { pattern: RegExp; verb: string }[] = [
    { pattern: /\bmust (?:support |handle )?creat(?:e|ing)\b/i, verb: 'create' },
    { pattern: /\bmust (?:support |handle )?validat(?:e|ing)\b/i, verb: 'validate' },
    { pattern: /\bmust (?:support |handle )?verif(?:y|ying)\b/i, verb: 'verify' },
    { pattern: /\bmust (?:support |handle )?authenticat(?:e|ing)\b/i, verb: 'authenticate' },
    { pattern: /\bmust (?:support |handle )?delet(?:e|ing)\b/i, verb: 'delete' },
    { pattern: /\bmust (?:support |handle )?updat(?:e|ing)\b/i, verb: 'update' },
    { pattern: /\bmust (?:support |handle )?search(?:ing)?\b/i, verb: 'search' },
    { pattern: /\bmust (?:support |handle )?send(?:ing)?\b/i, verb: 'send' },
    { pattern: /\bmust (?:support |handle )?deliver(?:y|ing)?\b/i, verb: 'deliver' },
    { pattern: /\bmust (?:support |handle )?publish(?:ing)?\b/i, verb: 'publish' },
    { pattern: /\bmust (?:support |handle )?rout(?:e|ing)\b/i, verb: 'route' },
    { pattern: /\bmust (?:support |handle )?log(?:ging)?\b/i, verb: 'log' },
    { pattern: /\bmust (?:support |handle )?reject(?:ed|ing)?\b/i, verb: 'reject' },
    { pattern: /\bmust (?:be )?rate.?limit(?:ed|ing)?\b/i, verb: 'rateLimit' },
    { pattern: /\bmust (?:support |handle )?retr(?:y|ying|ied)\b/i, verb: 'retry' },
    { pattern: /\bmust (?:support |handle )?configur(?:e|ing|able)\b/i, verb: 'configure' },
    { pattern: /\bmust (?:support |handle )?expos(?:e|ing)\b/i, verb: 'expose' },
    { pattern: /\bmust (?:support |handle )?implement(?:ing)?\b/i, verb: 'handle' },
    { pattern: /\bmust (?:support |handle )?inject(?:ing)?\b/i, verb: 'inject' },
    { pattern: /\bmust (?:support |handle )?stor(?:e|ing)\b/i, verb: 'store' },
    { pattern: /\bmust (?:support |handle )?archiv(?:e|ing)\b/i, verb: 'archive' },
    { pattern: /\bmust (?:support |handle )?mark(?:ing)?\b/i, verb: 'mark' },
    { pattern: /\bmust (?:support |handle )?process(?:ing|ed)?\b/i, verb: 'process' },
  ];

  // Group requirements by detected verb
  const verbGroups = new Map<string, string[]>();
  const moduleName = toPascalCase(iu.name);

  for (const statement of iu.contract.description.split('. ').filter(Boolean)) {
    for (const { pattern, verb } of patterns) {
      if (pattern.test(statement)) {
        const list = verbGroups.get(verb) ?? [];
        list.push(statement);
        verbGroups.set(verb, list);
        break; // one verb per statement
      }
    }
  }

  // Generate one function per unique verb
  for (const [verb, statements] of verbGroups) {
    if (seenNames.has(verb)) continue;
    seenNames.add(verb);

    // Derive params from the object being acted on
    const subject = extractSubject(statements[0], verb);
    const paramName = subject ? toCamelCase(subject) : 'input';
    const paramType = subject ? toPascalCase(subject) : 'unknown';

    ops.push({
      name: verb,
      description: statements[0],
      params: `${paramName}: ${paramType}`,
      returnType: verb === 'validate' || verb === 'verify'
        ? 'boolean'
        : verb === 'search'
          ? `${paramType}[]`
          : verb === 'delete' || verb === 'log' || verb === 'archive' || verb === 'mark'
            ? 'void'
            : paramType,
    });
  }

  // Limit to reasonable number
  return ops.slice(0, 8);
}

/**
 * Try to extract the object/subject from a requirement statement.
 * "the service must validate JWT tokens" → "token"
 * "the gateway must reject expired tokens" → "token"
 */
function extractSubject(statement: string, verb: string): string | null {
  // Pattern: "must <verb> <object>"
  const regex = new RegExp(`must\\s+(?:support\\s+|handle\\s+)?${verb}\\w*\\s+(.+?)(?:\\s+(?:with|from|to|for|on|in|at|by|using|via|when|after|before)\\b|[.;,]|$)`, 'i');
  const match = statement.match(regex);
  if (match) {
    const raw = match[1]
      .replace(/^(?:a|an|the|all|each|every|new)\s+/i, '')
      .replace(/\s*\(.*?\)/g, '')
      .trim();
    // Take the core noun — typically 1-2 meaningful words
    const words = raw.split(/\s+/)
      .filter(w => w.length > 1)
      .slice(0, 2);
    if (words.length > 0) {
      // Singularize simple plurals
      const noun = words[words.length - 1].replace(/s$/, '');
      words[words.length - 1] = noun;
      return words.join(' ');
    }
  }
  return null;
}

/**
 * Convert a constraint statement to a config field.
 * Returns null for constraints that are better expressed as code logic
 * rather than configuration.
 */
function constraintToConfigField(constraint: string): { name: string; type: string } | null {
  // Numeric limits: "rate limited to 5 per minute", "limited to 100 characters"
  const numMatch = constraint.match(/(\d+)\s*(per\s+\w+|characters|bytes|kb|mb|seconds?|minutes?|hours?|days?|retries|attempts)/i);
  if (numMatch) {
    const unit = numMatch[2].replace(/\s+/g, '').toLowerCase();
    const subject = extractConstraintSubject(constraint);
    if (/rate.?limit/i.test(constraint)) {
      return { name: `${subject}RateLimitPer${capitalize(unit)}`, type: 'number' };
    }
    if (/expir|ttl|window/i.test(constraint)) {
      return { name: `${subject}Ttl${capitalize(unit)}`, type: 'number' };
    }
    return { name: `${subject}Max${capitalize(unit)}`, type: 'number' };
  }

  // Configurable things: "CORS headers must be configurable per route"
  if (/\bconfigurable\b/i.test(constraint)) {
    const subject = extractConstraintSubject(constraint);
    return { name: `${subject}Config`, type: 'Record<string, unknown>' };
  }

  // Skip vague "must not" / "never" constraints — they're invariants, not config
  return null;
}

/**
 * Extract a short subject identifier from a constraint.
 * "the service must not send more than 10 emails" → "email"
 */
function extractConstraintSubject(statement: string): string {
  // Find the most specific noun near the numbers/keywords
  const words = statement
    .toLowerCase()
    .replace(/\b(?:the|a|an|must|be|is|are|not|no|shall|never|always|service|gateway|system)\b/g, '')
    .replace(/[^a-z0-9\s]/g, '')
    .trim()
    .split(/\s+/)
    .filter(w => w.length > 2);

  // Pick the most meaningful word (skip common verbs)
  const skip = new Set(['send', 'store', 'access', 'more', 'than', 'per', 'with', 'for', 'from', 'limited', 'exceed', 'larger']);
  const meaningful = words.filter(w => !skip.has(w));
  return toCamelCase(meaningful.slice(0, 2).join(' ')) || 'value';
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Extract type references from param and return type strings.
 * "jwtToken: JwtToken" → ["JwtToken"]
 * "User[]" → ["User"]
 */
function extractTypeRefs(params: string, returnType: string): string[] {
  const types: string[] = [];
  // From params: "name: Type" patterns
  const paramMatches = params.matchAll(/:\s*([A-Z][A-Za-z0-9]*)/g);
  for (const m of paramMatches) types.push(m[1]);
  // From return type
  const retMatch = returnType.replace(/\[\]$/, '');
  if (/^[A-Z]/.test(retMatch)) types.push(retMatch);
  return types;
}

// ─── Naming Utilities ────────────────────────────────────────────────────────

function toCamelCase(str: string): string {
  return str
    .replace(/[^a-zA-Z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map((w, i) => i === 0 ? w.toLowerCase() : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join('');
}

function toPascalCase(str: string): string {
  return str
    .replace(/[^a-zA-Z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join('');
}
