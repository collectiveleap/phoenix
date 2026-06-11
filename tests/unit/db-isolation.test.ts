/**
 * #23 — the generated suite must collect deterministically regardless of whether
 * `data/app.db` pre-exists. The node-typescript shared `db.ts` therefore uses an
 * isolated in-memory database under vitest, so test collection never opens (or
 * depends on the state of) the file database.
 */
import { describe, it, expect } from 'vitest';
import { nodeTypescript } from '../../src/architectures/node-typescript.js';

describe('#23: generated db uses an isolated in-memory database under tests', () => {
  const db = nodeTypescript.sharedFiles['src/db.ts'];

  it('defaults DB_PATH to :memory: when running under vitest, file DB otherwise', () => {
    expect(db).toBeDefined();
    expect(db).toContain(`process.env.VITEST ? ':memory:' : 'data/app.db'`);
  });

  it('does not create a directory or open a WAL journal for the in-memory case', () => {
    // WAL + mkdir are guarded so the memory path never touches the filesystem.
    expect(db).toMatch(/DB_PATH !== ':memory:'[\s\S]*mkdirSync/);
    expect(db).toContain(`if (DB_PATH !== ':memory:') db.pragma('journal_mode = WAL')`);
  });
});
