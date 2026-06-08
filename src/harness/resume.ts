/**
 * Resume (PRD O13 / appendix #10).
 *
 * A relaunched run must not redo already-completed modules. Completion is
 * content-addressed: an IU is "done" when the generated manifest has its entry
 * AND every output file exists on disk with a hash matching the manifest. This
 * is robust to interruption — a half-written or missing file is treated as
 * pending and regenerated.
 *
 * Full run state (what ran, outcomes, timings) is reconstructable separately
 * via `RunJournal.readState` / `readEvents`.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ManifestManager } from '../manifest.js';
import { sha256 } from '../semhash.js';
import type { ImplementationUnit } from '../models/iu.js';
import type { InterfaceEntry } from '../scaffold.js';

export interface ResumePlan {
  completed: ImplementationUnit[];
  pending: ImplementationUnit[];
}

/**
 * Partition IUs into already-completed vs still-pending based on the manifest
 * and on-disk file hashes. When `interfaces` is given, a consumer whose recorded
 * consumed contract hash no longer matches the provider's current contract is
 * also treated as pending — selective invalidation on the runtime interface edge.
 */
export function computeResumePlan(
  phoenixDir: string,
  projectRoot: string,
  ius: ImplementationUnit[],
  interfaces?: InterfaceEntry[],
): ResumePlan {
  const manifest = new ManifestManager(phoenixDir).load();
  const completed: ImplementationUnit[] = [];
  const pending: ImplementationUnit[] = [];
  const currentHash = new Map(
    (interfaces ?? []).filter(e => e.contract).map(e => [e.iu_id, e.contract!.contract_hash]),
  );

  for (const iu of ius) {
    const entry = manifest.iu_manifests[iu.iu_id];
    const filesMatch = !!entry
      && iu.output_files.length > 0
      && iu.output_files.every(rel => {
        const fileManifest = entry.files[rel];
        if (!fileManifest) return false;
        const full = join(projectRoot, rel);
        if (!existsSync(full)) return false;
        return sha256(readFileSync(full, 'utf8')) === fileManifest.content_hash;
      });

    // A consumed provider contract that has since changed invalidates this module.
    const contractsCurrent = Object.entries(entry?.consumed_contracts ?? {})
      .every(([depId, recordedHash]) => currentHash.get(depId) === recordedHash);

    (filesMatch && contractsCurrent ? completed : pending).push(iu);
  }

  return { completed, pending };
}
