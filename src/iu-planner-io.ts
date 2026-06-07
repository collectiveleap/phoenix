/**
 * Persistence for the IU plan (`.phoenix/graphs/ius.json`).
 *
 * Extracted so both the CLI and the supervised run (harness/run.ts) share one
 * implementation.
 */

import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { ImplementationUnit } from './models/iu.js';

export function loadIUs(phoenixDir: string): ImplementationUnit[] {
  const iuPath = join(phoenixDir, 'graphs', 'ius.json');
  if (!existsSync(iuPath)) return [];
  return JSON.parse(readFileSync(iuPath, 'utf8'));
}

export function saveIUs(phoenixDir: string, ius: ImplementationUnit[]): void {
  const dir = join(phoenixDir, 'graphs');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'ius.json'), JSON.stringify(ius, null, 2), 'utf8');
}
