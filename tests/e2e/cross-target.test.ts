/**
 * E2E: Durable / Ephemeral Split — Cross-Target Regen
 *
 * Proves Phoenix's core thesis at the structural level:
 *
 *   Same spec → same canonical graph + IU plan (durable)
 *   Different runtime targets → different generated artifacts (ephemeral)
 *
 * Approach: bootstrap once, hash the durable artifacts, then regen against
 * two runtime targets that share an architecture. Assert durable hashes are
 * preserved across regens, per-IU file paths match (same architecture, same
 * layout), and the runtime-specific shared files diverge as expected.
 *
 * Functional (HTTP-replay) equivalence is intentionally out of scope here —
 * see plan: /Users/san/.claude/plans/tidy-pondering-thompson.md
 */

import { describe, it, expect } from 'vitest';
import {
  mkdtempSync, mkdirSync, writeFileSync, cpSync, readdirSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { parseSpec as _parseSpec } from '../../src/spec-parser.js';
import { extractCanonicalNodes } from '../../src/canonicalizer.js';
import { computeWarmHashes as _computeWarmHashes } from '../../src/warm-hasher.js';
import { planIUs } from '../../src/iu-planner.js';
import { generateAll } from '../../src/regen.js';
import { resolveTarget } from '../../src/architectures/index.js';
import { sha256 } from '../../src/semhash.js';
import { SpecStore } from '../../src/store/spec-store.js';
import { CanonicalStore } from '../../src/store/canonical-store.js';
import { BootstrapStateMachine } from '../../src/bootstrap.js';
import type { Clause } from '../../src/models/clause.js';

const fixturesDir = join(import.meta.dirname, '..', 'fixtures');

/**
 * Same shape as bootstrapProject() in success-criteria.test.ts. Inlined here
 * to avoid cross-file test helper imports; mirrored deliberately.
 */
function bootstrapProject(specFiles: string[]) {
  const projectRoot = mkdtempSync(join(tmpdir(), 'phoenix-cross-target-'));
  const phoenixDir = join(projectRoot, '.phoenix');
  const specDir = join(projectRoot, 'spec');

  mkdirSync(join(phoenixDir, 'store', 'objects'), { recursive: true });
  mkdirSync(join(phoenixDir, 'graphs'), { recursive: true });
  mkdirSync(join(phoenixDir, 'manifests'), { recursive: true });
  mkdirSync(specDir, { recursive: true });

  for (const src of specFiles) {
    cpSync(src, join(specDir, src.split('/').pop()!));
  }

  const specStore = new SpecStore(phoenixDir);
  const allClauses: Clause[] = [];
  const specFilesList = readdirSync(specDir)
    .filter(f => f.endsWith('.md'))
    .map(f => join(specDir, f));
  for (const sf of specFilesList) {
    const result = specStore.ingestDocument(sf, projectRoot);
    allClauses.push(...result.clauses);
  }

  const canonStore = new CanonicalStore(phoenixDir);
  const canonNodes = extractCanonicalNodes(allClauses);
  canonStore.saveNodes(canonNodes);

  const ius = planIUs(canonNodes, allClauses);
  writeFileSync(join(phoenixDir, 'graphs', 'ius.json'), JSON.stringify(ius, null, 2));

  const machine = new BootstrapStateMachine();
  machine.markWarmPassComplete();

  return { projectRoot, phoenixDir, canonStore, canonNodes, ius, allClauses };
}

/** Stable hash of the canonical store contents (durable layer). */
function hashCanonicalStore(canonStore: CanonicalStore): string {
  const nodes = canonStore.getAllNodes();
  // Sort by canon_id for deterministic ordering.
  const sorted = [...nodes].sort((a, b) => a.canon_id.localeCompare(b.canon_id));
  return sha256(JSON.stringify(sorted));
}

/** Stable hash of the IU plan (durable layer). */
function hashIUPlan(ius: ReadonlyArray<{ iu_id: string }>): string {
  const sorted = [...ius].sort((a, b) => a.iu_id.localeCompare(b.iu_id));
  return sha256(JSON.stringify(sorted));
}

/** Flatten a regen result list into a path → content map. */
function flattenFiles(
  results: Awaited<ReturnType<typeof generateAll>>,
): Map<string, string> {
  const flat = new Map<string, string>();
  for (const r of results) {
    for (const [p, c] of r.files) flat.set(p, c);
  }
  return flat;
}

describe('E2E: Durable/Ephemeral split — cross-target regen', () => {
  it('same canonical+IU artifacts produce divergent ephemeral output across two runtime targets', async () => {
    // ── Setup: bootstrap once ────────────────────────────────────────────────
    const ctx = bootstrapProject([join(fixturesDir, 'spec-gateway.md')]);

    expect(ctx.canonNodes.length).toBeGreaterThan(0);
    expect(ctx.ius.length).toBeGreaterThan(0);

    // ── Snapshot durable artifacts BEFORE any regen ──────────────────────────
    const canonHashBefore = hashCanonicalStore(ctx.canonStore);
    const iuPlanHashBefore = hashIUPlan(ctx.ius);

    // ── Resolve two targets sharing an architecture ──────────────────────────
    const targetA = resolveTarget('web-api/node-typescript');
    const targetB = resolveTarget('web-api/node-typescript-stdlib');
    expect(targetA, 'web-api/node-typescript must be registered').toBeTruthy();
    expect(targetB, 'web-api/node-typescript-stdlib must be registered').toBeTruthy();
    // Same architecture, different runtime — the entire point of this test.
    expect(targetA!.architecture.name).toBe(targetB!.architecture.name);
    expect(targetA!.runtime.name).not.toBe(targetB!.runtime.name);

    // ── Regen against both targets (stub mode → no LLM variance) ─────────────
    const resultsA = await generateAll(ctx.ius, {
      target: targetA,
      canonNodes: ctx.canonNodes,
      allIUs: ctx.ius,
    });
    const resultsB = await generateAll(ctx.ius, {
      target: targetB,
      canonNodes: ctx.canonNodes,
      allIUs: ctx.ius,
    });

    // ── Assert durable layer survived two regens unchanged ───────────────────
    const canonHashAfter = hashCanonicalStore(ctx.canonStore);
    const iuPlanHashAfter = hashIUPlan(ctx.ius);
    expect(canonHashAfter).toBe(canonHashBefore);
    expect(iuPlanHashAfter).toBe(iuPlanHashBefore);

    // ── Assert per-IU file LAYOUT is identical (same architecture) ──────────
    const filesA = flattenFiles(resultsA);
    const filesB = flattenFiles(resultsB);
    expect([...filesA.keys()].sort()).toEqual([...filesB.keys()].sort());
    expect(filesA.size).toBeGreaterThan(0);

    // ── Assert per-IU CONTENT is identical in stub mode ─────────────────────
    // Stub generation depends only on the architecture, not the runtime, so
    // both targets produce byte-identical IU module bodies. This isolates the
    // ephemeral delta to runtime-target shared files (next assertion).
    for (const [path, contentA] of filesA) {
      expect(filesB.get(path), `mismatch at ${path}`).toBe(contentA);
    }

    // ── Assert ephemeral runtime delta IS observable in shared files ────────
    // The two targets have different src/db.ts (the only file the runtime
    // owns directly). This is the ephemeral signal: same durable inputs,
    // different code where the runtime differs.
    const dbA = targetA!.runtime.sharedFiles['src/db.ts'];
    const dbB = targetB!.runtime.sharedFiles['src/db.ts'];
    expect(dbA).toBeTruthy();
    expect(dbB).toBeTruthy();
    expect(dbA).not.toBe(dbB);
    expect(dbA).toContain("better-sqlite3");
    expect(dbB).toContain("node:sqlite");

    // ── Assert package set differs (no better-sqlite3 in stdlib variant) ────
    expect(targetA!.runtime.packages['better-sqlite3']).toBeTruthy();
    expect(targetB!.runtime.packages['better-sqlite3']).toBeUndefined();
  });
});
