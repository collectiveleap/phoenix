/**
 * #25 — a single client-unrenderable op must not brick the generated app. The web-ui
 * page-generation guidance carries the render-robustness rules (the bug was a reentrant
 * stateful /g regex; the architecture risk is one bad op hanging the whole page). The
 * runtime backstop is the rendered-ui (ui_behavior) Playwright gate, which times out a hang.
 */
import { describe, it, expect } from 'vitest';
import { nodeTypescript } from '../../src/architectures/node-typescript.js';

describe('#25: web-ui generation guidance enforces render robustness', () => {
  const ext = nodeTypescript.promptExtension;

  it('W1: forbids a reentrant shared stateful /g regex (the infinite-loop bug)', () => {
    expect(ext).toMatch(/matchAll|fresh regex/);
    expect(ext).toContain('lastIndex');
  });

  it('W2: requires per-item render isolation (one bad item must not hang/blank the page)', () => {
    expect(ext).toMatch(/try\/catch/);
    expect(ext).toMatch(/placeholder/);
    expect(ext).toMatch(/never hang|NEVER hang/i);
  });

  it('W3: requires tolerating unrenderable data so a reload recovers', () => {
    expect(ext).toMatch(/SKIP it|skip/i);
    expect(ext).toMatch(/reload must recover/i);
  });
});
