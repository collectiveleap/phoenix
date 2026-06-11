/**
 * Phase 2 — the rendered-ui surface evaluator drives the booted app via Playwright,
 * and degrades to not-ran (→ INCOMPLETE) when its tooling/inputs are absent — never a
 * false red. Driven against a FAKE `playwright` bin so the suite needs no real chromium.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { renderedUiEvaluator } from '../../src/harness/evaluators.js';

let projectRoot: string;
const ctx = () => ({ projectRoot, baseUrl: 'http://localhost:9999', timeoutMs: 5_000 });

/** Write a fake `node_modules/.bin/playwright` that exits with `code`, emitting `out`. */
function fakePlaywright(code: number, out = ''): void {
  mkdirSync(join(projectRoot, 'node_modules', '.bin'), { recursive: true });
  writeFileSync(
    join(projectRoot, 'node_modules', '.bin', 'playwright'),
    `#!/bin/sh\ncat <<'EOF'\n${out}\nEOF\nexit ${code}\n`,
    { mode: 0o755 },
  );
}

/** Drop a UI spec so the evaluator has something to run. */
function addUiSpec(): void {
  const dir = join(projectRoot, 'src', 'generated', 'web', '__tests__');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'web.ui.spec.ts'), `// placeholder UI spec\n`);
}

describe('rendered-ui evaluator (Playwright)', () => {
  beforeEach(() => { projectRoot = mkdtempSync(join(tmpdir(), 'phoenix-ui-')); });
  afterEach(() => { rmSync(projectRoot, { recursive: true, force: true }); });

  it('not provisioned (no playwright bin) → not-ran → no check (INCOMPLETE)', () => {
    addUiSpec();
    expect(renderedUiEvaluator.run(ctx()).ran).toBe(false);
  });

  it('no UI specs present → not-ran, even with playwright installed', () => {
    fakePlaywright(0);
    expect(renderedUiEvaluator.run(ctx()).ran).toBe(false);
  });

  it('specs + passing playwright → ran, ok (ui_behavior PASS)', () => {
    addUiSpec();
    fakePlaywright(0);
    const res = renderedUiEvaluator.run(ctx());
    expect(res.ran).toBe(true);
    expect(res.ok).toBe(true);
  });

  it('specs + failing playwright → ran, NOT ok (real ui_behavior FAIL)', () => {
    addUiSpec();
    fakePlaywright(1, '1 failed\n  expect(getByText(...)).toBeVisible()');
    const res = renderedUiEvaluator.run(ctx());
    expect(res.ran).toBe(true);
    expect(res.ok).toBe(false);
    expect(res.detail).toMatch(/failed/i);
  });

  it('browser engine not installed → not-ran (provisioning gap, not a failure)', () => {
    addUiSpec();
    fakePlaywright(1, "Executable doesn't exist at /root/.cache/ms-playwright\nplaywright install");
    expect(renderedUiEvaluator.run(ctx()).ran).toBe(false);
  });

  it('produces the ui_behavior evidence kind for the rendered-ui surface', () => {
    expect(renderedUiEvaluator.surface).toBe('rendered-ui');
    expect(renderedUiEvaluator.produces).toBe('ui_behavior');
  });
});
