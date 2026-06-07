import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { computeResumePlan } from '../../src/harness/resume.js';
import { ManifestManager } from '../../src/manifest.js';
import { sha256 } from '../../src/semhash.js';
import { planIUs } from '../../src/iu-planner.js';
import { parseSpec } from '../../src/spec-parser.js';
import { extractCanonicalNodes } from '../../src/canonicalizer.js';

describe('Resume (O13 / appendix #10: completed modules are not regenerated)', () => {
  let phoenixDir: string;
  let projectRoot: string;

  beforeEach(() => {
    phoenixDir = mkdtempSync(join(tmpdir(), 'phoenix-resume-phx-'));
    projectRoot = mkdtempSync(join(tmpdir(), 'phoenix-resume-proj-'));
  });

  function threeIUs() {
    const spec = `# App\n\n## Auth\n\n- Users must authenticate.\n\n## Billing\n\n- Payments must be processed.\n\n## Reports\n\n- Reports must be generated.`;
    const clauses = parseSpec(spec, 'spec/app.md');
    const canon = extractCanonicalNodes(clauses);
    return planIUs(canon, clauses);
  }

  /** Mark an IU "completed": write its file and record a matching manifest. */
  function complete(mgr: ManifestManager, iu: { iu_id: string; name: string; output_files: string[] }) {
    const files: Record<string, { path: string; content_hash: string; size: number }> = {};
    for (const rel of iu.output_files) {
      const content = `// generated ${iu.name}\n`;
      const full = join(projectRoot, rel);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, content);
      files[rel] = { path: rel, content_hash: sha256(content), size: content.length };
    }
    mgr.recordIU({
      iu_id: iu.iu_id, iu_name: iu.name, files,
      regen_metadata: { model_id: 'm', promptpack_hash: 'h', toolchain_version: 't', generated_at: 'now' },
    });
  }

  it('treats all IUs as pending on a fresh run', () => {
    const ius = threeIUs();
    const plan = computeResumePlan(phoenixDir, projectRoot, ius);
    expect(plan.completed).toHaveLength(0);
    expect(plan.pending).toHaveLength(ius.length);
  });

  it('skips a completed module and runs only the rest', () => {
    const ius = threeIUs();
    const mgr = new ManifestManager(phoenixDir);
    complete(mgr, ius[0]); // module 1 of N done

    const plan = computeResumePlan(phoenixDir, projectRoot, ius);
    expect(plan.completed.map(i => i.iu_id)).toEqual([ius[0].iu_id]);
    expect(plan.pending.map(i => i.iu_id)).toEqual(ius.slice(1).map(i => i.iu_id));
  });

  it('regenerates a module whose file was modified after the manifest (hash mismatch)', () => {
    const ius = threeIUs();
    const mgr = new ManifestManager(phoenixDir);
    complete(mgr, ius[0]);
    // Corrupt the on-disk file → no longer matches the manifest hash.
    writeFileSync(join(projectRoot, ius[0].output_files[0]), '// tampered\n');

    const plan = computeResumePlan(phoenixDir, projectRoot, ius);
    expect(plan.completed).toHaveLength(0);
    expect(plan.pending).toHaveLength(ius.length);
  });
});
