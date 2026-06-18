/**
 * Run Provenance — the captured causal chain of one regeneration run.
 *
 * Phoenix's mission (PRD §0; Chad Fowler's "The Phoenix Primitives") names provenance an irreducible
 * artifact: "an audit trail capturing which spec version, evaluation suite, and trigger produced each
 * implementation." Its job is root-cause-over-narrative — NOT establishing correctness (the evaluations
 * do that), but making a divergence between two runs *explainable* by localizing where their causal
 * chains forked. Records carry the producing Phoenix commit, so the same `diffRuns` primitive answers
 * both "is generation deterministic this session?" and "did a Phoenix change improve the target's
 * determinism, version-over-version?".
 */

export type TriggerKind = 'verify' | 'regen' | 'drift';

export interface ProvenanceProducer {
  /** The Phoenix commit that produced this run — the join key across loop-bramble-regen / loop-improve-phoenix. */
  phoenix_version: string;
  /** Dirty Phoenix working tree at build time? */
  phoenix_dirty: boolean;
  /** The generation model id (e.g. the claude-cli model). */
  generator_model: string;
}

export interface ProvenanceTrigger {
  kind: TriggerKind;
  /** Semantic hash of the spec that drove this run. */
  spec_semhash: string;
  /** Identity of the evaluation suite applied (the acceptance check-set). */
  eval_suite_hash: string;
}

export interface ProvenanceInputs {
  /** Hash of the ordered clause set. */
  clause_set_hash: string;
  /** Hash of the canonical requirement graph. */
  canonical_graph_hash: string;
  /** provider_iu_id → contract_hash consumed, unioned across IUs. */
  contract_hashes: Record<string, string>;
}

export interface IUProvenance {
  iu_id: string;
  name: string;
  source_canon_ids: string[];
  generation: {
    /** Fold of the IU's generated file content-hashes — identical hash ⇒ byte-identical output. */
    code_hash: string;
    model?: string;
    strategy?: string;
    outcome?: string;
  };
  /** The per-IU policy verdict (PASS / FAIL / INCOMPLETE). */
  decision: string;
}

/** A run-level acceptance evaluator result (typecheck, boot, unit_tests, ui_behavior, …). */
export interface ProvenanceCheck {
  name: string;
  ok: boolean;
}

export interface RunProvenance {
  run_id: string;
  created_at: string;
  producer: ProvenanceProducer;
  trigger: ProvenanceTrigger;
  inputs: ProvenanceInputs;
  checks: ProvenanceCheck[];
  ius: IUProvenance[];
  /** Order-independent acceptance signature (see harness verdictSignature). */
  verdict_signature: string;
  /** Hash of the whole generated tree. */
  tree_hash: string;
  overall: 'ok' | 'fail';
}

/** Compact index line persisted to runs.jsonl — enough to list/filter without loading full records. */
export interface RunHeader {
  run_id: string;
  created_at: string;
  phoenix_version: string;
  trigger_kind: TriggerKind;
  verdict_signature: string;
  overall: 'ok' | 'fail';
  tree_hash: string;
}

// ─── Divergence classification ──────────────────────────────────────────────

/**
 * The stage at which a set of runs' causal chains first fork, ordered upstream→downstream. The FIRST
 * forking stage is the root cause: a generation fork downstream of identical inputs is the generator's
 * non-determinism; a verdict fork downstream of identical code is the evaluator's.
 */
export type DivergenceStage =
  | 'none'         // identical across runs — deterministic
  | 'inputs'       // clause set / canonical graph / contracts differ (canonicalization, upstream)
  | 'generation'   // inputs identical, an IU's generated code differs
  | 'evaluation';  // code identical, an evaluator verdict differs (the evaluator is non-deterministic)

export interface DivergenceDetail {
  /** What forked, e.g. 'canonical_graph' | 'contract:<id>' | '<iu_id>' | 'check:<name>'. */
  key: string;
  /** The distinct values observed across the runs (hashes or verdicts; '∅' = absent in some run). */
  variants: string[];
}

export interface DivergenceReport {
  run_ids: string[];
  stage: DivergenceStage;
  details: DivergenceDetail[];
  /** True when every run shares the same verdict_signature (the determinism gate's pass condition). */
  verdict_stable: boolean;
  verdict_signatures: string[];
}
