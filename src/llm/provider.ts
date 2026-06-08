/**
 * LLM Provider — pluggable interface for code generation.
 *
 * Providers implement a single method: generate code from a prompt.
 * Phoenix auto-detects available providers from env vars and saves
 * a preference in .phoenix/config.json.
 */

export interface LLMProvider {
  /** Provider name for display/config. */
  readonly name: string;

  /** Model identifier being used. */
  readonly model: string;

  /**
   * Generate a completion from a prompt.
   * Returns the raw text response. Thin wrapper over generateStream.
   */
  generate(prompt: string, options?: GenerateOptions): Promise<string>;

  /**
   * Generate a completion, emitting lifecycle hooks as bytes arrive so the
   * caller can observe time-to-first-byte and stream liveness (PRD O1/O2).
   * Returns the full text once the stream ends.
   */
  generateStream(prompt: string, options?: GenerateOptions, hooks?: StreamHooks): Promise<string>;
}

/**
 * Lifecycle callbacks fired during a streaming generation. All optional;
 * providers fire what they can. Bytes are cumulative UTF-8 byte counts.
 */
export interface StreamHooks {
  /** First byte of the response has arrived. */
  onFirstByte?: () => void;
  /** A chunk arrived. `totalBytes` is cumulative; `deltaText` is the new text. */
  onChunk?: (totalBytes: number, deltaText: string) => void;
  /** The provider's output stream has ended (before final resolution). */
  onStreamEnd?: () => void;
  /**
   * The provider reported the generation's stop reason (e.g. `end_turn`,
   * `max_tokens` / `length`). Fired at most once, when the reason is known.
   * A `max_tokens`/`length` reason means the output was truncated at the budget,
   * not a stall — the harness uses this to avoid futile retries (T2/T3).
   */
  onStopReason?: (reason: string) => void;
}

/** Normalize a provider's truncation stop reason. */
export function isTruncationStopReason(reason: string | undefined): boolean {
  return reason === 'max_tokens' || reason === 'length';
}

export interface GenerateOptions {
  /** Max tokens to generate. */
  maxTokens?: number;
  /** Temperature (0 = deterministic, 1 = creative). */
  temperature?: number;
  /** System prompt / role. */
  system?: string;
  /** Abort signal — the watchdog uses this to kill a stalled call. */
  signal?: AbortSignal;
  /**
   * Per-call model override (G2). When set, the provider uses this model for this
   * call instead of its constructed default — lets a single run use a capable
   * model for the hard module and a cheaper one for simple modules. The effective
   * model (`model ?? provider.model`) is what gets recorded in the journal/manifest.
   */
  model?: string;
}

export interface LLMConfig {
  provider: string;
  model: string;
  /** Override path to the `claude` CLI binary (for non-standard installs). */
  claudeCliPath?: string;
  /**
   * Per-role model overrides (G2), e.g. `{ "web-ui": "opus", "api": "sonnet" }`.
   * A module's role selects its generation model; unset roles use `model`.
   */
  modelsByRole?: Record<string, string>;
}

/**
 * Default models per provider. Keep current — a stale default silently generates
 * with an out-of-date model (G3). The drift guard in `resolve.test.ts` asserts
 * these match the intended current IDs so the next staleness fails CI, not a run.
 */
export const DEFAULT_MODELS: Record<string, string> = {
  anthropic: 'claude-sonnet-4-6', // current Sonnet (was Sonnet 4.0 'claude-sonnet-4-20250514')
  openai: 'gpt-4o',
  'claude-cli': 'sonnet', // alias — the CLI resolves it to the latest Sonnet
};
