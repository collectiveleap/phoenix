import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { chmodSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  resolveClaudePath,
  resetClaudePathCache,
  desktopCliCandidates,
  compareVersions,
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
