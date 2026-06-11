/**
 * Phase 2 — Phoenix compiles a behavioral test from a module's SPEC, for provider
 * (api) modules, independent of the generated implementation.
 */
import { describe, it, expect } from 'vitest';
import { generateIU } from '../../src/regen.js';
import { planIUs } from '../../src/iu-planner.js';
import { parseSpec } from '../../src/spec-parser.js';
import { extractCanonicalNodes } from '../../src/canonicalizer.js';
import { deriveInterfaces } from '../../src/scaffold.js';
import { resolveTarget } from '../../src/architectures/index.js';
import type { LLMProvider, GenerateOptions, StreamHooks } from '../../src/llm/provider.js';

const IMPL_MARKER = 'IMPL_ONLY_MARKER_xyz';

/** Returns a module for codegen, a vitest test for test-gen — and records every prompt it saw. */
class TestAwareProvider implements LLMProvider {
  readonly name = 'fake';
  readonly model = 'test';
  seen: { system: string; prompt: string }[] = [];
  generate(p: string, o?: GenerateOptions): Promise<string> { return this.generateStream(p, o); }
  async generateStream(prompt: string, o?: GenerateOptions, hooks?: StreamHooks): Promise<string> {
    const system = o?.system ?? '';
    this.seen.push({ system, prompt });
    const isTest = /behavioral test/i.test(system + prompt);
    const body = isTest
      ? `import { it, expect, beforeAll } from 'vitest';\nimport mod from '../tasks.js';\nimport { runMigrations } from '../../db.js';\nbeforeAll(() => runMigrations());\nit('creates → 201', async () => { const r = await mod.request('/', { method: 'POST' }); expect(r.status).toBe(201); });\n`
      : `import { Hono } from 'hono';\nconst router = new Hono();\nrouter.post('/', (c) => c.json({}, 201)); // ${IMPL_MARKER}\nexport default router;\nexport const _phoenix = {} as const;\n`;
    hooks?.onFirstByte?.();
    hooks?.onChunk?.(body.length, body);
    hooks?.onStopReason?.('end_turn');
    hooks?.onStreamEnd?.();
    return body;
  }
}

function setup() {
  const target = resolveTarget('web-api/node-typescript')!;
  const clauses = parseSpec('# App\n\n## Tasks\n\nThe service must create a task. The service must list tasks.', 'app.md');
  const canon = extractCanonicalNodes(clauses);
  const ius = planIUs(canon, clauses);
  const interfaces = deriveInterfaces(ius, canon, target);
  return { target, canon, ius, interfaces };
}

describe('Phase 2: behavioral tests are compiled from the spec for api modules', () => {
  it('generates a behavioral test file for the provider module', async () => {
    const { target, canon, ius, interfaces } = setup();
    const tasks = ius[0];
    const provider = new TestAwareProvider();
    const result = await generateIU(tasks, { llm: provider, canonNodes: canon, allIUs: ius, interfaces, target });

    const testEntry = [...result.files.keys()].find(p => /__tests__\/tasks\.behavior\.test\.ts$/.test(p));
    expect(testEntry).toBeDefined();
    const testCode = result.files.get(testEntry!)!;
    expect(testCode).toContain(`import mod from '../tasks.js'`); // module import (correct depth) untouched
    expect(testCode).toContain('toBe(201)');
    // I1: shared-file import is re-based for the __tests__/ location (one deeper).
    expect(testCode).toContain(`from '../../../db.js'`);
    expect(testCode).not.toContain(`from '../../db.js'`);
  });

  it('compiles the test from the spec, NOT the implementation (independence)', async () => {
    const { target, canon, ius, interfaces } = setup();
    const provider = new TestAwareProvider();
    await generateIU(ius[0], { llm: provider, canonNodes: canon, allIUs: ius, interfaces, target });

    // The module body (carrying IMPL_MARKER) must never appear in the test-gen prompt.
    const testPrompt = provider.seen.find(s => /behavioral test/i.test(s.system + s.prompt));
    expect(testPrompt).toBeDefined();
    expect(testPrompt!.prompt).not.toContain(IMPL_MARKER);
    // ...but it IS built from the requirements.
    expect(testPrompt!.prompt.toLowerCase()).toContain('create a task');
  });

  it('does not generate behavioral tests for a non-provider (web-ui) module', async () => {
    const target = resolveTarget('web-api/node-typescript')!;
    const clauses = parseSpec('# App\n\n## Web Experience\n\nThe page must render the list in the browser.', 'app.md');
    const canon = extractCanonicalNodes(clauses);
    const ius = planIUs(canon, clauses);
    const interfaces = deriveInterfaces(ius, canon, target);
    const result = await generateIU(ius[0], { llm: new TestAwareProvider(), canonNodes: canon, allIUs: ius, interfaces, target });
    expect([...result.files.keys()].some(p => /\.behavior\.test\.ts$/.test(p))).toBe(false);
  });
});
