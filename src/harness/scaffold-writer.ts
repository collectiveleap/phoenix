/**
 * Tracked scaffold writer (PRD O7 / appendix #6).
 *
 * The reference failure: the scaffold silently rewrote `tsconfig.json` /
 * `package.json` every run, wiping hand edits. This writer:
 *  - lists every file it writes / overwrites / leaves alone, and
 *  - detects hand-edited files (on-disk content differs from what Phoenix last
 *    wrote) and, by default, PRESERVES them rather than clobbering — reporting
 *    the decision instead of acting silently.
 *
 * Phoenix records the hash of each file it writes in `.phoenix/scaffold-
 * manifest.json` so it can tell "we wrote this" from "a human changed this".
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { sha256 } from '../semhash.js';

export type ScaffoldWriteStatus =
  | 'created'                 // file did not exist
  | 'unchanged'              // on-disk already equals the new content
  | 'updated'                // Phoenix owned it and the content changed
  | 'kept-hand-edited'       // on-disk differs from our last write — preserved
  | 'overwritten-hand-edited'; // hand-edited but overwrite was forced

export interface ScaffoldWriteEntry {
  path: string;
  status: ScaffoldWriteStatus;
}

export interface WriteScaffoldOptions {
  /** Overwrite hand-edited files instead of preserving them. */
  force?: boolean;
}

interface ScaffoldManifest {
  files: Record<string, string>; // relPath → last hash Phoenix wrote
}

function manifestPath(phoenixDir: string): string {
  return join(phoenixDir, 'scaffold-manifest.json');
}

function loadManifest(phoenixDir: string): ScaffoldManifest {
  const p = manifestPath(phoenixDir);
  if (!existsSync(p)) return { files: {} };
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as ScaffoldManifest;
  } catch {
    return { files: {} };
  }
}

function saveManifest(phoenixDir: string, manifest: ScaffoldManifest): void {
  mkdirSync(phoenixDir, { recursive: true });
  writeFileSync(manifestPath(phoenixDir), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
}

/**
 * Write scaffold files with hand-edit detection. Returns a per-file report;
 * never throws on a hand-edit — it preserves and reports unless `force`.
 */
export function writeScaffoldFiles(
  projectRoot: string,
  phoenixDir: string,
  files: Iterable<[string, string]>,
  opts?: WriteScaffoldOptions,
): ScaffoldWriteEntry[] {
  const manifest = loadManifest(phoenixDir);
  const report: ScaffoldWriteEntry[] = [];

  const write = (full: string, content: string) => {
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content, 'utf8');
  };

  for (const [rel, content] of files) {
    const full = join(projectRoot, rel);
    const newHash = sha256(content);

    if (!existsSync(full)) {
      write(full, content);
      manifest.files[rel] = newHash;
      report.push({ path: rel, status: 'created' });
      continue;
    }

    const onDiskHash = sha256(readFileSync(full, 'utf8'));
    if (onDiskHash === newHash) {
      manifest.files[rel] = newHash;
      report.push({ path: rel, status: 'unchanged' });
      continue;
    }

    const lastWritten = manifest.files[rel];
    // Hand-edited if the on-disk content differs from what we last wrote, OR
    // the file pre-exists with no record that Phoenix ever wrote it.
    const handEdited = lastWritten === undefined || onDiskHash !== lastWritten;

    if (handEdited && !opts?.force) {
      report.push({ path: rel, status: 'kept-hand-edited' });
      continue; // preserve — do NOT clobber, do NOT update the manifest
    }

    write(full, content);
    manifest.files[rel] = newHash;
    report.push({ path: rel, status: handEdited ? 'overwritten-hand-edited' : 'updated' });
  }

  saveManifest(phoenixDir, manifest);
  return report;
}

/** Every path Phoenix has written via the scaffold writer (manifest-tracked). */
export function listTrackedScaffoldFiles(phoenixDir: string): string[] {
  return Object.keys(loadManifest(phoenixDir).files);
}

/**
 * Delete scaffold-tracked files whose path is not in `keep`, dropping them from
 * the manifest. Returns the removed relative paths. Used to clean files a
 * previous run / architecture owned (e.g. a prior arch's `src/db.ts`) that the
 * current run no longer produces, so Phoenix owns its output tree (B5).
 */
export function pruneScaffoldFiles(projectRoot: string, phoenixDir: string, keep: Set<string>): string[] {
  const manifest = loadManifest(phoenixDir);
  const removed: string[] = [];
  for (const rel of Object.keys(manifest.files)) {
    if (keep.has(rel)) continue;
    const full = join(projectRoot, rel);
    if (existsSync(full)) rmSync(full, { force: true });
    delete manifest.files[rel];
    removed.push(rel);
  }
  if (removed.length > 0) saveManifest(phoenixDir, manifest);
  return removed;
}
