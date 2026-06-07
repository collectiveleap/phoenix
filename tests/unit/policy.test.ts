import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadPolicy, describePolicy, DEFAULT_POLICY } from '../../src/harness/policy.js';

describe('Run policy (O14: failure handling is config-driven)', () => {
  let phoenixDir: string;

  beforeEach(() => {
    phoenixDir = mkdtempSync(join(tmpdir(), 'phoenix-policy-'));
  });

  it('returns defaults when no config exists', () => {
    expect(loadPolicy(phoenixDir)).toEqual(DEFAULT_POLICY);
  });

  it('overrides thresholds from config with no code change', () => {
    writeFileSync(join(phoenixDir, 'config.json'), JSON.stringify({
      policy: {
        maxRepairs: 5,
        onModuleFailure: 'abort',
        budgets: { startupMs: 1234 },
      },
    }));
    const p = loadPolicy(phoenixDir);
    expect(p.maxRepairs).toBe(5);
    expect(p.onModuleFailure).toBe('abort');
    expect(p.budgets.startupMs).toBe(1234);
    // Unspecified budget fields keep their defaults.
    expect(p.budgets.streamStallMs).toBe(DEFAULT_POLICY.budgets.streamStallMs);
  });

  it('describePolicy prints a per-stage summary (for --dry-run)', () => {
    const lines = describePolicy(loadPolicy(phoenixDir));
    const text = lines.join('\n');
    expect(text).toMatch(/preflight/);
    expect(text).toMatch(/generate/);
    expect(text).toMatch(/acceptance/);
    expect(text).toMatch(/on module failure/);
  });

  it('ignores malformed config and falls back to defaults', () => {
    writeFileSync(join(phoenixDir, 'config.json'), '{ not valid json');
    expect(loadPolicy(phoenixDir)).toEqual(DEFAULT_POLICY);
  });
});
