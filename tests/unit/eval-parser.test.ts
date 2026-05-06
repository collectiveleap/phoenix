import { describe, it, expect } from 'vitest';
import { parseFeatureFile, loadEvaluationsFromDir } from '../../src/eval-parser.js';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('eval-parser', () => {
  it('parses a single Scenario into one Evaluation', () => {
    const src = `Feature: Tasks

  Scenario: A task can be created and retrieved
    Given no resources of any kind exist
    When a task is created with title "T1" and priority "high"
    Then the request succeeds
    And a task is retrievable with title "T1" and priority "high"
`;
    const evals = parseFeatureFile('virtual.feature', src);
    expect(evals).toHaveLength(1);
    const e = evals[0];
    expect(e.name).toBe('a-task-can-be-created-and-retrieved');
    expect(e.subject.spec_section).toEqual(['Tasks']);
    expect(e.subject.describes).toBe('A task can be created and retrieved');
    expect(e.subject.binding).toBe('boundary_contract');
    expect(e.given.map(s => s.text)).toEqual(['no resources of any kind exist']);
    expect(e.when.map(s => s.text)).toEqual(['a task is created with title "T1" and priority "high"']);
    expect(e.then.map(s => s.text)).toEqual([
      'the request succeeds',
      'a task is retrievable with title "T1" and priority "high"',
    ]);
    expect(e.origin).toBe('specified');
    expect(e.iu_id).toBeUndefined(); // resolved layer not populated by parser
  });

  it('infers failure_mode binding from "rejected" language', () => {
    const src = `Feature: Tasks
  Scenario: An empty title is rejected
    Given no resources exist
    When a task is created with title ""
    Then the request is rejected with a validation error
`;
    const [e] = parseFeatureFile('virtual.feature', src);
    expect(e.subject.binding).toBe('failure_mode');
  });

  it('handles multiple scenarios in one Feature', () => {
    const src = `Feature: Tasks
  Scenario: First
    Given x
    When y
    Then z
  Scenario: Second
    Given a
    When b
    Then c
`;
    const evals = parseFeatureFile('virtual.feature', src);
    expect(evals).toHaveLength(2);
    expect(evals[0].name).toBe('first');
    expect(evals[1].name).toBe('second');
  });

  it('treats And steps as inheriting the previous keyword', () => {
    const src = `Feature: F
  Scenario: S
    Given precondition one
    And precondition two
    When action one
    And action two
    Then outcome one
    And outcome two
`;
    const [e] = parseFeatureFile('virtual.feature', src);
    expect(e.given).toHaveLength(2);
    expect(e.when).toHaveLength(2);
    expect(e.then).toHaveLength(2);
  });

  it('content-addresses eval_id by durable description', () => {
    const src = `Feature: Tasks
  Scenario: S
    Given x
    When y
    Then z
`;
    const a = parseFeatureFile('a.feature', src)[0];
    const b = parseFeatureFile('b.feature', src)[0];
    // Same content-addressed identity regardless of file path
    expect(a.eval_id).toBe(b.eval_id);
    expect(a.eval_id).toMatch(/^eval:[0-9a-f]{64}$/);
  });

  it('loadEvaluationsFromDir returns [] for non-existent directory', () => {
    expect(loadEvaluationsFromDir('/path/does/not/exist/anywhere')).toEqual([]);
  });

  it('loadEvaluationsFromDir reads all .feature files in a directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'phoenix-evalp-'));
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, 'one.feature'),
        `Feature: A\n  Scenario: S1\n    Given x\n    When y\n    Then z\n`,
      );
      writeFileSync(
        join(dir, 'two.feature'),
        `Feature: B\n  Scenario: S2\n    Given a\n    When b\n    Then c\n`,
      );
      writeFileSync(join(dir, 'README.md'), 'not a feature file');
      const evals = loadEvaluationsFromDir(dir);
      expect(evals).toHaveLength(2);
      expect(evals.map(e => e.name).sort()).toEqual(['s1', 's2']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
