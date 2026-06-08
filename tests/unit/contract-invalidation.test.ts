/**
 * Step 6 — contract-bearing dependency edges + selective invalidation on a
 * provider contract change.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { planIUs } from '../../src/iu-planner.js';
import { parseSpec } from '../../src/spec-parser.js';
import { extractCanonicalNodes } from '../../src/canonicalizer.js';
import { computeResumePlan } from '../../src/harness/resume.js';
import { ManifestManager } from '../../src/manifest.js';
import { sha256 } from '../../src/semhash.js';
import type { ImplementationUnit } from '../../src/models/iu.js';
import type { InterfaceEntry } from '../../src/scaffold.js';

describe('Step 6a: a web-ui module gets a dependency edge to its sibling api modules', () => {
  it('models the consumer→provider runtime edge (today the field was always [])', () => {
    const spec = [
      '# App', '',
      '## Web Experience', 'The page must render the list in the browser with CSS.', '',
      '## Tasks', 'The service must create a task. The service must delete a task.',
    ].join('\n');
    const clauses = parseSpec(spec, 'app.md');
    const canon = extractCanonicalNodes(clauses);
    const ius = planIUs(canon, clauses);

    const web = ius.find(i => /web/i.test(i.name))!;
    const tasks = ius.find(i => /task/i.test(i.name))!;
    expect(web).toBeDefined();
    expect(tasks).toBeDefined();
    expect(web.dependencies).toContain(tasks.iu_id);
    // Providers do not depend on their consumers.
    expect(tasks.dependencies).not.toContain(web.iu_id);
  });
});

describe('Step 6b: a changed provider contract invalidates the consumer on resume', () => {
  let phoenixDir: string;
  let projectRoot: string;
  const rel = 'src/generated/app/web-experience.ts';
  const code = `await fetch('/outliner-store');`;
  const webIU = { iu_id: 'w', name: 'Web Experience', output_files: [rel] } as unknown as ImplementationUnit;

  const provider = (hash: string): InterfaceEntry => ({
    iu_id: 'prov', name: 'Outliner Store', mount_path: '/outliner-store', role: 'api', resource_fields: '',
    contract: { iu_id: 'prov', identity: 'Outliner Store', operations: [], shape: '', contract_hash: hash },
  });

  beforeEach(() => {
    phoenixDir = mkdtempSync(join(tmpdir(), 'phoenix-inv-phx-'));
    projectRoot = mkdtempSync(join(tmpdir(), 'phoenix-inv-proj-'));
    const full = join(projectRoot, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, code, 'utf8');
    new ManifestManager(phoenixDir).recordIU({
      iu_id: 'w', iu_name: 'Web Experience',
      files: { [rel]: { path: rel, content_hash: sha256(code), size: code.length } },
      regen_metadata: { model_id: 'm', promptpack_hash: 'p', toolchain_version: 't', generated_at: 'now' },
      consumed_contracts: { prov: 'hash-v1' },
    });
  });

  it('keeps the consumer completed when the provider contract is unchanged', () => {
    const plan = computeResumePlan(phoenixDir, projectRoot, [webIU], [provider('hash-v1')]);
    expect(plan.completed.map(i => i.iu_id)).toContain('w');
    expect(plan.pending).toHaveLength(0);
  });

  it('marks the consumer pending when the provider contract changed', () => {
    const plan = computeResumePlan(phoenixDir, projectRoot, [webIU], [provider('hash-v2')]);
    expect(plan.pending.map(i => i.iu_id)).toContain('w');
    expect(plan.completed).toHaveLength(0);
  });
});
