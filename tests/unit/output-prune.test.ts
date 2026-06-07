import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ManifestManager } from '../../src/manifest.js';
import {
  writeScaffoldFiles,
  pruneScaffoldFiles,
  listTrackedScaffoldFiles,
} from '../../src/harness/scaffold-writer.js';
import type { IUManifest } from '../../src/models/manifest.js';

describe('Output-tree ownership (B5: prune what a previous run no longer produces)', () => {
  let projectRoot: string;
  let phoenixDir: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'phoenix-prune-proj-'));
    phoenixDir = mkdtempSync(join(tmpdir(), 'phoenix-prune-phx-'));
  });
  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
    rmSync(phoenixDir, { recursive: true, force: true });
  });

  it('prunes a previous architecture\'s shared file that the current run no longer writes', () => {
    // Previous run wrote shared db.ts through the scaffold writer (creates + tracks).
    writeScaffoldFiles(projectRoot, phoenixDir, [['src/db.ts', '// db\n']]);
    expect(existsSync(join(projectRoot, 'src/db.ts'))).toBe(true);
    expect(listTrackedScaffoldFiles(phoenixDir)).toContain('src/db.ts');

    // Current run (a different arch) keeps only src/store.ts.
    const keep = new Set(['src/store.ts']);
    const removed = pruneScaffoldFiles(projectRoot, phoenixDir, keep);

    expect(removed).toContain('src/db.ts');
    expect(existsSync(join(projectRoot, 'src/db.ts'))).toBe(false);
    expect(listTrackedScaffoldFiles(phoenixDir)).not.toContain('src/db.ts');
  });

  it('keeps files the current run still owns', () => {
    writeScaffoldFiles(projectRoot, phoenixDir, [
      ['package.json', '{}\n'],
      ['src/app.ts', '// app\n'],
    ]);
    const removed = pruneScaffoldFiles(projectRoot, phoenixDir, new Set(['package.json', 'src/app.ts']));
    expect(removed).toEqual([]);
    expect(existsSync(join(projectRoot, 'package.json'))).toBe(true);
  });

  it('prunes generated-module records from an earlier plan (ManifestManager)', () => {
    const mm = new ManifestManager(phoenixDir);
    const iu: IUManifest = {
      iu_id: 'old-iu',
      files: { 'src/generated/svc/old-module.ts': { hash: 'h', size: 1 } },
    } as unknown as IUManifest;
    mm.recordIU(iu);
    expect(mm.getAllTrackedFiles()).toContain('src/generated/svc/old-module.ts');

    // Current plan no longer produces that module.
    const removed = mm.pruneToPaths(new Set(['src/generated/svc/new-module.ts']));
    expect(removed).toContain('src/generated/svc/old-module.ts');
    expect(mm.getAllTrackedFiles()).not.toContain('src/generated/svc/old-module.ts');
  });
});
