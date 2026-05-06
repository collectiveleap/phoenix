/**
 * Architecture & Runtime Target
 *
 * Architecture defines the SYSTEM SHAPE — communication patterns, data ownership,
 * component grain, evaluation surfaces. Language/runtime agnostic.
 *
 * Runtime Target defines the COMPILATION TARGET — language, frameworks, templates,
 * packages. Implements an architecture in a specific stack.
 *
 * Hierarchy:
 *   Spec (what users want)
 *     → Architecture (what kind of system)
 *       → Runtime Target (what language/framework)
 *         → Generated Code
 */

// ─── Eval runner ────────────────────────────────────────────────────────────
//
// The architecture provides a `runEvaluation` method that takes a durable
// surface-agnostic Evaluation (parsed Given/When/Then in domain terms) and
// projects it onto the architecture's surface. For web-api: HTTP requests
// against `surface.port`. For a future cli-tool: spawn the binary; capture
// stdin/stdout/argv/exit code. The same Evaluation works against either.
//
// See docs/SUCCESS-CRITERIA.md for the design rationale.

import type { Evaluation } from './evaluation.js';

/** What surface the eval runner targets. For web-api: an HTTP port. */
export interface EvalSurface {
  /** HTTP port the regenerated app is listening on. */
  port: number;
}

/** What the runner needs to know about the resolved canonical/IU graph. */
export interface EvalContext {
  /** All IUs in the current canonical graph. */
  ius: Array<{ iu_id: string; name: string }>;
  /** Interface registry — for mapping IU/section names to mount paths. */
  interfaces: Array<{ iu_id: string; name: string; mount_path: string; role: 'api' | 'web-ui' }>;
}

/** Outcome of running one Evaluation against a surface. */
export interface EvalResult {
  eval_id: string;
  name: string;
  pass: boolean;
  reason?: string;
}

// ─── Architecture (system shape, language-agnostic) ─────────────────────────

export interface Architecture {
  /** Unique name, e.g., 'web-api' */
  name: string;
  /** Human description */
  description: string;

  /** How components communicate: 'rest', 'graphql', 'grpc', 'events', 'cli' */
  communicationPattern: string;
  /** How data is owned: 'per-component', 'shared-db', 'event-sourced' */
  dataOwnership: string;
  /** How to verify components: 'http-endpoints', 'unit-tests', 'cli-output' */
  evaluationSurface: string;

  /** Architecture-level prompt: describes system shape for the LLM (no language specifics) */
  systemPrompt: string;

  /** Available runtime targets for this architecture */
  runtimeTargets: string[];

  /**
   * Run a durable Evaluation against the regenerated implementation's
   * surface. The Evaluation is surface-agnostic (Given/When/Then in domain
   * language); the architecture provides step definitions that translate
   * each step into surface operations and assertions.
   *
   * Returns one EvalResult per evaluation. The deletion test asserts that
   * every result.pass is true.
   */
  runEvaluation(
    evaluation: Evaluation,
    surface: EvalSurface,
    context: EvalContext,
  ): Promise<EvalResult>;
}

import type { ImplementationUnit } from './iu.js';

// ─── Service descriptor (input to RuntimeTarget.generateServiceTests) ───────

/**
 * A logical service — a directory under src/generated/ containing one or
 * more IU module files. Pre-computed by scaffold from the IU plan, then
 * passed to runtime methods that need to know about the service's modules.
 *
 * Lives here (rather than in scaffold.ts) so the RuntimeTarget interface
 * can reference it without a circular import.
 */
export interface ServiceDescriptor {
  /** Service name, e.g. "api-gateway" */
  name: string;
  /** Directory under src/generated/, e.g. "api-gateway" */
  dir: string;
  /** Module file names (without path prefix), e.g. ["authentication.ts", "rate-limiting.ts"] */
  modules: string[];
  /** The IUs belonging to this service */
  ius: ImplementationUnit[];
  /** Default port for this service */
  port: number;
}

// ─── Route wiring (input to RuntimeTarget.generateServerEntry) ──────────────

/**
 * A single mounted route — pre-computed by scaffold from services and the
 * interface registry, then handed to the runtime target's server generator.
 *
 * Decouples runtime targets from scaffold internals: a target only needs to
 * know what to mount where, not how mount paths are derived.
 */
export interface RouteWiring {
  /** Variable name for the import (e.g., 'projects', 'web_experience'). */
  importName: string;
  /** Path relative to src/ (e.g., './generated/todos/projects.js'). */
  importPath: string;
  /** Mount prefix from the interface registry (e.g., '/projects' or ''). */
  mountPath: string;
}

// ─── Runtime Target (language/framework specific) ───────────────────────────

export interface RuntimeTarget {
  /** Unique name, e.g., 'node-typescript' */
  name: string;
  /** Human description */
  description: string;
  /** Language: 'typescript', 'python', 'go', etc. */
  language: string;

  /** Production dependencies: package name → version range */
  packages: Record<string, string>;
  /** Dev dependencies */
  devPackages: Record<string, string>;

  /** Module template — the LLM fills in marked sections, structure is guaranteed */
  moduleTemplate: string;
  /** LLM prompt extension — language/framework-specific rules */
  promptExtension: string;
  /** Few-shot code examples showing the exact patterns */
  codeExamples: string;
  /**
   * Runtime-specific "MANDATORY imports" prompt block, spliced into the user
   * prompt for live LLM regen. Owns its own markdown formatting; should
   * include both the required import lines and any "do not import X" guidance
   * that's specific to this target's package set. Ignored in stub mode.
   */
  mandatoryImports: string;
  /**
   * Import-path substrings that `assembleFromTemplate` strips from LLM
   * output before splicing it into the module template. The template
   * re-provides these imports verbatim, so any LLM-added duplicates would
   * conflict.
   *
   * Each entry is matched as a substring against the trimmed import line
   * (e.g., 'better-sqlite3' matches `import Database from 'better-sqlite3'`).
   *
   * Should include the runtime's own driver package(s) so LLM hallucinations
   * referencing them get cleaned up.
   */
  stripImportPatterns: string[];
  /**
   * Generate the contents of src/server.ts for this runtime. Receives a
   * flat list of routes to wire up; the runtime decides how to import,
   * mount, and boot them. Hono targets emit serve({ fetch: app.fetch });
   * a Bun target would emit Bun.serve(); Express would emit app.listen().
   */
  generateServerEntry(routes: RouteWiring[]): string;
  /**
   * Generate a minimal stub module body for the given IU. Used in stub
   * mode (no LLM) to produce a syntactically valid module that exports
   * whatever the framework conventionally expects (Hono router, Express
   * router, FastAPI APIRouter, etc.). Must include the standard `_phoenix`
   * metadata constant for traceability.
   */
  generateModuleStub(iu: ImplementationUnit): string;
  /**
   * Generate the per-service vitest file content for IUs in this runtime.
   * The runtime owns the assertions because they're framework-shaped
   * (Hono routers expose .fetch; Express routers don't).
   */
  generateServiceTests(svc: ServiceDescriptor): string;
  /**
   * Generate the project-config files this runtime needs at the project
   * root: manifest (package.json / pyproject.toml / go.mod), language
   * config (tsconfig.json), test config, etc. Each runtime owns its
   * complete set; scaffold splats them into the project verbatim.
   *
   * Returns a Map of <relative-path, content>. Path keys are relative
   * to the project root.
   */
  generateProjectFiles(projectName: string, services: ServiceDescriptor[]): Map<string, string>;

  /** Shared boilerplate files: relative path → file content */
  sharedFiles: Record<string, string>;
  /** Extra package.json / pyproject.toml fields */
  packageExtras: Record<string, unknown>;
}

// ─── Resolved target (what the pipeline actually uses) ──────────────────────

export interface ResolvedTarget {
  architecture: Architecture;
  runtime: RuntimeTarget;
}
