/**
 * Generated manifest — tracks every generated file for drift detection.
 */

export interface FileManifestEntry {
  path: string;
  content_hash: string;
  size: number;
}

export interface RegenMetadata {
  model_id: string;
  promptpack_hash: string;
  toolchain_version: string;
  generated_at: string;
  /**
   * True iff stub substitution replaced LLM output for this IU because the LLM
   * call threw. Absent (not `false`) when the LLM call succeeded or was never
   * attempted (forced-stub mode). Read this before trusting `model_id`: when
   * `fell_back` is true the named provider did NOT produce the file content.
   */
  fell_back?: boolean;
}

export interface IUManifest {
  iu_id: string;
  iu_name: string;
  files: Record<string, FileManifestEntry>;
  regen_metadata: RegenMetadata;
}

export interface GeneratedManifest {
  iu_manifests: Record<string, IUManifest>;
  generated_at: string;
}

export enum DriftStatus {
  /** File matches manifest hash */
  CLEAN = 'CLEAN',
  /** File differs from manifest, no waiver */
  DRIFTED = 'DRIFTED',
  /** File differs, waiver exists */
  WAIVED = 'WAIVED',
  /** Manifest entry but no file on disk */
  MISSING = 'MISSING',
  /** File on disk but not in manifest */
  UNTRACKED = 'UNTRACKED',
}

export interface DriftEntry {
  status: DriftStatus;
  file_path: string;
  iu_id?: string;
  expected_hash?: string;
  actual_hash?: string;
  waiver?: DriftWaiver;
}

export interface DriftWaiver {
  kind: 'promote_to_requirement' | 'waiver' | 'temporary_patch';
  reason: string;
  signed_by?: string;
  expires?: string;
}

export interface DriftReport {
  entries: DriftEntry[];
  clean_count: number;
  drifted_count: number;
  missing_count: number;
  summary: string;
}
