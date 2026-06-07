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
