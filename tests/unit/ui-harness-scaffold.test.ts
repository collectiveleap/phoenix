/**
 * Phase 3 — a target that declares `browserDeps` gets a Playwright config scaffolded
 * for the rendered-ui surface; one that doesn't, doesn't. Phoenix owns the boot, so the
 * config has no `webServer` and reads the live URL from PHOENIX_BASE_URL.
 */
import { describe, it, expect } from 'vitest';
import { generateProjectConfig } from '../../src/scaffold.js';
import { resolveTarget } from '../../src/architectures/index.js';

describe('Phase 3: playwright.config.ts scaffold (rendered-ui surface)', () => {
  it('is emitted for a target with browserDeps (node-typescript), with the right shape', () => {
    const target = resolveTarget('web-api/node-typescript')!;
    expect(target.runtime.browserDeps).toContain('chromium');
    const config = generateProjectConfig([], 'app', target).get('playwright.config.ts');
    expect(config).toBeDefined();
    expect(config!).toContain(`testMatch: '**/*.ui.spec.ts'`);
    expect(config!).toContain('process.env.PHOENIX_BASE_URL');
    expect(config!).not.toContain('webServer'); // Phoenix owns the boot, not Playwright
  });

  it('is NOT emitted when the target declares no browser engine', () => {
    // No target ⇒ no browser surface ⇒ no playwright config.
    expect(generateProjectConfig([], 'app', null).has('playwright.config.ts')).toBe(false);
  });
});
