/**
 * P1.2 (end-to-end) — the generated interface client passes a real strict tsc.
 * The "do not edit" `_client.ts` must never fail Phoenix's own typecheck gate
 * (the diagnosis saw 5 implicit-any TS7006 errors from untyped CRUD params).
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { restDialect } from '../../src/architectures/dialects/rest.js';
import { makeContract } from '../../src/models/interface-contract.js';
import type { ImplementationUnit } from '../../src/models/iu.js';
import type { CanonicalNode } from '../../src/models/canonical.js';

const REPO_TSC = join(process.cwd(), 'node_modules', 'typescript', 'bin', 'tsc');

const TSCONFIG = JSON.stringify({
  compilerOptions: {
    strict: true,          // includes noImplicitAny — the TS7006 source
    noEmit: true,
    target: 'ES2022',
    lib: ['ES2022', 'DOM'], // fetch / Promise
    skipLibCheck: true,
  },
  files: ['_client.ts'],
});

describe('P1.2: generated _client.ts passes strict tsc (no implicit-any)', () => {
  it('reports zero type errors over the generated append-only client', () => {
    // Append-only store → contract = list + create.
    const canon = [
      { canon_id: 'a', statement: 'the store must return all operations in seq order' },
      { canon_id: 'b', statement: 'the store must validate and append an operation' },
    ] as unknown as CanonicalNode[];
    const store = {
      name: 'Outliner Store', source_canon_ids: ['a', 'b'],
      contract: { description: 'append-only log', inputs: [], outputs: [], invariants: [] },
    } as unknown as ImplementationUnit;
    const ops = restDialect.deriveOperations(store, canon);
    const client = restDialect.generateClient([makeContract('s', 'Outliner Store', ops, '')])['_client.ts'];

    const dir = mkdtempSync(join(tmpdir(), 'phoenix-client-tc-'));
    writeFileSync(join(dir, '_client.ts'), client, 'utf8');
    writeFileSync(join(dir, 'tsconfig.json'), TSCONFIG, 'utf8');

    let out = '';
    let ok = true;
    try {
      execFileSync('node', [REPO_TSC, '-p', join(dir, 'tsconfig.json')], { encoding: 'utf8', stdio: 'pipe' });
    } catch (e) {
      ok = false;
      const err = e as { stdout?: string; stderr?: string };
      out = (err.stdout ?? '') + (err.stderr ?? '');
    }
    expect(out).not.toMatch(/TS7006/);   // no "parameter implicitly has an 'any' type"
    expect(ok).toBe(true);               // tsc clean
  }, 30000);
});
