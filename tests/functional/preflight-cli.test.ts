/**
 * DC5 (end-to-end) — `phoenix preflight` derives its checks from the bound
 * architecture and never gates on the (installable) typechecker.
 * Proves the CALLER wiring, not just the pure preflight() function.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const CLI = join(process.cwd(), 'dist', 'cli.js');

/** Run `phoenix <cmd>` in cwd, returning combined stdout even on non-zero exit. */
function phoenix(cwd: string, ...cmd: string[]): string {
  try {
    return execFileSync('node', [CLI, ...cmd], { cwd, encoding: 'utf8', stdio: 'pipe' });
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string };
    return (err.stdout ?? '') + (err.stderr ?? '');
  }
}

describe('DC5: phoenix preflight derives checks from the bound architecture', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'phoenix-pf-cli-'));
    phoenix(root, 'init');
    expect(existsSync(join(root, '.phoenix'))).toBe(true);
  });

  it('never gates on the typechecker (DC1/DC4) — no typechecker line', () => {
    const out = phoenix(root, 'preflight');
    expect(out).toContain('Preflight');
    expect(out.toLowerCase()).not.toContain('typechecker');
    expect(out).not.toMatch(/npm i -D typescript/);
  });

  it('with no architecture bound, asserts neither typechecker nor native-build', () => {
    const out = phoenix(root, 'preflight');
    expect(out.toLowerCase()).not.toContain('typechecker');
    expect(out).not.toContain('native-build');
  });

  it('with a native architecture bound, checks native-build WITHOUT --native', () => {
    writeFileSync(
      join(root, '.phoenix', 'config.json'),
      JSON.stringify({ architecture: 'web-api/node-typescript' }) + '\n',
    );
    const out = phoenix(root, 'preflight'); // note: no --native flag
    expect(out).toContain('native-build');     // derived from arch.nativeDeps (better-sqlite3)
    expect(out.toLowerCase()).not.toContain('typechecker');
  });
});
