import { describe, it, expect } from 'vitest';
import { planIUs, isWebUIName } from '../../src/iu-planner.js';
import { parseSpec } from '../../src/spec-parser.js';
import { extractCanonicalNodes } from '../../src/canonicalizer.js';

describe('planIUs', () => {
  it('returns empty array for no canonical nodes', () => {
    expect(planIUs([], [])).toEqual([]);
  });

  it('creates IUs from canonical nodes', () => {
    const clauses = parseSpec('# Auth\n\nUsers must log in.\nPasswords must be hashed.', 'test.md');
    const canon = extractCanonicalNodes(clauses);
    const ius = planIUs(canon, clauses);
    expect(ius.length).toBeGreaterThan(0);
  });

  it('groups linked canonical nodes into the same IU', () => {
    const spec = `# Auth

Users must authenticate with JWT tokens.

## Security

JWT tokens must be signed with RS256.`;
    const clauses = parseSpec(spec, 'test.md');
    const canon = extractCanonicalNodes(clauses);
    const ius = planIUs(canon, clauses);
    // Linked nodes should be grouped — fewer IUs than nodes
    expect(ius.length).toBeLessThanOrEqual(canon.length);
  });

  it('sets risk tier based on constraints', () => {
    const clauses = parseSpec('# Security Constraints\n\nDirect DB access is forbidden.\nRate limited to 5 per minute.', 'test.md');
    const canon = extractCanonicalNodes(clauses);
    const ius = planIUs(canon, clauses);
    expect(ius.length).toBeGreaterThan(0);
    // Should be medium or high due to constraints
    expect(['medium', 'high', 'critical']).toContain(ius[0].risk_tier);
  });

  it('populates all required IU fields', () => {
    const clauses = parseSpec('# Auth\n\nUsers must authenticate.', 'test.md');
    const canon = extractCanonicalNodes(clauses);
    const ius = planIUs(canon, clauses);

    for (const iu of ius) {
      expect(iu.iu_id).toHaveLength(64);
      expect(iu.kind).toBe('module');
      expect(iu.name).toBeTruthy();
      expect(iu.risk_tier).toBeTruthy();
      expect(iu.contract.description).toBeTruthy();
      expect(iu.source_canon_ids.length).toBeGreaterThan(0);
      expect(iu.output_files.length).toBeGreaterThan(0);
      expect(iu.boundary_policy).toBeTruthy();
      expect(iu.evidence_policy.required.length).toBeGreaterThan(0);
    }
  });

  it('generates output file paths under src/generated/', () => {
    const clauses = parseSpec('# Auth\n\nUsers must log in.', 'test.md');
    const canon = extractCanonicalNodes(clauses);
    const ius = planIUs(canon, clauses);

    for (const iu of ius) {
      for (const f of iu.output_files) {
        expect(f).toMatch(/^src\/generated\//);
        expect(f).toMatch(/\.ts$/);
      }
    }
  });

  it('assigns evidence policy based on risk tier', () => {
    const clauses = parseSpec('# Auth\n\nUsers must log in.', 'test.md');
    const canon = extractCanonicalNodes(clauses);
    const ius = planIUs(canon, clauses);

    for (const iu of ius) {
      expect(iu.evidence_policy.required).toContain('typecheck');
      if (iu.risk_tier === 'medium' || iu.risk_tier === 'high') {
        expect(iu.evidence_policy.required).toContain('unit_tests');
      }
    }
  });
});

describe('Phase 0: surface-driven evidence policy (rendered-ui vs http-endpoints)', () => {
  // An api resource and a web-ui page (separate docs → separate modules), both
  // pushed to medium+ by constraints.
  const clauses = [
    ...parseSpec('# Tasks\n\nThe service must create a task. A task title must never be empty.', 'tasks.md'),
    ...parseSpec('# Web Experience\n\nThe page must render the task list. The list must never display tasks out of order.', 'web.md'),
  ];
  const canon = extractCanonicalNodes(clauses);
  const ius = planIUs(canon, clauses);

  it('an api module requires unit_tests (its http-endpoints surface), not ui_behavior', () => {
    const api = ius.find(iu => !isWebUIName(iu.name));
    expect(api).toBeDefined();
    expect(['medium', 'high', 'critical']).toContain(api!.risk_tier);
    expect(api!.evidence_policy.required).toContain('unit_tests');
    expect(api!.evidence_policy.required).not.toContain('ui_behavior');
  });

  it('a web-ui module requires ui_behavior (its rendered-ui surface), NOT unit_tests', () => {
    const web = ius.find(iu => isWebUIName(iu.name));
    expect(web).toBeDefined();
    expect(['medium', 'high', 'critical']).toContain(web!.risk_tier);
    expect(web!.evidence_policy.required).toContain('ui_behavior');
    expect(web!.evidence_policy.required).not.toContain('unit_tests');
  });
});
