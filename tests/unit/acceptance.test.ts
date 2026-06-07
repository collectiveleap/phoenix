import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runAcceptance } from '../../src/harness/acceptance.js';

describe('Acceptance gate (O12 / appendix #7: "done" means it runs)', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'phoenix-accept-'));
  });

  it('fails and names the typecheck check when a module is broken', async () => {
    // Use the repo compiler so the typecheck branch actually runs.
    const repoTsc = join(process.cwd(), 'node_modules', '.bin', 'tsc');
    mkdirSync(join(projectRoot, 'node_modules', '.bin'), { recursive: true });
    // Symlink-free: point a local tsc shim at the repo tsc.
    writeFileSync(join(projectRoot, 'node_modules', '.bin', 'tsc'), `#!/bin/sh\nexec "${repoTsc}" "$@"\n`, { mode: 0o755 });

    mkdirSync(join(projectRoot, 'src'), { recursive: true });
    writeFileSync(join(projectRoot, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, noEmit: true }, include: ['src'] }));
    writeFileSync(join(projectRoot, 'src', 'broken.ts'), 'export const n: number = "not a number";\n');

    const result = await runAcceptance({ projectRoot, skipRuntime: true });
    expect(result.ok).toBe(false);
    const tc = result.checks.find(c => c.name === 'typecheck')!;
    expect(tc.ok).toBe(false);
    expect(tc.detail).toMatch(/error/);
  });

  it('boots a server and confirms a 200 health route', async () => {
    // A minimal server stands in for the generated app, exercising the
    // boot → poll → 200 → teardown path without needing installed deps.
    writeFileSync(join(projectRoot, 'server.js'), `
      const http = require('http');
      const port = process.env.PORT || 3000;
      http.createServer((req, res) => {
        if (req.url === '/health') { res.writeHead(200); res.end('ok'); }
        else { res.writeHead(404); res.end(); }
      }).listen(port);
    `);

    const result = await runAcceptance({
      projectRoot,
      bootCommand: { cmd: 'node', args: ['server.js'] },
      healthPath: '/health',
      bootTimeoutMs: 8_000,
      // Skip the typecheck portion's tool dependency by checking only runtime:
      // typecheck will report unavailable (no tsc), so assert per-check instead.
    });

    const boot = result.checks.find(c => c.name === 'boot')!;
    const route = result.checks.find(c => c.name === 'root-route')!;
    expect(boot.ok).toBe(true);
    expect(route.ok).toBe(true);
  });
});
