/**
 * #26 — the generated web-ui silently under-implemented a clear interaction spec, and the
 * flaky ui_behavior evaluator let it pass. Guidance closes both: the page-generation prompt
 * demands full-fidelity (every branch of each clause), and the UI-scenario guidance makes the
 * evaluator reliable (wait-for-interactive, test independence, per-branch coverage) so a
 * missing behavior fails instead of slipping through.
 */
import { describe, it, expect } from 'vitest';
import { nodeTypescript } from '../../src/architectures/node-typescript.js';

describe('#26: page generation demands full-fidelity (F1)', () => {
  const ext = nodeTypescript.promptExtension;
  it('requires implementing every branch of an interaction clause, not a subset', () => {
    expect(ext).toMatch(/EVERY behavior/);
    expect(ext).toMatch(/branch/i);
    expect(ext).toMatch(/Partially implementing/);
    expect(ext).toMatch(/is a defect/);
  });
});

describe('#26: UI-scenario guidance makes the evaluator reliable (F2/F3)', () => {
  const ui = nodeTypescript.uiGuidance ?? '';
  it('requires waiting for interactivity before acting (no race after goto)', () => {
    expect(ui).toMatch(/never type immediately after/i);
    expect(ui).toMatch(/interactive BEFORE acting/);
  });
  it('requires self-contained, order-independent tests (shared persistent store)', () => {
    expect(ui).toMatch(/SELF-CONTAINED and order-independent/);
    expect(ui).toMatch(/persistent store/);
  });
  it('requires a scenario per branch/direction so a missing behavior fails', () => {
    expect(ui).toMatch(/every branch and direction/);
    expect(ui).toMatch(/missing branch must surface as a failing/);
  });
});
