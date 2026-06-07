/**
 * Generated Manifest manager — tracks generated files for drift detection.
 */

import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { GeneratedManifest, IUManifest } from './models/manifest.js';

export class ManifestManager {
  private manifestPath: string;

  constructor(phoenixRoot: string) {
    const dir = join(phoenixRoot, 'manifests');
    mkdirSync(dir, { recursive: true });
    this.manifestPath = join(dir, 'generated_manifest.json');
  }

  load(): GeneratedManifest {
    if (!existsSync(this.manifestPath)) {
      return { iu_manifests: {}, generated_at: '' };
    }
    return JSON.parse(readFileSync(this.manifestPath, 'utf8'));
  }

  save(manifest: GeneratedManifest): void {
    writeFileSync(this.manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
  }

  /**
   * Record a single IU's generated files into the manifest.
   * Evicts stale entries: if another IU previously owned the same
   * output file paths, the old entry is removed (handles IU ID changes
   * after re-canonicalization).
   */
  recordIU(iuManifest: IUManifest): void {
    const manifest = this.load();
    this.evictStaleEntries(manifest, iuManifest);
    manifest.iu_manifests[iuManifest.iu_id] = iuManifest;
    manifest.generated_at = new Date().toISOString();
    this.save(manifest);
  }

  /**
   * Record multiple IU manifests at once.
   */
  recordAll(iuManifests: IUManifest[]): void {
    const manifest = this.load();
    for (const m of iuManifests) {
      this.evictStaleEntries(manifest, m);
      manifest.iu_manifests[m.iu_id] = m;
    }
    manifest.generated_at = new Date().toISOString();
    this.save(manifest);
  }

  /**
   * Remove old IU manifest entries that own the same file paths
   * as a new entry (but with a different IU ID).
   */
  private evictStaleEntries(manifest: GeneratedManifest, incoming: IUManifest): void {
    const incomingFiles = new Set(Object.keys(incoming.files));
    for (const [existingId, existing] of Object.entries(manifest.iu_manifests)) {
      if (existingId === incoming.iu_id) continue;
      const existingFiles = Object.keys(existing.files);
      const overlaps = existingFiles.some(f => incomingFiles.has(f));
      if (overlaps) {
        delete manifest.iu_manifests[existingId];
      }
    }
  }

  /**
   * Get manifest for a specific IU.
   */
  getIUManifest(iuId: string): IUManifest | null {
    const manifest = this.load();
    return manifest.iu_manifests[iuId] ?? null;
  }

  /**
   * Get all tracked file paths across all IUs.
   */
  getAllTrackedFiles(): string[] {
    const manifest = this.load();
    const files: string[] = [];
    for (const iuManifest of Object.values(manifest.iu_manifests)) {
      files.push(...Object.keys(iuManifest.files));
    }
    return files;
  }

  /**
   * Drop tracked file records whose path is not in `keep`, returning the removed
   * paths so the caller can delete them from disk. Lets a regenerate-from-scratch
   * run clean modules a previous plan/architecture produced but the current plan
   * no longer does (B5). Does not touch files the current plan still owns.
   */
  pruneToPaths(keep: Set<string>): string[] {
    const manifest = this.load();
    const removed: string[] = [];
    for (const [id, iu] of Object.entries(manifest.iu_manifests)) {
      const files = Object.keys(iu.files);
      const stale = files.filter(f => !keep.has(f));
      if (stale.length === 0) continue;
      for (const f of stale) {
        delete iu.files[f];
        removed.push(f);
      }
      if (Object.keys(iu.files).length === 0) {
        delete manifest.iu_manifests[id];
      }
    }
    if (removed.length > 0) this.save(manifest);
    return removed;
  }
}
