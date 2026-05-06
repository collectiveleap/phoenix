/**
 * Evaluation model — durable behavioral truth surface.
 *
 * Evaluations bind to behavior at IU boundaries, not to implementation internals.
 * They survive regeneration. The separating question: "Would this assertion still
 * be meaningful if the entire implementation were replaced tomorrow?"
 *
 * Distinct from implementation tests, which die with the code they describe.
 * (See: Fowler, The Phoenix Architecture — "Evaluations Are the Real Codebase".)
 *
 * The model has two strata:
 *
 *   ┌─ DURABLE ───────────────────────────────────────────────────────┐
 *   │ Authored once (or suggested by observation) and stored under    │
 *   │ evals/*.feature (see docs/SUCCESS-CRITERIA.md). Surface- and    │
 *   │ runtime-target-agnostic. Domain language only.                  │
 *   │   - name, subject, given/when/then, origin                      │
 *   └──────────────────────────────────────────────────────────────────┘
 *
 *   ┌─ RESOLVED (ephemeral) ──────────────────────────────────────────┐
 *   │ Populated each `phoenix bootstrap` run by resolving the         │
 *   │ subject against the current canonical graph + IU plan.          │
 *   │   - iu_id, canon_ids, resolved_at, last_status                  │
 *   └──────────────────────────────────────────────────────────────────┘
 *
 * The durable layer is owned by the user. The resolved layer regenerates.
 */

/** What the evaluation asserts about */
export type EvaluationBinding =
  | 'domain_rule'        // business logic invariant
  | 'boundary_contract'  // input/output shape at IU boundary
  | 'constraint'         // latency, throughput, error rate
  | 'invariant'          // property that holds across all states
  | 'failure_mode';      // behavior under error conditions

/** How the evaluation was created */
export type EvaluationOrigin =
  | 'specified'          // derived from spec/intent (hand-authored)
  | 'characterization'   // captured from an existing implementation (legacy)
  | 'observed'           // suggested by production observation (iter 13+)
  | 'incident'           // added after a production incident
  | 'audit';             // added during evaluation audit

// ─── Step types ────────────────────────────────────────────────────────────
//
// Steps are domain-language directives. Surface-agnostic. Each architecture
// provides step definitions that translate these into operations on its own
// surface (HTTP requests for web-api; CLI invocations for cli-tool; etc.).
//
// For iter 12 we lean on the parser (gherkin) returning the raw text of each
// step, plus the step kind. Step matching against architecture-provided step
// definitions happens at runEvaluation time.

/** A Given step: precondition. */
export interface GivenStep {
  /** Raw natural-language text of the step (without leading "Given"/"And"). */
  text: string;
}

/** A When step: action at the IU boundary. */
export interface WhenStep {
  /** Raw natural-language text of the step (without leading "When"/"And"). */
  text: string;
}

/** A Then step: expected observable outcome. */
export interface ThenStep {
  /** Raw natural-language text of the step (without leading "Then"/"And"). */
  text: string;
}

// ─── Evaluation ────────────────────────────────────────────────────────────

export interface Evaluation {
  /** Unique ID, content-addressed by the durable description. */
  eval_id: string;

  // ─── DURABLE ──────────────────────────────────────────────────────────────

  /** Scenario name, slug-cased. */
  name: string;
  /** What this evaluation is about, in canonical/domain terms. */
  subject: {
    /** Coordinate into durable spec text — heading path. e.g. ["Tasks"] */
    spec_section: string[];
    /** Natural-language phrase describing the behavior tested. */
    describes: string;
    /** What category of property this evaluation asserts. */
    binding: EvaluationBinding;
  };
  /** Preconditions for the scenario. */
  given: GivenStep[];
  /** Action(s) at the IU boundary. */
  when: WhenStep[];
  /** Expected observable outcome(s). */
  then: ThenStep[];
  /** How this evaluation was created. */
  origin: EvaluationOrigin;
  /** Surface-stability evaluation flag (conservation-layer; future iterations). */
  conservation: boolean;
  /** Provenance: free-form rationale for why this evaluation exists. */
  rationale?: string;
  /** Link to incident/decision that motivated this. */
  provenance_ref?: string;
  /** Created timestamp (ISO-8601). */
  created_at: string;

  // ─── RESOLVED (populated during phoenix bootstrap; ephemeral) ──────────────

  /**
   * Which IU boundary this resolved to in the current canonical graph.
   * Populated at bootstrap by matching subject.spec_section against IU names.
   * Iter 13+ replaces the simple resolver with full canonicalization integration.
   */
  iu_id?: string;
  /** Canonical node IDs this evaluation covers in the current canonical graph. */
  canon_ids?: string[];
  /** When the resolution was last performed (ISO-8601). */
  resolved_at?: string;
  /** When the eval was last run against a regenerated implementation. */
  last_verified_at?: string;
  /** Status of last verification. */
  last_status?: 'pass' | 'fail' | 'untested';
}

/**
 * Evaluation coverage report for an IU
 */
export interface EvaluationCoverage {
  iu_id: string;
  iu_name: string;
  total_evaluations: number;
  by_binding: Record<EvaluationBinding, number>;
  by_origin: Record<EvaluationOrigin, number>;
  canon_ids_covered: string[];
  canon_ids_uncovered: string[];
  coverage_ratio: number;
  conservation_count: number;
  /** Gap analysis */
  gaps: EvaluationGap[];
}

export interface EvaluationGap {
  category: 'missing_boundary' | 'missing_invariant' | 'missing_failure_mode' | 'untested' | 'stale';
  subject: string;
  message: string;
  recommended_action: string;
}
