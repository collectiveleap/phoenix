/**
 * Claude CLI LLM Provider.
 *
 * Uses the `claude` CLI in print mode (-p) for code generation.
 * This allows Phoenix to use Claude Code's existing authentication
 * instead of requiring a separate API key.
 *
 * Streaming is implemented with `spawn` (not `execFileSync`) so the caller
 * sees time-to-first-byte and incremental progress (PRD O1/O2), and so a
 * stalled call can be killed via an AbortSignal (O8) rather than a
 * pipe-holding background timer.
 *
 * The CLI is invoked with `--output-format stream-json --verbose` and its JSONL
 * event stream is parsed for assistant text. Default text mode buffers the whole
 * response until completion — emitting zero bytes for minutes on a large module,
 * which the watchdog (O2/O8) misreads as a startup stall and kills mid-generation
 * (S1/S2). Streaming makes first-byte fire in ~2s and `bytesStreamed` rise
 * throughout, so a live call is classified healthy for as long as it produces.
 *
 * Locating + invoking the CLI is Phoenix's job, not the user's (B4): the binary
 * is resolved robustly (override → PATH → known install locations) and invoked
 * with startup-minimizing flags + non-essential-traffic disabled, so the user
 * never has to shim a `claude` onto PATH just to add invocation flags.
 */

import { spawn, execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { LLMProvider, GenerateOptions, StreamHooks } from './provider.js';
import { isTruncationStopReason } from './provider.js';

/**
 * Startup-minimizing flags appended to every invocation (verified against
 * `claude --help`, v2.1.x):
 *  - `--strict-mcp-config` — with no `--mcp-config`, loads no user MCP servers
 *    (a major cold-start cost).
 *  - `--no-chrome` — skip the Claude-in-Chrome integration.
 * Kept as a constant so it is easy to audit and override.
 */
export const STARTUP_FLAGS = ['--strict-mcp-config', '--no-chrome'];

/** Env that disables non-essential traffic to keep cold-boot under budget. */
export const STARTUP_ENV: Record<string, string> = {
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
};

/**
 * Compare dotted version strings numerically (newest sorts last). Each segment
 * is parsed as a leading integer, so pre-release suffixes (`2.1.160-dev`) and
 * stray non-numeric parts compare by their numeric prefix instead of producing
 * NaN (which would make the sort order undefined).
 */
export function compareVersions(a: string, b: string): number {
  const seg = (s: string) => s.split('.').map(p => {
    const n = parseInt(p, 10);
    return Number.isNaN(n) ? 0 : n;
  });
  const pa = seg(a);
  const pb = seg(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** The directory the Claude desktop app installs versioned CLI builds under. */
function desktopCliBase(): string {
  return join(homedir(), 'Library', 'Application Support', 'Claude', 'claude-code');
}

/**
 * Claude Code CLI binaries the desktop app installs, **newest version first**:
 *   <base>/<version>/claude.app/Contents/MacOS/claude
 *
 * Enumerated fresh on every call (no cached version list) so a newly-installed
 * version is picked up, and only version-shaped subdirectories are considered
 * (junk like `.DS_Store` is ignored). `base` is injectable for tests.
 */
export function desktopCliCandidates(base: string = desktopCliBase()): string[] {
  let entries: import('node:fs').Dirent[];
  try {
    entries = readdirSync(base, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter(e => e.isDirectory() && /^\d/.test(e.name)) // version dirs only
    .map(e => e.name)
    .sort((a, b) => compareVersions(b, a)) // newest first
    .map(v => join(base, v, 'claude.app', 'Contents', 'MacOS', 'claude'));
}

/** Well-known install locations to check when `claude` is not on PATH. */
function knownLocations(): string[] {
  const home = homedir();
  return [
    join(home, '.claude', 'local', 'claude'),
    join(home, '.local', 'bin', 'claude'),
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
    ...desktopCliCandidates(),
  ];
}

/** True if running `<path> --version` succeeds. */
function worksAsCli(path: string): boolean {
  try {
    execFileSync(path, ['--version'], { stdio: 'pipe', timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

/** Last successfully-resolved binary, reused while it remains valid. */
let cachedPath: string | null = null;

/**
 * Resolve the `claude` binary: explicit override (arg / PHOENIX_CLAUDE_CLI_PATH)
 * → PATH → known install locations (versioned desktop installs newest-first).
 * Returns null if none works.
 *
 * Handles a newly-installed CLI version: the resolved path is reused only while
 * it still exists on disk, so a desktop auto-update — which installs a new
 * `<version>/` dir and removes the old one — invalidates the cached path and
 * forces re-resolution to the new newest version. A bare `claude` (on PATH) is
 * assumed stable for the process. Absence is not cached, so a CLI installed
 * mid-process is still found (re-resolution is cheap: it only spawns
 * `--version` for paths that exist).
 */
export function resolveClaudePath(override?: string): string | null {
  const explicit = override ?? process.env.PHOENIX_CLAUDE_CLI_PATH;
  if (explicit) return worksAsCli(explicit) ? explicit : null;

  // Reuse the cached binary only while it is still present. 'claude' is a PATH
  // lookup, not a filesystem path, so it can't be existence-checked here.
  if (cachedPath && (cachedPath === 'claude' || existsSync(cachedPath))) return cachedPath;
  cachedPath = null;

  // PATH: bare `claude` resolves via the shell's PATH lookup.
  if (worksAsCli('claude')) { cachedPath = 'claude'; return cachedPath; }

  for (const loc of knownLocations()) {
    if (existsSync(loc) && worksAsCli(loc)) { cachedPath = loc; return cachedPath; }
  }

  return null;
}

/** Reset the resolver cache (tests). */
export function resetClaudePathCache(): void {
  cachedPath = null;
}

/** A single decoded signal from one `stream-json` output line. */
export interface StreamJsonChunk {
  /** Incremental assistant text to append (from assistant / delta events). */
  text?: string;
  /** Authoritative final text (from the terminal `result` event). */
  result?: string;
  /** True when the terminal `result` event reports an error. */
  isError?: boolean;
  /**
   * The generation's stop reason, when an event reports one (e.g. `end_turn`,
   * `max_tokens`). A `max_tokens` reason means the output was truncated at the
   * budget — recognized as truncation, not a stall (T2).
   */
  stopReason?: string;
}

interface RawStreamEvent {
  type?: string;
  subtype?: string;
  is_error?: boolean;
  result?: unknown;
  message?: { content?: Array<{ type?: string; text?: unknown }>; stop_reason?: unknown };
  delta?: { type?: string; text?: unknown; stop_reason?: unknown };
  event?: { delta?: { type?: string; text?: unknown; stop_reason?: unknown } };
}

/**
 * Parse one line of `claude --output-format stream-json` output into the text /
 * result / error signal it carries. Envelope events (system/init, tool events)
 * and blank or non-JSON lines yield `{}`, so the caller can still treat every
 * line as a liveness heartbeat regardless of shape.
 */
export function parseStreamJsonLine(line: string): StreamJsonChunk {
  const trimmed = line.trim();
  if (!trimmed) return {};
  let ev: RawStreamEvent;
  try {
    ev = JSON.parse(trimmed) as RawStreamEvent;
  } catch {
    return {};
  }
  if (!ev || typeof ev !== 'object') return {};

  // Terminal result event — the authoritative, complete final text.
  if (ev.type === 'result') {
    const isError = ev.is_error === true || (typeof ev.subtype === 'string' && ev.subtype !== 'success');
    const result = typeof ev.result === 'string' ? ev.result : undefined;
    return { result, isError };
  }

  // Assistant message — complete text content blocks (default granularity).
  // Its `stop_reason` (when set) carries truncation: `max_tokens` ⇒ over budget.
  if (ev.type === 'assistant' && ev.message && Array.isArray(ev.message.content)) {
    const text = ev.message.content
      .filter((b): b is { type?: string; text: string } => !!b && b.type === 'text' && typeof b.text === 'string')
      .map(b => b.text)
      .join('');
    const stopReason = typeof ev.message.stop_reason === 'string' ? ev.message.stop_reason : undefined;
    const chunk: StreamJsonChunk = {};
    if (text) chunk.text = text;
    if (stopReason) chunk.stopReason = stopReason;
    return chunk;
  }

  // Partial streaming text deltas, if the CLI emits them. A message_delta event
  // carries the stop_reason on `delta.stop_reason`.
  const delta = ev.delta ?? ev.event?.delta;
  if (delta) {
    const chunk: StreamJsonChunk = {};
    if (delta.type === 'text_delta' && typeof delta.text === 'string') chunk.text = delta.text;
    if (typeof delta.stop_reason === 'string') chunk.stopReason = delta.stop_reason;
    if (chunk.text || chunk.stopReason) return chunk;
  }

  return {};
}

export class ClaudeCliProvider implements LLMProvider {
  readonly name = 'claude-cli';
  readonly model: string;
  private readonly cliPathOverride?: string;

  constructor(model: string = 'sonnet', cliPath?: string) {
    this.model = model;
    this.cliPathOverride = cliPath;
  }

  /** The resolved binary, or a bare `claude` fallback if resolution fails. */
  private binary(): string {
    return resolveClaudePath(this.cliPathOverride) ?? 'claude';
  }

  async generate(prompt: string, options?: GenerateOptions): Promise<string> {
    return this.generateStream(prompt, options);
  }

  generateStream(prompt: string, options?: GenerateOptions, hooks?: StreamHooks): Promise<string> {
    const args = [
      '-p',
      // Per-call model override (G2) falls back to the provider's default.
      '--model', options?.model ?? this.model,
      '--tools', '',
      '--no-session-persistence',
      // stream-json (requires --verbose in -p mode) emits output as it is
      // produced. Default text mode buffers until completion → 0 bytes for
      // minutes on a large module → watchdog false-positive startup-stall (S1).
      '--output-format', 'stream-json',
      '--verbose',
      ...STARTUP_FLAGS,
    ];
    if (options?.system) {
      args.push('--system-prompt', options.system);
    }

    const bin = this.binary();

    // The CLI has no max-output-tokens flag; its output ceiling is the env var
    // CLAUDE_CODE_MAX_OUTPUT_TOKENS. Forward the caller's budget there so a large
    // module is not silently truncated at the CLI's default (TOKEN-BUDGET-DIAGNOSIS).
    const budgetEnv: Record<string, string> = options?.maxTokens
      ? { CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(options.maxTokens) }
      : {};

    return new Promise<string>((resolve, reject) => {
      // detached → the child leads its own process group, so on abort we can
      // kill the whole subtree (claude + anything it spawns) — no orphans (O11).
      const child = spawn(bin, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: true,
        env: { ...process.env, ...STARTUP_ENV, ...budgetEnv },
      });

      let stderr = '';
      let bytes = 0;
      let firstByteSeen = false;
      let settled = false;
      // stream-json accumulators: a line buffer across chunks, incremental
      // assistant text, the authoritative final `result`, and any reported error.
      let buffer = '';
      let streamedText = '';
      let finalResult: string | null = null;
      let resultError: string | null = null;
      let stopReason: string | null = null;
      const consumeLine = (line: string): string => {
        const c = parseStreamJsonLine(line);
        if (c.result !== undefined) finalResult = c.result;
        if (c.isError) resultError = c.result ?? 'Claude CLI stream reported an error';
        if (c.stopReason && !stopReason) {
          stopReason = c.stopReason;
          hooks?.onStopReason?.(c.stopReason);
        }
        if (c.text) { streamedText += c.text; return c.text; }
        return '';
      };

      const killTree = () => {
        try {
          if (child.pid) process.kill(-child.pid, 'SIGKILL'); // negative pid → group
        } catch {
          child.kill('SIGKILL');
        }
      };
      const onAbort = () => {
        if (!settled) killTree();
      };
      if (options?.signal) {
        if (options.signal.aborted) onAbort();
        else options.signal.addEventListener('abort', onAbort, { once: true });
      }

      child.on('error', err => {
        if (settled) return;
        settled = true;
        options?.signal?.removeEventListener('abort', onAbort);
        reject(err instanceof Error ? err : new Error(String(err)));
      });

      child.stdout.on('data', (chunk: Buffer) => {
        if (!firstByteSeen) {
          firstByteSeen = true;
          hooks?.onFirstByte?.();
        }
        bytes += chunk.length;
        buffer += chunk.toString('utf8');
        let delta = '';
        let idx: number;
        while ((idx = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 1);
          delta += consumeLine(line);
        }
        // Heartbeat on every chunk — even envelope-only events that carry no
        // text — so bytesStreamed rises and the watchdog never kills a live
        // call for as long as it produces (S2).
        hooks?.onChunk?.(bytes, delta);

        // Truncation (max_tokens): the model hit the output budget and stops
        // emitting — the byte stream now freezes. Settle immediately with the
        // (truncated) text rather than waiting for a close the watchdog would
        // otherwise misread as a stream-stall and kill (T2). The stopReason
        // hook already fired; the caller classifies this as over-budget.
        if (!settled && isTruncationStopReason(stopReason ?? undefined)) {
          settled = true;
          options?.signal?.removeEventListener('abort', onAbort);
          killTree();
          hooks?.onStreamEnd?.();
          const out = finalResult ?? streamedText;
          resolve(out);
        }
      });
      child.stdout.on('end', () => {
        if (settled) return; // truncation already settled + fired onStreamEnd
        if (buffer.trim().length > 0) { consumeLine(buffer); buffer = ''; }
        hooks?.onStreamEnd?.();
      });
      child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });

      child.on('close', (code, signal) => {
        if (settled) return;
        settled = true;
        options?.signal?.removeEventListener('abort', onAbort);
        if (buffer.trim().length > 0) { consumeLine(buffer); buffer = ''; }
        if (signal) {
          reject(new Error(`Claude CLI killed by ${signal}`));
          return;
        }
        if (resultError) {
          reject(new Error(`Claude CLI error: ${resultError.trim().slice(0, 500)}`));
          return;
        }
        if (code !== 0) {
          reject(new Error(`Claude CLI exited ${code}: ${stderr.trim().slice(0, 500)}`));
          return;
        }
        // Prefer the terminal result event's text; fall back to streamed deltas.
        const out = finalResult ?? streamedText;
        if (!out || out.trim().length === 0) {
          reject(new Error('Claude CLI returned empty response'));
          return;
        }
        resolve(out);
      });

      // Feed the prompt via stdin to avoid argument length limits.
      child.stdin.write(prompt);
      child.stdin.end();
    });
  }
}

/**
 * Check if the `claude` CLI is available — on PATH or at a known install
 * location (B4: a non-standard install must still be found).
 */
export function isClaudeCliAvailable(): boolean {
  return resolveClaudePath() !== null;
}
