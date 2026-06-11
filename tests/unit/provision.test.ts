import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { installCommand, rebuildCommand, provision } from '../../src/harness/provision.js';

describe('Provision (B1/B2: install deps + build native deps)', () => {
  let projectRoot: string;

  beforeEach(() => { projectRoot = mkdtempSync(join(tmpdir(), 'phoenix-prov-')); });
  afterEach(() => { rmSync(projectRoot, { recursive: true, force: true }); });

  it('builds the install/rebuild commands per package manager', () => {
    expect(installCommand('pnpm')).toEqual({ cmd: 'pnpm', args: ['install'] });
    expect(rebuildCommand('pnpm', 'better-sqlite3')).toEqual({ cmd: 'pnpm', args: ['rebuild', 'better-sqlite3'] });
    expect(rebuildCommand('npm', 'better-sqlite3')).toEqual({ cmd: 'npm', args: ['rebuild', 'better-sqlite3'] });
    // yarn/bun have no rebuild — rely on install + allowlist, verify only.
    expect(rebuildCommand('yarn', 'better-sqlite3')).toBeNull();
  });

  it('fails with remediation when no package manager is available', () => {
    const result = provision({ projectRoot, packageManager: null });
    expect(result.ok).toBe(false);
    expect(result.steps[0].name).toBe('package-manager');
    expect(result.steps[0].detail).toMatch(/no package manager/i);
  });

  it('installs a no-dep project and reports the install step (B1)', () => {
    writeFileSync(join(projectRoot, 'package.json'), JSON.stringify({
      name: 'prov-test', version: '0.0.0', private: true,
    }) + '\n');
    const result = provision({ projectRoot, nativeDeps: [] });
    expect(result.ok).toBe(true);
    expect(result.steps.some(s => s.name === 'install' && s.ok)).toBe(true);
    expect(existsSync(join(projectRoot, 'node_modules'))).toBe(true);
  });

  it('reports the explicit "not built" remediation when a native binding never loads (B2)', () => {
    // A package.json whose declared native dep is not installed: install
    // succeeds (no such dep) but the verify step must catch the missing binding.
    writeFileSync(join(projectRoot, 'package.json'), JSON.stringify({
      name: 'prov-native-test', version: '0.0.0', private: true,
    }) + '\n');
    const result = provision({ projectRoot, nativeDeps: ['better-sqlite3'] });
    expect(result.ok).toBe(false);
    const verify = result.steps.find(s => s.name === 'verify:better-sqlite3')!;
    expect(verify.ok).toBe(false);
    expect(verify.detail).toMatch(/native dependency `better-sqlite3` not built — run/);
  });

  it('browser provisioning is NON-FATAL: a missing playwright records a step but the run still succeeds', () => {
    writeFileSync(join(projectRoot, 'package.json'), JSON.stringify({
      name: 'prov-browser-test', version: '0.0.0', private: true,
    }) + '\n');
    const result = provision({ projectRoot, browserDeps: ['chromium'] });
    expect(result.ok).toBe(true); // ← the run is NOT failed by a browser gap
    const step = result.steps.find(s => s.name === 'browser:chromium')!;
    expect(step.ok).toBe(false);
    expect(step.detail).toMatch(/playwright not installed.*INCOMPLETE/i);
  });

  it('PHOENIX_SKIP_BROWSER_INSTALL skips the browser step (still non-fatal)', () => {
    writeFileSync(join(projectRoot, 'package.json'), JSON.stringify({
      name: 'prov-browser-skip', version: '0.0.0', private: true,
    }) + '\n');
    const prev = process.env.PHOENIX_SKIP_BROWSER_INSTALL;
    process.env.PHOENIX_SKIP_BROWSER_INSTALL = '1';
    try {
      const result = provision({ projectRoot, browserDeps: ['chromium'] });
      expect(result.ok).toBe(true);
      expect(result.steps.find(s => s.name === 'browser:chromium')!.detail).toMatch(/skipped/i);
    } finally {
      if (prev === undefined) delete process.env.PHOENIX_SKIP_BROWSER_INSTALL;
      else process.env.PHOENIX_SKIP_BROWSER_INSTALL = prev;
    }
  });

  it('invokes the browser install when playwright is present (fake bin, exits 0)', () => {
    writeFileSync(join(projectRoot, 'package.json'), JSON.stringify({
      name: 'prov-browser-run', version: '0.0.0', private: true,
    }) + '\n');
    mkdirSync(join(projectRoot, 'node_modules', '.bin'), { recursive: true });
    // A fake playwright that records its args and exits 0.
    writeFileSync(
      join(projectRoot, 'node_modules', '.bin', 'playwright'),
      `#!/bin/sh\necho "playwright $@"\nexit 0\n`,
      { mode: 0o755 },
    );
    const result = provision({ projectRoot, browserDeps: ['chromium'] });
    expect(result.ok).toBe(true);
    expect(result.steps.find(s => s.name === 'browser:chromium')!.ok).toBe(true);
  });
});
