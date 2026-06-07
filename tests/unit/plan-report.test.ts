import { describe, it, expect } from 'vitest';
import { planIUs, analyzePlan } from '../../src/iu-planner.js';
import { parseSpec } from '../../src/spec-parser.js';
import { extractCanonicalNodes } from '../../src/canonicalizer.js';

describe('Plan inspection (O5/O10, appendix #5)', () => {
  function plan(spec: string) {
    const clauses = parseSpec(spec, 'spec/app.md');
    const canon = extractCanonicalNodes(clauses);
    const ius = planIUs(canon, clauses);
    return { ius, canon, clauses };
  }

  it('lists each module with name, path, role and source-node count (O5)', () => {
    const { ius, canon, clauses } = plan(
      `# App\n\n## Auth\n\n- Users must authenticate.\n- Sessions must expire.\n\n## Billing\n\n- Payments must be processed.`,
    );
    const report = analyzePlan(ius, canon, clauses);
    expect(report.modules.length).toBe(ius.length);
    for (const m of report.modules) {
      expect(m.name.length).toBeGreaterThan(0);
      expect(m.outputPath).toMatch(/\.ts$/);
      expect(['api', 'web-ui']).toContain(m.role);
      expect(m.sourceNodeCount).toBeGreaterThan(0);
    }
  });

  it('exposes the heading → module mapping so fragmentation is visible', () => {
    const { ius, canon, clauses } = plan(
      `# App\n\n## Auth\n\n- Users must authenticate.\n- Sessions must expire.\n\n## Billing\n\n- Payments must be processed.\n- Refunds must be supported.`,
    );
    const report = analyzePlan(ius, canon, clauses);
    expect(report.headingToModule.length).toBeGreaterThan(0);
    // Distinct sections should surface in the mapping.
    const headings = report.headingToModule.map(h => h.heading).join(' ');
    expect(headings).toMatch(/Auth/);
    expect(headings).toMatch(/Billing/);
  });

  it('flags oversized modules above the configured threshold (O10)', () => {
    // Many distinct requirements in a single section → one large module.
    const names = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta'];
    const reqs = names.map(n => `- The system must support distinct capability ${n}.`).join('\n');
    const { ius, canon, clauses } = plan(`# App\n\n## Mega\n\n${reqs}`);
    const report = analyzePlan(ius, canon, clauses, { sizeThreshold: 3 });
    expect(report.oversizedCount).toBeGreaterThan(0);
    const oversized = report.modules.find(m => m.oversized)!;
    expect(oversized.sourceNodeCount).toBeGreaterThan(3);
    expect(oversized.estimate.approxTokens).toBeGreaterThan(0);
  });
});

describe('Spec-shape feedback (F2/F4/F5)', () => {
  function report(spec: string) {
    const clauses = parseSpec(spec, 'spec/app.md');
    const canon = extractCanonicalNodes(clauses);
    const ius = planIUs(canon, clauses);
    return analyzePlan(ius, canon, clauses);
  }

  it('F2a: warns when a cohesive UI is fragmented across multiple ## sections', () => {
    // A single-page UI described across three sibling sections → three modules.
    const r = report(
      `# Notes App\n\n` +
        `## Loading\n\n- The page must render in the browser within one second.\n- The app must load data on startup.\n\n` +
        `## Editing\n\n- Each keystroke must update the contenteditable region.\n- The caret must stay visible while typing.\n\n` +
        `## Styling\n\n- Buttons must use the CSS stylesheet.\n- The layout must show a hover state.`,
    );
    const frag = r.warnings.find(w => w.kind === 'fragmented-ui');
    expect(frag).toBeDefined();
    // Names the fragmented sections so the author knows what to merge.
    const headings = frag!.headings.join(' ');
    expect(headings).toMatch(/Loading/);
    expect(headings).toMatch(/Editing/);
    expect(headings).toMatch(/Styling/);
  });

  it('F5: a single ## Web Experience section produces no fragmentation warning', () => {
    // The session restructuring (four subsections → one section) is now pre-empted.
    const r = report(
      `# Notes App\n\n` +
        `## Web Experience\n\n` +
        `- The page must render in the browser.\n` +
        `- Each keystroke must update the contenteditable region.\n` +
        `- Buttons must use the CSS stylesheet.`,
    );
    expect(r.warnings.find(w => w.kind === 'fragmented-ui')).toBeUndefined();
  });

  it('F2b: warns when an intro carries normative content (spurious module)', () => {
    const r = report(
      `The system must encrypt all data at rest.\nThe service must log every request.\n\n` +
        `# Service\n\n## Auth\n\n- Users must authenticate.\n- Sessions must expire.`,
    );
    const intro = r.warnings.find(w => w.kind === 'normative-intro');
    expect(intro).toBeDefined();
    expect(intro!.headings.join(' ')).toMatch(/preamble/);
  });

  it('F2c: warns when a ## section is context-only (empty/stub module)', () => {
    const r = report(
      `# App\n\n## Auth\n\n- Users must authenticate.\n- Sessions must expire.\n\n` +
        `## Background\n\nThe project began in 2019 as a small side experiment.\nIt grew over time into a larger initiative.`,
    );
    const empty = r.warnings.find(w => w.kind === 'empty-section');
    expect(empty).toBeDefined();
    expect(empty!.headings.join(' ')).toMatch(/Background/);
  });

  it('F4: every warning carries a concrete, non-empty remediation', () => {
    const r = report(
      `# Notes App\n\n` +
        `## Loading\n\n- The page must render in the browser within one second.\n- The app must load data on startup.\n\n` +
        `## Styling\n\n- Buttons must use the CSS stylesheet.\n- The layout must show a hover state.`,
    );
    expect(r.warnings.length).toBeGreaterThan(0);
    for (const w of r.warnings) {
      expect(w.message.length).toBeGreaterThan(0);
      expect(w.remediation.length).toBeGreaterThan(0);
    }
  });

  it('a well-shaped spec produces no spec-shape warnings', () => {
    const r = report(
      `# App\n\n## Auth\n\n- Users must authenticate.\n- Sessions must expire.\n\n` +
        `## Billing\n\n- Payments must be processed.\n- Refunds must be supported.`,
    );
    expect(r.warnings).toEqual([]);
  });
});
