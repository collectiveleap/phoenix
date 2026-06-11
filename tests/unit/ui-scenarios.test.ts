/**
 * Phase 4 — Phoenix compiles Playwright UI scenarios from a page's SPEC, for the
 * rendered-ui surface, independent of the generated markup.
 */
import { describe, it, expect } from 'vitest';
import { generateIU } from '../../src/regen.js';
import { planIUs } from '../../src/iu-planner.js';
import { parseSpec } from '../../src/spec-parser.js';
import { extractCanonicalNodes } from '../../src/canonicalizer.js';
import { deriveInterfaces } from '../../src/scaffold.js';
import { resolveTarget } from '../../src/architectures/index.js';
import { buildUiScenarioPrompt } from '../../src/llm/prompt.js';
import type { InterfaceContract } from '../../src/models/interface-contract.js';
import type { LLMProvider, GenerateOptions, StreamHooks } from '../../src/llm/provider.js';

const IMPL_MARKER = 'IMPL_ONLY_MARKER_xyz';

/** Returns module code, a vitest test, or a Playwright spec depending on the prompt. */
class UiAwareProvider implements LLMProvider {
  readonly name = 'fake';
  readonly model = 'test';
  seen: { system: string; prompt: string }[] = [];
  constructor(private readonly emptyUi = false) {}
  generate(p: string, o?: GenerateOptions): Promise<string> { return this.generateStream(p, o); }
  async generateStream(prompt: string, o?: GenerateOptions, hooks?: StreamHooks): Promise<string> {
    const system = o?.system ?? '';
    this.seen.push({ system, prompt });
    const isUi = /Playwright/i.test(system + prompt);
    let body: string;
    if (isUi) {
      body = this.emptyUi ? '' :
        `import { test, expect } from '@playwright/test';\ntest('shows the list', async ({ page }) => { await page.goto('/'); await expect(page.getByText('x')).toBeVisible(); });\n`;
    } else {
      body = `import { Hono } from 'hono';\nconst router = new Hono();\nrouter.get('/', (c) => c.html('<h1>page</h1>')); // ${IMPL_MARKER}\nexport default router;\nexport const _phoenix = {} as const;\n`;
    }
    hooks?.onFirstByte?.();
    hooks?.onChunk?.(body.length, body);
    hooks?.onStopReason?.('end_turn');
    hooks?.onStreamEnd?.();
    return body;
  }
}

function setupWeb(emptyUi = false) {
  const target = resolveTarget('web-api/node-typescript')!;
  const clauses = parseSpec('# Web Experience\n\nThe page must render the task list. The user must be able to add a task.', 'web.md');
  const canon = extractCanonicalNodes(clauses);
  const ius = planIUs(canon, clauses, { roleSurfaces: target.architecture.roleSurfaces });
  const interfaces = deriveInterfaces(ius, canon, target);
  return { target, canon, ius, interfaces, provider: new UiAwareProvider(emptyUi) };
}

describe('Phase 4: UI scenarios are compiled from the spec for the rendered-ui surface', () => {
  it('generates a *.ui.spec.ts for a rendered-ui (web-ui) module', async () => {
    const { target, canon, ius, interfaces, provider } = setupWeb();
    const web = ius[0];
    const result = await generateIU(web, { llm: provider, canonNodes: canon, allIUs: ius, interfaces, target });

    const specEntry = [...result.files.keys()].find(p => /__tests__\/.*\.ui\.spec\.ts$/.test(p));
    expect(specEntry).toBeDefined();
    const spec = result.files.get(specEntry!)!;
    expect(spec).toContain(`from '@playwright/test'`);
    expect(spec).toContain('page.goto');
  });

  it('does NOT generate a *.ui.spec.ts for an api module', async () => {
    const target = resolveTarget('web-api/node-typescript')!;
    const clauses = parseSpec('# Tasks\n\nThe service must create a task.', 'tasks.md');
    const canon = extractCanonicalNodes(clauses);
    const ius = planIUs(canon, clauses, { roleSurfaces: target.architecture.roleSurfaces });
    const interfaces = deriveInterfaces(ius, canon, target);
    const result = await generateIU(ius[0], { llm: new UiAwareProvider(), canonNodes: canon, allIUs: ius, interfaces, target });
    expect([...result.files.keys()].some(p => /\.ui\.spec\.ts$/.test(p))).toBe(false);
  });

  it('null scenario output → no file written (rendered-ui stays INCOMPLETE, never a false green)', async () => {
    const { target, canon, ius, interfaces, provider } = setupWeb(true); // provider returns empty UI body
    const result = await generateIU(ius[0], { llm: provider, canonNodes: canon, allIUs: ius, interfaces, target });
    expect([...result.files.keys()].some(p => /\.ui\.spec\.ts$/.test(p))).toBe(false);
  });

  it('compiles the scenario from the spec + dep contracts, never the markup (independence)', () => {
    const target = resolveTarget('web-api/node-typescript')!;
    const clauses = parseSpec('# Web Experience\n\nThe page must render the task list. The user must be able to add a task.', 'web.md');
    const canon = extractCanonicalNodes(clauses);
    const ius = planIUs(canon, clauses, { roleSurfaces: target.architecture.roleSurfaces });
    const depContract = {
      operations: [{ address: { method: 'POST', path: '/tasks' }, purpose: 'create a task' }],
    } as unknown as InterfaceContract;

    const prompt = buildUiScenarioPrompt(ius[0], canon, [depContract], target);
    // From the spec requirements:
    expect(prompt.toLowerCase()).toContain('render the task list');
    // From the dependency API contract (the round-trip the page drives):
    expect(prompt).toContain('POST /tasks');
    expect(prompt).toContain('create a task');
    // The accessibility-only rule from uiGuidance, and never the markup:
    expect(prompt).toMatch(/getByRole|getByText/);
    expect(prompt).not.toContain(IMPL_MARKER);
  });
});
