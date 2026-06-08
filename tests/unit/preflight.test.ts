import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { preflight } from '../../src/harness/preflight.js';
import { nodeTypescript } from '../../src/architectures/node-typescript.js';

describe('Preflight (O9: verify toolchain before a run)', () => {
  const saved = { ...process.env };
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'phoenix-preflight-'));
    delete process.env.PHOENIX_LLM_PROVIDER;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
  });
  afterEach(() => { process.env = { ...saved }; });

  it('checks the host prerequisites and reports per-assumption results', () => {
    const result = preflight({ projectRoot });
    const names = result.checks.map(c => c.name);
    expect(names).toEqual(expect.arrayContaining(['runtime', 'package-runner']));
    expect(result.checks.find(c => c.name === 'runtime')!.ok).toBe(true);
  });

  it('does NOT gate on the typechecker — an installable, Phoenix-provisioned dep (DC1/DC4)', () => {
    // Empty projectRoot has no local tsc and this sandbox has no global tsc/npx —
    // yet preflight must neither check nor fail on the typechecker (provision
    // installs it; the acceptance typecheck enforces it downstream).
    const result = preflight({ projectRoot });
    expect(result.checks.some(c => c.name === 'typechecker')).toBe(false);
    expect(result.ok).toBe(true); // host prereqs present (no provider required)
  });

  it('flags a missing provider only when generation is required', () => {
    // Force every provider unavailable, deterministically across machines: no
    // API keys (cleared in beforeEach) and a bogus Claude CLI override path so
    // a locally-installed desktop CLI isn't auto-detected.
    process.env.PHOENIX_CLAUDE_CLI_PATH = join(projectRoot, 'no-such-claude');

    const without = preflight({ projectRoot, requireProvider: false });
    expect(without.checks.some(c => c.name === 'llm-provider')).toBe(false);

    const withReq = preflight({ projectRoot, requireProvider: true });
    const prov = withReq.checks.find(c => c.name === 'llm-provider')!;
    expect(prov.ok).toBe(false);
    expect(prov.remediation).toMatch(/API_KEY|Claude CLI/);
  });

  it('requires a C toolchain only when an architecture declares a native dep (A4)', () => {
    // A pure-JS arch (no native deps) → no native-build check at all.
    const pureJs = preflight({ projectRoot, requireNativeBuild: false });
    expect(pureJs.checks.some(c => c.name === 'native-build')).toBe(false);

    // A native-dep arch (e.g. node-typescript's better-sqlite3) → the check exists.
    const native = preflight({ projectRoot, requireNativeBuild: true });
    expect(native.checks.some(c => c.name === 'native-build')).toBe(true);
  });

  it('verifies the architecture-declared runtime floor (A1)', () => {
    // A floor above the running Node fails fast with the required version.
    const tooOld = preflight({ projectRoot, minNodeMajor: 999 });
    const rt = tooOld.checks.find(c => c.name === 'runtime')!;
    expect(rt.ok).toBe(false);
    expect(rt.remediation).toMatch(/999/);
  });
});

describe('Architecture contract declaration (A1/A4: surface requirements)', () => {
  it('node-typescript declares its native dep and runtime floor', () => {
    expect(nodeTypescript.nativeDeps).toContain('better-sqlite3');
    expect(nodeTypescript.minNodeMajor).toBeGreaterThanOrEqual(20);
    // The declared native dep is actually one of its production packages.
    for (const dep of nodeTypescript.nativeDeps ?? []) {
      expect(Object.keys(nodeTypescript.packages)).toContain(dep);
    }
  });
});
