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

import type { InterfaceDialect } from './interface-contract.js';

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

// ─── Runtime Target (language/framework specific) ───────────────────────────

export interface RuntimeTarget {
  /** Unique name, e.g., 'node-typescript' */
  name: string;
  /** Human description */
  description: string;
  /** Language: 'typescript', 'python', 'go', etc. */
  language: string;

  /**
   * Minimum runtime major version this target needs (e.g. 22 for Node 22).
   * Surfaced so preflight can verify it; absent ⇒ preflight uses its default.
   */
  minNodeMajor?: number;
  /**
   * Which of `packages` need a C toolchain to build (e.g. ['better-sqlite3']).
   * Drives whether the environment contract requires a compiler and whether
   * Phoenix runs a native build step. Absent/empty ⇒ no native deps.
   */
  nativeDeps?: string[];

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

  /** Shared boilerplate files: relative path → file content */
  sharedFiles: Record<string, string>;
  /** Extra package.json / pyproject.toml fields */
  packageExtras: Record<string, unknown>;

  /**
   * Translates the neutral inter-module interface contract to this target's
   * transport (REST URLs, RPC names, message topics, …). Absent ⇒ this target has
   * no runtime module decoupling, so the internal-static boundary (`allowed_ius`)
   * governs and no runtime-interface contract is enforced.
   */
  interfaceDialect?: InterfaceDialect;
}

// ─── Resolved target (what the pipeline actually uses) ──────────────────────

export interface ResolvedTarget {
  architecture: Architecture;
  runtime: RuntimeTarget;
}
