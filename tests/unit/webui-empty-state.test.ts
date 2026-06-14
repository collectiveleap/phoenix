/**
 * #31 — the generated `render()` had no empty-outline branch, so an empty store rendered no editable
 * line and `ui_behavior`'s openApp couldn't find `getByRole('textbox')`. Guidance now requires render()
 * to handle the empty state (a focusable editable line) and editable surfaces to carry the textbox role.
 */
import { describe, it, expect } from 'vitest';
import { nodeTypescript } from '../../src/architectures/node-typescript.js';
import { buildBoundedShellPrompt } from '../../src/llm/prompt.js';
import { planIUs } from '../../src/iu-planner.js';
import { parseSpec } from '../../src/spec-parser.js';
import { extractCanonicalNodes } from '../../src/canonicalizer.js';
import { deriveInterfaces } from '../../src/scaffold.js';
import { resolveTarget } from '../../src/architectures/index.js';

describe('#31: web-ui guidance requires an empty-state editable line + textbox role', () => {
  it('the system prompt extension mandates render() empty-state and the textbox role', () => {
    const ext = nodeTypescript.promptExtension;
    expect(ext).toMatch(/render\(\).*EMPTY|EMPTY \(zero-item\) state/);
    expect(ext).toMatch(/never a blank container/);
    expect(ext).toMatch(/textbox/i);
    expect(ext).toMatch(/getByRole\('textbox'\)/);
  });

  it('the bounded shell prompt (which authors render()) carries the empty-line + textbox rule', () => {
    const target = resolveTarget('web-api/node-typescript')!;
    const clauses = parseSpec('# Web Experience\n\nThe page must render the outline at GET /.', 'web.md');
    const canon = extractCanonicalNodes(clauses);
    const ius = planIUs(canon, clauses, { roleSurfaces: target.architecture.roleSurfaces });
    const interfaces = deriveInterfaces(ius, canon, target);
    const shellPrompt = buildBoundedShellPrompt(ius[0], canon, interfaces, target);
    expect(shellPrompt).toMatch(/EMPTY/);
    expect(shellPrompt).toMatch(/focusable EDITABLE line/);
    expect(shellPrompt).toMatch(/textbox/);
  });
});
