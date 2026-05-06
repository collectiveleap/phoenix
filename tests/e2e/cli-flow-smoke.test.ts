/**
 * E2E: CLI-flow smoke test
 *
 * For each registered (architecture, runtime) pair, drives the actual CLI
 * binary through init → bootstrap → regen --stubs and verifies that the
 * resulting project on disk has the right target-specific shape:
 *
 *   - .phoenix/config.json was written with the requested architecture
 *   - package.json contains the expected framework dep and excludes
 *     competing targets' deps
 *   - src/server.ts contains the right framework signatures
 *   - src/db.ts contains the right driver signatures
 *
 * Why this exists: every other integration test calls generateScaffold()
 * directly and bypasses the CLI. During iter 10's verification a stale
 * dist/ caused init to silently fail (exit 0 + suppressed stderr) for the
 * Express target — the integration tests passed but the CLI flow was
 * broken. This test exercises the path the user actually uses.
 *
 * Self-rebuilds dist/ if it's missing or older than any src file, so
 * developers don't have to remember `pnpm build` before running tests.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import {
  mkdtempSync, mkdirSync, rmSync, readFileSync, cpSync, existsSync, statSync, readdirSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync, spawnSync } from 'node:child_process';

const repoRoot = join(import.meta.dirname, '..', '..');
const cli = join(repoRoot, 'dist', 'cli.js');

// ─── Dist freshness ─────────────────────────────────────────────────────────

function newestMtimeUnder(dir: string): number {
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      newest = Math.max(newest, newestMtimeUnder(full));
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      newest = Math.max(newest, statSync(full).mtimeMs);
    }
  }
  return newest;
}

function ensureDistFresh(): void {
  const distExists = existsSync(cli);
  const distMtime = distExists ? statSync(cli).mtimeMs : 0;
  const newestSrcMtime = newestMtimeUnder(join(repoRoot, 'src'));
  if (!distExists || newestSrcMtime > distMtime) {
    execSync('./node_modules/.bin/tsc', { cwd: repoRoot, stdio: 'inherit' });
  }
}

// ─── Target fingerprints ────────────────────────────────────────────────────

interface TargetFingerprint {
  name: string;
  packageJsonContains: string[];
  packageJsonNotContains: string[];
  serverContains: string[];
  dbContains: string[];
}

const TARGETS: TargetFingerprint[] = [
  {
    name: 'web-api/node-typescript',
    packageJsonContains: ['"hono"', '"better-sqlite3"', '"tsx"', '"dev": "tsx watch src/server.ts"'],
    packageJsonNotContains: ['"express"', 'tsc && node dist/'],
    serverContains: ['@hono/node-server', 'app.fetch', 'app.notFound'],
    dbContains: ['better-sqlite3', 'new Database'],
  },
  {
    name: 'web-api/node-typescript-stdlib',
    packageJsonContains: ['"hono"', '"tsx"', '"dev": "tsx watch src/server.ts"'],
    packageJsonNotContains: ['"better-sqlite3"', '"express"'],
    serverContains: ['@hono/node-server', 'app.notFound'],
    dbContains: ['node:sqlite', 'DatabaseSync'],
  },
  {
    name: 'web-api/node-typescript-express',
    packageJsonContains: ['"express"', '"better-sqlite3"', '"tsx"', '"dev": "tsx watch src/server.ts"'],
    packageJsonNotContains: ['"hono"', 'tsc && node dist/'],
    serverContains: ['app.listen', 'app.use(', 'res.status(404)'],
    dbContains: ['better-sqlite3', 'new Database'],
  },
];

// ─── Test ───────────────────────────────────────────────────────────────────

describe('E2E: CLI-flow smoke test', () => {
  beforeAll(ensureDistFresh);

  for (const target of TARGETS) {
    it(`init+bootstrap+regen produces correct project for ${target.name}`, () => {
      const dir = mkdtempSync(join(tmpdir(), 'phoenix-cli-flow-'));
      try {
        mkdirSync(join(dir, 'spec'), { recursive: true });
        cpSync(join(repoRoot, 'examples', 'todo-app', 'spec'), join(dir, 'spec'), { recursive: true });

        const opts = { cwd: dir, stdio: 'pipe' as const };
        execSync(`node ${JSON.stringify(cli)} init --arch=${target.name}`, opts);
        execSync(`node ${JSON.stringify(cli)} bootstrap`, opts);
        execSync(`node ${JSON.stringify(cli)} regen --stubs`, opts);

        // .phoenix/config.json wired up correctly
        const configPath = join(dir, '.phoenix', 'config.json');
        expect(existsSync(configPath), 'config.json must exist').toBe(true);
        const config = JSON.parse(readFileSync(configPath, 'utf8'));
        expect(config.architecture).toBe(target.name);

        // Scaffolded files have target-specific fingerprints
        const pkg = readFileSync(join(dir, 'package.json'), 'utf8');
        for (const s of target.packageJsonContains) {
          expect(pkg, `package.json should contain ${JSON.stringify(s)}`).toContain(s);
        }
        for (const s of target.packageJsonNotContains) {
          expect(pkg, `package.json should NOT contain ${JSON.stringify(s)}`).not.toContain(s);
        }

        const server = readFileSync(join(dir, 'src', 'server.ts'), 'utf8');
        for (const s of target.serverContains) {
          expect(server, `server.ts should contain ${JSON.stringify(s)}`).toContain(s);
        }

        const dbFile = readFileSync(join(dir, 'src', 'db.ts'), 'utf8');
        for (const s of target.dbContains) {
          expect(dbFile, `db.ts should contain ${JSON.stringify(s)}`).toContain(s);
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  it('rejects unknown --arch with non-zero exit code and stderr message', () => {
    const dir = mkdtempSync(join(tmpdir(), 'phoenix-cli-flow-bad-'));
    try {
      const r = spawnSync('node', [cli, 'init', '--arch=does-not-exist'], { cwd: dir });
      expect(r.status, 'init with bad --arch must exit non-zero').not.toBe(0);
      expect(r.stderr.toString(), 'stderr must mention the failure').toContain('Unknown architecture');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
