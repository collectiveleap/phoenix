import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { preflight } from '../../src/harness/preflight.js';

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

  it('passes the runtime check and reports per-assumption results', () => {
    const result = preflight({ projectRoot });
    const names = result.checks.map(c => c.name);
    expect(names).toEqual(expect.arrayContaining(['runtime', 'typechecker', 'package-runner']));
    expect(result.checks.find(c => c.name === 'runtime')!.ok).toBe(true);
  });

  it('fails fast with remediation when the typechecker is hidden (appendix #1/O9)', () => {
    // Empty projectRoot has no local tsc and this sandbox has no global tsc/npx.
    const result = preflight({ projectRoot });
    const tc = result.checks.find(c => c.name === 'typechecker')!;
    expect(tc.ok).toBe(false);
    expect(tc.remediation).toMatch(/typescript|tsc/i);
    expect(result.ok).toBe(false);
  });

  it('flags a missing provider only when generation is required', () => {
    const without = preflight({ projectRoot, requireProvider: false });
    expect(without.checks.some(c => c.name === 'llm-provider')).toBe(false);

    const withReq = preflight({ projectRoot, requireProvider: true });
    const prov = withReq.checks.find(c => c.name === 'llm-provider')!;
    expect(prov.ok).toBe(false);
    expect(prov.remediation).toMatch(/API_KEY|Claude CLI/);
  });
});
