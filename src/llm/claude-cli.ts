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
 */

import { spawn, execFileSync } from 'node:child_process';
import type { LLMProvider, GenerateOptions, StreamHooks } from './provider.js';

export class ClaudeCliProvider implements LLMProvider {
  readonly name = 'claude-cli';
  readonly model: string;

  constructor(model: string = 'sonnet') {
    this.model = model;
  }

  async generate(prompt: string, options?: GenerateOptions): Promise<string> {
    return this.generateStream(prompt, options);
  }

  generateStream(prompt: string, options?: GenerateOptions, hooks?: StreamHooks): Promise<string> {
    const args = [
      '-p',
      '--model', this.model,
      '--tools', '',
      '--no-session-persistence',
    ];
    if (options?.system) {
      args.push('--system-prompt', options.system);
    }

    return new Promise<string>((resolve, reject) => {
      // detached → the child leads its own process group, so on abort we can
      // kill the whole subtree (claude + anything it spawns) — no orphans (O11).
      const child = spawn('claude', args, { stdio: ['pipe', 'pipe', 'pipe'], detached: true });

      let out = '';
      let stderr = '';
      let bytes = 0;
      let firstByteSeen = false;
      let settled = false;

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
        const text = chunk.toString('utf8');
        out += text;
        bytes += chunk.length;
        hooks?.onChunk?.(bytes, text);
      });
      child.stdout.on('end', () => hooks?.onStreamEnd?.());
      child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });

      child.on('close', (code, signal) => {
        if (settled) return;
        settled = true;
        options?.signal?.removeEventListener('abort', onAbort);
        if (signal) {
          reject(new Error(`Claude CLI killed by ${signal}`));
          return;
        }
        if (code !== 0) {
          reject(new Error(`Claude CLI exited ${code}: ${stderr.trim().slice(0, 500)}`));
          return;
        }
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
 * Check if the `claude` CLI is available on PATH.
 */
export function isClaudeCliAvailable(): boolean {
  try {
    execFileSync('claude', ['--version'], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return true;
  } catch {
    return false;
  }
}
