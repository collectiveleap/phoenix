import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { writeScaffoldFiles } from '../../src/harness/scaffold-writer.js';

describe('Tracked scaffold writer (O7 / appendix #6: no silent clobber)', () => {
  let projectRoot: string;
  let phoenixDir: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'phoenix-sw-proj-'));
    phoenixDir = mkdtempSync(join(tmpdir(), 'phoenix-sw-phx-'));
  });

  it('reports created files and writes them', () => {
    const report = writeScaffoldFiles(projectRoot, phoenixDir, [['tsconfig.json', '{"a":1}']]);
    expect(report).toEqual([{ path: 'tsconfig.json', status: 'created' }]);
    expect(readFileSync(join(projectRoot, 'tsconfig.json'), 'utf8')).toBe('{"a":1}');
  });

  it('reports unchanged when content matches', () => {
    writeScaffoldFiles(projectRoot, phoenixDir, [['tsconfig.json', '{"a":1}']]);
    const report = writeScaffoldFiles(projectRoot, phoenixDir, [['tsconfig.json', '{"a":1}']]);
    expect(report[0].status).toBe('unchanged');
  });

  it('overwrites and reports when Phoenix owns the file and content changes', () => {
    writeScaffoldFiles(projectRoot, phoenixDir, [['tsconfig.json', '{"a":1}']]);
    const report = writeScaffoldFiles(projectRoot, phoenixDir, [['tsconfig.json', '{"a":2}']]);
    expect(report[0].status).toBe('updated');
    expect(readFileSync(join(projectRoot, 'tsconfig.json'), 'utf8')).toBe('{"a":2}');
  });

  it('PRESERVES a hand-edited file and reports it (never silent)', () => {
    writeScaffoldFiles(projectRoot, phoenixDir, [['tsconfig.json', '{"a":1}']]);
    // Human edits the managed file.
    writeFileSync(join(projectRoot, 'tsconfig.json'), '{"a":1,"handEdit":true}');
    // Regen would normally rewrite it.
    const report = writeScaffoldFiles(projectRoot, phoenixDir, [['tsconfig.json', '{"a":3}']]);
    expect(report[0].status).toBe('kept-hand-edited');
    // The hand edit survives — not clobbered.
    expect(readFileSync(join(projectRoot, 'tsconfig.json'), 'utf8')).toContain('handEdit');
  });

  it('overwrites a hand-edited file only when forced, and reports that', () => {
    writeScaffoldFiles(projectRoot, phoenixDir, [['tsconfig.json', '{"a":1}']]);
    writeFileSync(join(projectRoot, 'tsconfig.json'), '{"hand":true}');
    const report = writeScaffoldFiles(projectRoot, phoenixDir, [['tsconfig.json', '{"a":9}']], { force: true });
    expect(report[0].status).toBe('overwritten-hand-edited');
    expect(readFileSync(join(projectRoot, 'tsconfig.json'), 'utf8')).toBe('{"a":9}');
  });

  it('treats a pre-existing untracked file as hand-edited (safe default)', () => {
    mkdirSync(projectRoot, { recursive: true });
    writeFileSync(join(projectRoot, 'package.json'), '{"name":"mine"}');
    const report = writeScaffoldFiles(projectRoot, phoenixDir, [['package.json', '{"name":"generated"}']]);
    expect(report[0].status).toBe('kept-hand-edited');
    expect(readFileSync(join(projectRoot, 'package.json'), 'utf8')).toContain('mine');
  });
});
