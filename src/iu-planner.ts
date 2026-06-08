/**
 * IU Planner — maps canonical nodes to Implementation Unit proposals.
 *
 * Groups related requirements into module-level IUs based on:
 * - Source document (service boundary)
 * - Source section within a document (module boundary)
 *
 * Naming produces natural developer-facing identifiers:
 *   spec/api-gateway.md, section "Rate Limiting"
 *   → name: "Rate Limiting"
 *   → file: src/generated/api-gateway/rate-limiting.ts
 */

import type { CanonicalNode } from './models/canonical.js';
import { CanonicalType } from './models/canonical.js';
import type { Clause } from './models/clause.js';
import type { ImplementationUnit } from './models/iu.js';
import { defaultBoundaryPolicy, defaultEnforcement } from './models/iu.js';
import { sha256 } from './semhash.js';
import { deriveInterfaces } from './scaffold.js';
import { GENERATE_MAX_TOKENS } from './regen.js';

/**
 * Plan IUs from canonical nodes, grouping by source document + section.
 *
 * Each top-level section of each spec document becomes one IU.
 * Canon nodes are assigned to the IU of their source clause's section.
 * CONTEXT nodes are excluded from IU generation (they don't produce code).
 */
export function planIUs(
  canonNodes: CanonicalNode[],
  clauses: Clause[],
): ImplementationUnit[] {
  // Filter out CONTEXT nodes — they don't generate code
  canonNodes = canonNodes.filter(n => n.type !== CanonicalType.CONTEXT);
  if (canonNodes.length === 0) return [];

  // Index clauses by ID
  const clauseMap = new Map(clauses.map(c => [c.clause_id, c]));

  // Group canonical nodes by (doc, top-level section)
  const buckets = new Map<string, { nodes: CanonicalNode[]; docId: string; sectionName: string }>();

  for (const node of canonNodes) {
    const clause = node.source_clause_ids
      .map(id => clauseMap.get(id))
      .find(c => c !== undefined);

    if (!clause) continue;

    const docId = clause.source_doc_id;
    // Use the second level of section_path as the grouping key.
    // section_path[0] is typically the doc title, section_path[1] is the first real section.
    // If there's only one level, use that.
    const sectionName = clause.section_path.length > 1
      ? clause.section_path[1]
      : clause.section_path[0] || 'main';

    const key = `${docId}::${sectionName}`;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { nodes: [], docId, sectionName };
      buckets.set(key, bucket);
    }
    bucket.nodes.push(node);
  }

  // Merge small buckets (≤1 node) into their document's largest bucket
  const docBuckets = new Map<string, string[]>(); // docId → keys
  for (const [key, bucket] of buckets) {
    const list = docBuckets.get(bucket.docId) ?? [];
    list.push(key);
    docBuckets.set(bucket.docId, list);
  }

  for (const [docId, keys] of docBuckets) {
    const small = keys.filter(k => buckets.get(k)!.nodes.length <= 1);
    const large = keys.filter(k => buckets.get(k)!.nodes.length > 1);

    if (small.length > 0 && large.length > 0) {
      // Find the largest bucket in this doc
      const targetKey = large.sort((a, b) =>
        buckets.get(b)!.nodes.length - buckets.get(a)!.nodes.length
      )[0];
      const target = buckets.get(targetKey)!;
      for (const smallKey of small) {
        target.nodes.push(...buckets.get(smallKey)!.nodes);
        buckets.delete(smallKey);
      }
    }
  }

  // Convert buckets to IUs
  const ius: ImplementationUnit[] = [];

  for (const [, bucket] of buckets) {
    const { nodes, docId, sectionName } = bucket;
    if (nodes.length === 0) continue;

    const name = cleanName(sectionName);
    const serviceName = deriveServiceName(docId);
    const fileName = slugify(name);
    const riskTier = deriveRiskTier(nodes);
    const canonIds = nodes.map(n => n.canon_id);

    // Build a readable description from the requirements (not a wall of text)
    const requirements = nodes.filter(n => n.type === 'REQUIREMENT').slice(0, 5);
    const constraints = nodes.filter(n => n.type === 'CONSTRAINT' || n.type === 'INVARIANT');
    const description = requirements.map(n => n.statement).join('. ');

    const iuId = sha256(['iu', serviceName, name, ...canonIds.sort()].join('\x00'));

    // Derive typed inputs/outputs from node statements
    const { inputs, outputs } = deriveContract(nodes, name);

    ius.push({
      iu_id: iuId,
      kind: 'module' as const,
      name,
      risk_tier: riskTier,
      contract: {
        description,
        inputs,
        outputs,
        invariants: constraints.map(n => n.statement),
      },
      source_canon_ids: canonIds,
      dependencies: [],
      boundary_policy: defaultBoundaryPolicy(),
      enforcement: defaultEnforcement(),
      evidence_policy: {
        required: evidenceForTier(riskTier),
      },
      output_files: [`src/generated/${serviceName}/${fileName}.ts`],
    });
  }

  // Sort for deterministic output
  ius.sort((a, b) => a.output_files[0].localeCompare(b.output_files[0]));

  // Model the runtime interface edge: a web-ui module depends on the api modules
  // in its own service (it calls them over the wire). This makes the consumer→
  // provider dependency a real graph edge — the substrate for contract-bearing
  // invalidation (a provider interface change re-runs its consumers) and cascade.
  const serviceDir = (iu: ImplementationUnit) => iu.output_files[0]?.split('/').slice(0, -1).join('/') ?? '';
  const isWebUI = (iu: ImplementationUnit) => /\b(web|ui|frontend|interface|page|dashboard)\b/.test(iu.name.toLowerCase());
  for (const iu of ius) {
    if (!isWebUI(iu)) continue;
    iu.dependencies = ius
      .filter(o => o.iu_id !== iu.iu_id && !isWebUI(o) && serviceDir(o) === serviceDir(iu))
      .map(o => o.iu_id);
  }

  return ius;
}

// ─── Plan inspection (O5/O10, appendix #5) ──────────────────────────────────

/** Default node-count above which a module is flagged a generation risk. */
export const DEFAULT_IU_SIZE_THRESHOLD = 12;

export interface PlanModuleReport {
  iu_id: string;
  name: string;
  outputPath: string;
  role: 'api' | 'web-ui';
  sourceNodeCount: number;
  /** Source headings (doc › section) that fed this module. */
  headings: string[];
  oversized: boolean;
  /**
   * Likely to exceed the output-token budget at generation (T4) — the
   * output-size basis for the oversize risk, distinct from `oversized` (a
   * source-node-count proxy). A web-UI module that emits a large SPA trips this
   * before generation burns attempts.
   */
  overBudget: boolean;
  /** Up-front cost estimate so risk is visible before generation. */
  estimate: { nodes: number; approxTokens: number; outputTokens: number };
}

export interface PlanReport {
  modules: PlanModuleReport[];
  /** Flattened heading→module mapping — makes fragmentation visible. */
  headingToModule: { heading: string; module: string }[];
  sizeThreshold: number;
  oversizedCount: number;
  /** Spec-shape anti-patterns surfaced at plan time, each with a fix (F2/F4). */
  warnings: SpecShapeWarning[];
}

/**
 * A spec-shape anti-pattern detected at plan time (F2), paired with the
 * concrete remediation the author should apply (F4). Feedback only — Phoenix
 * advises; it never rewrites the spec.
 */
export interface SpecShapeWarning {
  kind: 'fragmented-ui' | 'normative-intro' | 'empty-section' | 'over-output-budget';
  /** What will generate poorly. */
  message: string;
  /** The concrete fix to apply to the spec. */
  remediation: string;
  /** Source section heading(s) this warning is about. */
  headings: string[];
  /** Module(s) the offending content lands in, when applicable. */
  module?: string;
}

/**
 * UI vocabulary scanned against section *body* text (not headings) to decide
 * whether sibling `##` sections describe one cohesive UI. Body-level scanning
 * is what catches UI sections whose names ("Loading", "Editing", "Styling")
 * don't themselves signal a UI. Tunable.
 */
const UI_LEXICON =
  /\b(render(?:s|ed|ing)?|DOM|CSS|stylesheet|styl(?:e|es|ed|ing)|button|HTML|browser|click(?:s|ed|ing)?|contenteditable|keystroke|keypress|viewport|layout|frontend|front-end|single-page|web ?page|web app|caret|cursor|scroll|hover)\b/i;

export interface PlanReportOptions {
  /** Node-count threshold for the oversize flag. */
  sizeThreshold?: number;
  /**
   * Output-token budget a module's estimated output must stay under to avoid an
   * `over-output-budget` warning (T4). Defaults to the generator's budget
   * (`GENERATE_MAX_TOKENS`, env `PHOENIX_GENERATE_MAX_TOKENS`).
   */
  outputBudget?: number;
}

/** Rough generation-size proxy: ~150 tokens of output per source node. */
function approxTokensFor(nodeCount: number): number {
  return nodeCount * 150;
}

/**
 * Role-aware output-token estimate — the *output* basis for the budget flag (T4).
 * A web-UI module emits an entire inline-HTML SPA (page shell + per-feature UI),
 * so it produces far more output per source node than a compact API handler.
 * This is the genuine output signal the diagnosis asked for, replacing the prior
 * source-node-count-only proxy.
 */
export function estimateOutputTokens(role: 'api' | 'web-ui', nodeCount: number): number {
  if (role === 'web-ui') return 6000 + nodeCount * 1500; // SPA shell + per-feature UI
  return nodeCount * 200; // API handlers are compact
}

/**
 * Analyze a plan for inspection BEFORE generation (O5): per-module name, path,
 * role, source-node count, the heading→module mapping, and an oversize flag
 * with an estimate (O10). Pure — does not generate or write anything.
 */
export function analyzePlan(
  ius: ImplementationUnit[],
  canonNodes: CanonicalNode[],
  clauses: Clause[],
  opts?: PlanReportOptions,
): PlanReport {
  const threshold = opts?.sizeThreshold ?? DEFAULT_IU_SIZE_THRESHOLD;
  const outputBudget = opts?.outputBudget ?? GENERATE_MAX_TOKENS;
  const nodeById = new Map(canonNodes.map(n => [n.canon_id, n]));
  const clauseById = new Map(clauses.map(c => [c.clause_id, c]));
  const roleByIuId = new Map(deriveInterfaces(ius, canonNodes).map(e => [e.iu_id, e.role]));

  const headingFor = (clause: Clause): string => {
    const doc = clause.source_doc_id;
    const section = clause.section_path.length > 1
      ? clause.section_path.slice(1).join(' › ')
      : (clause.section_path[0] ?? 'main');
    return `${doc} › ${section}`;
  };

  const modules: PlanModuleReport[] = [];
  const headingToModule: { heading: string; module: string }[] = [];

  for (const iu of ius) {
    const headings = new Set<string>();
    for (const canonId of iu.source_canon_ids) {
      const node = nodeById.get(canonId);
      if (!node) continue;
      for (const clauseId of node.source_clause_ids) {
        const clause = clauseById.get(clauseId);
        if (clause) headings.add(headingFor(clause));
      }
    }
    const nodeCount = iu.source_canon_ids.length;
    const sortedHeadings = [...headings].sort();
    for (const h of sortedHeadings) headingToModule.push({ heading: h, module: iu.name });

    const role = roleByIuId.get(iu.iu_id) ?? 'api';
    const outputTokens = estimateOutputTokens(role, nodeCount);

    modules.push({
      iu_id: iu.iu_id,
      name: iu.name,
      outputPath: iu.output_files[0] ?? '',
      role,
      sourceNodeCount: nodeCount,
      headings: sortedHeadings,
      oversized: nodeCount > threshold,
      overBudget: outputTokens > outputBudget,
      estimate: { nodes: nodeCount, approxTokens: approxTokensFor(nodeCount), outputTokens },
    });
  }

  // Over-budget modules become spec-shape warnings with the same remediation as
  // the generation-time hard-fail (T3/T4), so the author hears it at plan time.
  const budgetWarnings: SpecShapeWarning[] = modules
    .filter(m => m.overBudget)
    .map(m => ({
      kind: 'over-output-budget' as const,
      message:
        `${m.name} is likely to exceed the output token budget ` +
        `(~${m.estimate.outputTokens} tokens > ${outputBudget}) and would be truncated at generation.`,
      remediation:
        `Raise PHOENIX_GENERATE_MAX_TOKENS or split '${m.name}' into smaller \`##\` sections.`,
      headings: m.headings,
      module: m.name,
    }));

  return {
    modules,
    headingToModule: headingToModule.sort((a, b) => a.heading.localeCompare(b.heading)),
    sizeThreshold: threshold,
    oversizedCount: modules.filter(m => m.oversized).length,
    warnings: [...detectSpecShapeWarnings(ius, canonNodes, clauses), ...budgetWarnings],
  };
}

// ─── Spec-shape feedback (F2/F4) ─────────────────────────────────────────────

/** Per (doc, top-level `##` section) aggregate used by the shape detectors. */
interface SectionShape {
  docId: string;
  /** Top-level section name (`section_path[1]`, or `section_path[0]`). */
  section: string;
  /** Content sat before any heading. */
  isPreamble: boolean;
  /** Content sat directly under the document H1 (no `##` wrapper). */
  isBareH1: boolean;
  /** Concatenated raw body text — scanned for UI vocabulary. */
  body: string;
  /** Count of non-CONTEXT canonical nodes this section produced. */
  nonContextNodes: number;
  /** Module names this section's nodes landed in. */
  modules: Set<string>;
}

/**
 * Detect spec-shape anti-patterns at plan time (F2) and pair each with a
 * concrete remediation (F4). Pure — reads the same provenance chain
 * (IU → canon → clause → section) that `analyzePlan` uses. Detects:
 *  - fragmented-ui:   a cohesive UI split across `##` sections → many modules.
 *  - normative-intro: an intro/preamble carrying requirements → spurious module.
 *  - empty-section:   a `##` section with no requirement content → empty/stub.
 */
export function detectSpecShapeWarnings(
  ius: ImplementationUnit[],
  canonNodes: CanonicalNode[],
  clauses: Clause[],
): SpecShapeWarning[] {
  const nodeById = new Map(canonNodes.map(n => [n.canon_id, n]));
  const clauseById = new Map(clauses.map(c => [c.clause_id, c]));

  const keyOf = (c: Clause) => `${c.source_doc_id}\x00${sectionNameOf(c)}`;

  // Seed one SectionShape per (doc, top-level section) from the clauses, so
  // even sections that produce no module (context-only) are represented.
  const sections = new Map<string, SectionShape>();
  for (const c of clauses) {
    const key = keyOf(c);
    let s = sections.get(key);
    if (!s) {
      const sp = c.section_path;
      s = {
        docId: c.source_doc_id,
        section: sectionNameOf(c),
        isPreamble: sp[0] === '(preamble)',
        isBareH1: sp[0] !== '(preamble)' && sp.length === 1,
        body: '',
        nonContextNodes: 0,
        modules: new Set(),
      };
      sections.set(key, s);
    }
    s.body += '\n' + c.raw_text;
  }

  // Attribute each non-CONTEXT node (and the module it landed in) to its section.
  const moduleOfCanon = new Map<string, string>();
  for (const iu of ius) {
    for (const id of iu.source_canon_ids) moduleOfCanon.set(id, iu.name);
  }
  for (const node of canonNodes) {
    if (node.type === CanonicalType.CONTEXT) continue;
    const clause = node.source_clause_ids.map(id => clauseById.get(id)).find(Boolean);
    if (!clause) continue;
    const s = sections.get(keyOf(clause));
    if (!s) continue;
    s.nonContextNodes++;
    const mod = moduleOfCanon.get(node.canon_id);
    if (mod) s.modules.add(mod);
  }

  const warnings: SpecShapeWarning[] = [];

  // ── F2a: a cohesive UI fragmented across sibling `##` sections ──
  // UI sections (body hits the lexicon, ≥1 module) that landed in ≥2 distinct
  // modules didn't compose — flag them so the author can merge to one section.
  const uiSectionsByDoc = new Map<string, SectionShape[]>();
  for (const s of sections.values()) {
    if (s.isPreamble || s.modules.size === 0) continue;
    if (!UI_LEXICON.test(s.body)) continue;
    const list = uiSectionsByDoc.get(s.docId) ?? [];
    list.push(s);
    uiSectionsByDoc.set(s.docId, list);
  }
  for (const uiSections of uiSectionsByDoc.values()) {
    const modules = new Set<string>();
    for (const s of uiSections) for (const m of s.modules) modules.add(m);
    if (uiSections.length >= 2 && modules.size >= 2) {
      const names = uiSections.map(s => s.section).sort();
      const quoted = names.map(n => `'${n}'`).join(', ');
      warnings.push({
        kind: 'fragmented-ui',
        message: `These ${names.length} sections each become a separate module; a cohesive UI is usually one module.`,
        remediation: `Merge sections ${quoted} under one \`## Web Experience\` to generate a single page module.`,
        headings: names,
      });
    }
  }

  // ── F2b: an intro/preamble carrying normative content → spurious module ──
  for (const s of sections.values()) {
    if (!(s.isPreamble || s.isBareH1) || s.nonContextNodes === 0) continue;
    const where = s.isPreamble ? 'The document intro' : `The overview "${s.section}"`;
    warnings.push({
      kind: 'normative-intro',
      message: `${where} carries requirements, so it becomes its own module.`,
      remediation: `Make this intro descriptive, or move its requirements into a \`##\` section.`,
      headings: [s.section],
      module: [...s.modules][0],
    });
  }

  // ── F2c: a `##` section with no requirement content → empty/stub module ──
  for (const s of sections.values()) {
    if (s.isPreamble || s.isBareH1 || s.nonContextNodes > 0) continue;
    warnings.push({
      kind: 'empty-section',
      message: `Section "${s.section}" has no requirement content (all context), so it generates an empty/stub module.`,
      remediation: `Add requirement ('must'/'shall') content to section '${s.section}', or remove it if it is context-only.`,
      headings: [s.section],
    });
  }

  return warnings;
}

/**
 * Top-level grouping name for a clause — matches `planIUs`' bucket key:
 * `section_path[1]` (the `##` under the doc H1), else `section_path[0]`.
 */
function sectionNameOf(clause: Clause): string {
  return clause.section_path.length > 1
    ? clause.section_path[1]
    : clause.section_path[0] || 'main';
}

/**
 * Derive a service name from a document ID.
 * "spec/api-gateway.md" → "api-gateway"
 * "spec/deep/user-service.md" → "user-service"
 * "test.md" → "test"
 */
function deriveServiceName(docId: string): string {
  const base = docId.split('/').pop() || docId;
  return slugify(base.replace(/\.md$/i, ''));
}

/**
 * Clean up a section name to be a natural IU name.
 * "Security Constraints" → "Security Constraints"
 * "3.2 Authentication" → "Authentication"
 */
function cleanName(raw: string): string {
  return raw
    .replace(/^\d+(\.\d+)*\s*/, '')   // strip leading numbers
    .replace(/\s+/g, ' ')
    .trim() || 'Main';
}

/**
 * Derive typed contract inputs/outputs from canonical nodes.
 */
function deriveContract(
  nodes: CanonicalNode[],
  sectionName: string,
): { inputs: string[]; outputs: string[] } {
  const inputs: string[] = [];
  const outputs: string[] = [];

  // Look for common patterns in statements
  const allStatements = nodes.map(n => n.statement).join(' ');

  if (/\brequest\b/i.test(allStatements)) inputs.push('request');
  if (/\buser\b/i.test(allStatements) && /\b(?:create|account|authenticate)\b/i.test(allStatements)) inputs.push('user');
  if (/\btoken\b/i.test(allStatements)) inputs.push('token');
  if (/\btemplate\b/i.test(allStatements)) inputs.push('template');
  if (/\bnotification|message\b/i.test(allStatements)) inputs.push('notification');
  if (/\bconfig\b/i.test(allStatements)) inputs.push('config');

  if (/\bresponse\b/i.test(allStatements)) outputs.push('response');
  if (/\bresult\b/i.test(allStatements)) outputs.push('result');
  if (/\bevent\b/i.test(allStatements)) outputs.push('event');

  return { inputs, outputs };
}

function deriveRiskTier(nodes: CanonicalNode[]): 'low' | 'medium' | 'high' | 'critical' {
  const hasConstraint = nodes.some(n => n.type === 'CONSTRAINT');
  const hasInvariant = nodes.some(n => n.type === 'INVARIANT');
  const size = nodes.length;

  if (hasInvariant) return 'high';
  if (hasConstraint && size > 2) return 'high';
  if (hasConstraint) return 'medium';
  if (size > 3) return 'medium';
  return 'low';
}

function evidenceForTier(tier: string): string[] {
  switch (tier) {
    case 'low': return ['typecheck', 'lint', 'boundary_validation'];
    case 'medium': return ['typecheck', 'lint', 'boundary_validation', 'unit_tests'];
    case 'high': return ['typecheck', 'lint', 'boundary_validation', 'unit_tests', 'property_tests', 'static_analysis'];
    case 'critical': return ['typecheck', 'lint', 'boundary_validation', 'unit_tests', 'property_tests', 'static_analysis', 'human_signoff'];
    default: return ['typecheck'];
  }
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}
