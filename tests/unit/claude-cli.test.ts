import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { chmodSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  resolveClaudePath,
  resetClaudePathCache,
  desktopCliCandidates,
  compareVersions,
  parseStreamJsonLine,
  ClaudeCliProvider,
  STARTUP_FLAGS,
  STARTUP_ENV,
} from '../../src/llm/claude-cli.js';

describe('Claude CLI location + invocation (B4)', () => {
  const saved = { ...process.env };
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'phoenix-cli-'));
    resetClaudePathCache();
    delete process.env.PHOENIX_CLAUDE_CLI_PATH;
  });
  afterEach(() => {
    process.env = { ...saved };
    rmSync(dir, { recursive: true, force: true });
    resetClaudePathCache();
  });

  /** Write an executable stub that responds to `--version`. */
  function writeStubCli(name: string): string {
    const p = join(dir, name);
    writeFileSync(p, '#!/bin/sh\necho "stub 1.0.0"\n');
    chmodSync(p, 0o755);
    return p;
  }

  it('honors an explicit override path (config / env) for non-standard installs', () => {
    const stub = writeStubCli('claude');
    expect(resolveClaudePath(stub)).toBe(stub);

    process.env.PHOENIX_CLAUDE_CLI_PATH = stub;
    resetClaudePathCache();
    expect(resolveClaudePath()).toBe(stub);
  });

  it('returns null when an override path does not work', () => {
    expect(resolveClaudePath(join(dir, 'does-not-exist'))).toBeNull();
  });

  it('exposes the startup-minimizing flags and traffic-disable env (B4 evidence)', () => {
    // Both verified against `claude --help` (v2.1.x).
    expect(STARTUP_FLAGS).toContain('--strict-mcp-config');
    expect(STARTUP_FLAGS).toContain('--no-chrome');
    expect(STARTUP_ENV.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe('1');
  });

  it('orders versions numerically, including pre-release suffixes', () => {
    // 160 > 9 numerically (not lexically); a -dev suffix sorts by its number.
    expect([...['2.1.9', '2.1.160', '2.2.0'].sort(compareVersions)])
      .toEqual(['2.1.9', '2.1.160', '2.2.0']);
    expect(compareVersions('2.1.160-dev', '2.1.160')).toBe(0);
    expect(compareVersions('2.2.0', '2.1.999')).toBeGreaterThan(0);
  });

  describe('desktop CLI version discovery (handles a newly-installed version)', () => {
    /** Lay out <base>/<version>/claude.app/Contents/MacOS/claude stubs. */
    function installVersions(base: string, versions: string[]): void {
      for (const v of versions) {
        const macos = join(base, v, 'claude.app', 'Contents', 'MacOS');
        mkdirSync(macos, { recursive: true });
        const bin = join(macos, 'claude');
        writeFileSync(bin, '#!/bin/sh\necho stub\n');
        chmodSync(bin, 0o755);
      }
    }

    it('returns installed versions newest-first and ignores non-version entries', () => {
      const base = join(dir, 'claude-code');
      installVersions(base, ['2.1.9', '2.1.160', '2.2.0']);
      mkdirSync(join(base, '.cache'), { recursive: true }); // junk dir, must be skipped
      writeFileSync(join(base, 'README'), 'x');             // junk file, must be skipped

      const cands = desktopCliCandidates(base);
      const versionsInOrder = cands.map(p => p.split('/claude.app/')[0].split('/').pop());
      expect(versionsInOrder).toEqual(['2.2.0', '2.1.160', '2.1.9']);
      expect(cands[0]).toBe(join(base, '2.2.0', 'claude.app', 'Contents', 'MacOS', 'claude'));
    });

    it('picks up a newly-installed version on the next call', () => {
      const base = join(dir, 'claude-code');
      installVersions(base, ['2.1.160']);
      expect(desktopCliCandidates(base)[0]).toContain('/2.1.160/');

      installVersions(base, ['2.2.0']); // app auto-updates
      expect(desktopCliCandidates(base)[0]).toContain('/2.2.0/');
    });

    it('returns [] when the desktop install dir is absent', () => {
      expect(desktopCliCandidates(join(dir, 'nope'))).toEqual([]);
    });
  });

  it('does not return a stale binary after it is removed (e.g. an upgrade)', () => {
    // Resolve a working stub, then delete it: a later resolve must re-check and
    // not keep returning the now-missing path.
    const stub = writeStubCli('claude');
    process.env.PHOENIX_CLAUDE_CLI_PATH = stub;
    resetClaudePathCache();
    expect(resolveClaudePath()).toBe(stub);

    rmSync(stub, { force: true });
    expect(resolveClaudePath()).toBeNull();
  });
});

describe('stream-json line parsing (S1: extract text, not JSON)', () => {
  it('extracts text from an assistant content block', () => {
    const line = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'hello' }] } });
    expect(parseStreamJsonLine(line)).toEqual({ text: 'hello' });
  });

  it('joins multiple text blocks in one assistant message', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] },
    });
    expect(parseStreamJsonLine(line)).toEqual({ text: 'ab' });
  });

  it('extracts a partial text_delta when the CLI streams deltas', () => {
    const line = JSON.stringify({ type: 'stream_event', delta: { type: 'text_delta', text: 'xyz' } });
    expect(parseStreamJsonLine(line)).toEqual({ text: 'xyz' });
  });

  it('takes the authoritative final text from a success result event', () => {
    const line = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'final' });
    expect(parseStreamJsonLine(line)).toEqual({ result: 'final', isError: false });
  });

  it('flags an error result event', () => {
    const line = JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true });
    const chunk = parseStreamJsonLine(line);
    expect(chunk.isError).toBe(true);
  });

  it('treats envelope, blank, and non-JSON lines as heartbeat-only (no text)', () => {
    expect(parseStreamJsonLine(JSON.stringify({ type: 'system', subtype: 'init' }))).toEqual({});
    expect(parseStreamJsonLine('')).toEqual({});
    expect(parseStreamJsonLine('  ')).toEqual({});
    expect(parseStreamJsonLine('not json {')).toEqual({});
  });

  it('surfaces a max_tokens stop_reason from an assistant event (T2)', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'partial' }], stop_reason: 'max_tokens' },
    });
    expect(parseStreamJsonLine(line)).toEqual({ text: 'partial', stopReason: 'max_tokens' });
  });

  it('surfaces stop_reason from a message_delta event', () => {
    const line = JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'max_tokens' } });
    expect(parseStreamJsonLine(line)).toEqual({ stopReason: 'max_tokens' });
  });

  it('carries end_turn stop_reason alongside assistant text', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn' },
    });
    expect(parseStreamJsonLine(line)).toEqual({ text: 'done', stopReason: 'end_turn' });
  });
});

describe('Claude CLI streaming (S1/S2: incremental output, not a single end-jump)', () => {
  let dir: string;

  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'phoenix-stream-')); resetClaudePathCache(); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); resetClaudePathCache(); });

  /**
   * Write a fake `claude` that answers `--version` and, for a `-p` call, emits
   * scripted stream-json lines with gaps — so Node sees them as separate stdout
   * chunks, exactly like a real streaming generation.
   */
  function writeStreamingCli(lines: string[], opts: { gap?: number } = {}): string {
    const gap = opts.gap ?? 0.05;
    const emits = lines.map(l => `printf '%s\\n' '${l.replace(/'/g, "'\\''")}'\nsleep ${gap}`).join('\n');
    const p = join(dir, 'claude');
    writeFileSync(p, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "fake 1.0.0"; exit 0; fi\ncat > /dev/null\n${emits}\n`);
    chmodSync(p, 0o755);
    return p;
  }

  it('fires incremental progress with monotonically rising bytes and returns parsed text', async () => {
    const bin = writeStreamingCli([
      JSON.stringify({ type: 'system', subtype: 'init' }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'export const a' }] } }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: ' = 1;' }] } }),
      JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'export const a = 1;' }),
    ]);

    const provider = new ClaudeCliProvider('sonnet', bin);
    let firstByteAt = -1;
    const progress: number[] = [];
    let calls = 0;
    const text = await provider.generateStream('make a module', undefined, {
      onFirstByte: () => { firstByteAt = ++calls; },
      onChunk: (total) => { calls++; progress.push(total); },
    });

    // Resolved value is the parsed code, never the JSON envelope.
    expect(text).toBe('export const a = 1;');
    expect(text).not.toContain('"type"');

    // First-CONTENT byte fires on the first text chunk — AFTER the init envelope
    // (calls=1), not on it (OP1) — but still early, not at the end.
    expect(firstByteAt).toBe(2);

    // bytesStreamed rose across ≥2 progress events — not a single jump at the end.
    expect(progress.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < progress.length; i++) expect(progress[i]).toBeGreaterThanOrEqual(progress[i - 1]);
    expect(progress[progress.length - 1]).toBeGreaterThan(progress[0]);
  });

  it('rejects when the stream reports an error result', async () => {
    const bin = writeStreamingCli([
      JSON.stringify({ type: 'system', subtype: 'init' }),
      JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'boom' }),
    ]);
    const provider = new ClaudeCliProvider('sonnet', bin);
    await expect(provider.generateStream('p')).rejects.toThrow(/Claude CLI error: boom/);
  });

  it('does not fire onFirstByte for an envelope-only stream with no content (OP1)', async () => {
    // Mimics opus thinking: only the init envelope arrives, then the stream ends
    // with no assistant text — first-CONTENT byte must never be signalled.
    const bin = writeStreamingCli([
      JSON.stringify({ type: 'system', subtype: 'init' }),
      JSON.stringify({ type: 'system', subtype: 'status' }),
    ]);
    const provider = new ClaudeCliProvider('sonnet', bin);
    let firstByteFired = false;
    let chunks = 0;
    await expect(
      provider.generateStream('p', undefined, {
        onFirstByte: () => { firstByteFired = true; },
        onChunk: () => { chunks++; },
      }),
    ).rejects.toThrow(/empty response/);
    expect(firstByteFired).toBe(false); // envelope alone is not "first content"
    expect(chunks).toBeGreaterThan(0);  // …but envelope chunks still heartbeat (S2)
  });

  /** A fake `claude` that echoes the output-budget env var into its result. */
  function writeEnvEchoCli(): string {
    const p = join(dir, 'claude');
    writeFileSync(
      p,
      `#!/bin/sh\n` +
      `if [ "$1" = "--version" ]; then echo "fake 1.0.0"; exit 0; fi\n` +
      `cat > /dev/null\n` +
      `printf '%s\\n' "{\\"type\\":\\"result\\",\\"subtype\\":\\"success\\",\\"is_error\\":false,\\"result\\":\\"budget=\${CLAUDE_CODE_MAX_OUTPUT_TOKENS}\\"}"\n`,
    );
    chmodSync(p, 0o755);
    return p;
  }

  it('forwards maxTokens to the CLI via CLAUDE_CODE_MAX_OUTPUT_TOKENS (T1)', async () => {
    const provider = new ClaudeCliProvider('sonnet', writeEnvEchoCli());
    const out = await provider.generateStream('p', { maxTokens: 42424 });
    expect(out).toBe('budget=42424');
  });

  it('does not set the budget env when no maxTokens is given', async () => {
    const provider = new ClaudeCliProvider('sonnet', writeEnvEchoCli());
    const out = await provider.generateStream('p');
    expect(out).toBe('budget=');
  });

  it('settles promptly on a max_tokens truncation instead of waiting out the freeze (T2)', async () => {
    // Emit a truncation event, then "freeze" (long sleep) as the real CLI does
    // after hitting the cap. The provider must settle immediately, not hang.
    const p = join(dir, 'claude');
    const ev = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'export const partial =' }], stop_reason: 'max_tokens' },
    }).replace(/'/g, "'\\''");
    writeFileSync(
      p,
      `#!/bin/sh\n` +
      `if [ "$1" = "--version" ]; then echo "fake 1.0.0"; exit 0; fi\n` +
      `cat > /dev/null\n` +
      `printf '%s\\n' '${ev}'\n` +
      `sleep 10\n`,
    );
    chmodSync(p, 0o755);

    const provider = new ClaudeCliProvider('sonnet', p);
    let stopReason: string | undefined;
    const start = Date.now();
    const out = await provider.generateStream('p', undefined, {
      onStopReason: r => { stopReason = r; },
    });
    const elapsed = Date.now() - start;

    expect(stopReason).toBe('max_tokens');
    expect(out).toContain('export const partial =');
    expect(elapsed).toBeLessThan(5000); // did not wait out the 10s freeze
  });
});
