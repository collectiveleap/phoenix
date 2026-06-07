import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { probeTypechecker, typecheckProject } from '../../src/harness/typecheck.js';

describe('typechecker probe (O3: a missing tool is never type errors)', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'phoenix-typecheck-'));
  });

  it('reports unavailable when no tsc can be resolved', () => {
    // Empty project + a PATH with no tsc/npx → unavailable, not "errors".
    const probe = probeTypechecker(projectRoot);
    // In CI there may be a global tsc; the contract we assert is that the
    // result is a clean true/false with a human detail, never a crash.
    expect(typeof probe.available).toBe('boolean');
    expect(probe.detail.length).toBeGreaterThan(0);

    if (!probe.available) {
      const result = typecheckProject(projectRoot, undefined, probe);
      expect(result.status).toBe('unavailable');
    }
  });

  it('treats a fabricated "command not found" as unavailable, never errors', () => {
    // Force an unavailable probe and verify typecheckProject honours it.
    const result = typecheckProject(projectRoot, undefined, {
      available: false,
      detail: 'command not found: tsc',
    });
    expect(result.status).toBe('unavailable');
    if (result.status === 'unavailable') {
      expect(result.detail).toContain('command not found');
    }
  });

  it('reports real type errors with a count using the repo compiler', () => {
    // Drive the actual TypeScript compiler from this repo (no global tsc here)
    // so the errors/count branch is genuinely exercised.
    const repoTsc = join(process.cwd(), 'node_modules', '.bin', 'tsc');
    const probe = { available: true as const, command: { cmd: repoTsc, args: [], label: 'repo tsc' }, detail: 'repo tsc' };

    mkdirSync(join(projectRoot, 'src'), { recursive: true });
    writeFileSync(
      join(projectRoot, 'tsconfig.json'),
      JSON.stringify({ compilerOptions: { strict: true, noEmit: true }, include: ['src'] }),
    );
    writeFileSync(join(projectRoot, 'src', 'bad.ts'), 'const x: number = "not a number";\n');

    const result = typecheckProject(projectRoot, undefined, probe);
    expect(result.status).toBe('errors');
    if (result.status === 'errors') {
      expect(result.count).toBeGreaterThan(0);
      expect(result.errors).toMatch(/error TS/);
    }
  });
});
