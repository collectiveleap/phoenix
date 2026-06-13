/**
 * #28 — ui_behavior scenarios must use the spec's gesture (e.g. `@`), not a hardcoded `[[`.
 * #29 — a generated *.ui.spec.ts must typecheck under strict (no untyped `(page)` helper).
 */
import { describe, it, expect } from 'vitest';
import { nodeTypescript } from '../../src/architectures/node-typescript.js';
import { typePlaywrightHelpers } from '../../src/regen.js';

describe('#28: scenarios use the spec-named trigger, not a hardcoded convention', () => {
  it('UI guidance forbids substituting [[ and requires the exact spec gesture', () => {
    const g = nodeTypescript.uiGuidance ?? '';
    expect(g).toMatch(/EXACT trigger/);
    expect(g).toContain('[[');             // names [[ as the convention NOT to substitute
    expect(g).toMatch(/never substitute/i);
  });
});

describe('#29: generated ui-spec helpers are typed under strict', () => {
  it('UI guidance requires typed helper params + the Page type', () => {
    const g = nodeTypescript.uiGuidance ?? '';
    expect(g).toMatch(/page: Page/);
    expect(g).toMatch(/type Page/);
  });

  it('typePlaywrightHelpers annotates an untyped helper and imports Page', () => {
    const out = typePlaywrightHelpers(
      "import { test, expect } from '@playwright/test';\nasync function openApp(page) { await page.goto('/'); }\n");
    expect(out).toContain('openApp(page: Page)');
    expect(out).toMatch(/type Page/);
  });

  it('leaves a call site and a destructured test callback untouched', () => {
    const src = "import { test, type Page } from '@playwright/test';\n"
      + "async function openApp(page: Page){}\n"
      + "test('x', async ({ page }) => { await openApp(page); });";
    const out = typePlaywrightHelpers(src);
    expect(out).toContain('async ({ page }) =>');   // destructured callback unchanged
    expect(out).toContain('await openApp(page)');     // call site not turned into (page: Page)
    expect(out).not.toContain('openApp(page: Page: Page)');
  });
});
