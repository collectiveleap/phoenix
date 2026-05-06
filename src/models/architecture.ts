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
