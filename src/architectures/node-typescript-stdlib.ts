/**
 * Runtime Target: node-typescript-stdlib
 *
 * Compiles web-api architecture to Node.js + TypeScript using the Node ≥22
 * stdlib `node:sqlite` driver instead of `better-sqlite3`. Same architecture,
 * same framework (Hono), same SQL — only the database driver differs.
 *
 * Why this exists: smallest defensible second runtime target for proving
 * Phoenix's durable/ephemeral split. The shared `db.ts` exports the same
 * `db` and `registerMigration` symbols, so module-level generated code is
 * indistinguishable from the `node-typescript` target. The driver swap is
 * confined to the shared file.
 */

import type { RuntimeTarget } from '../models/architecture.js';
import { nodeTypescript } from './node-typescript.js';

// ─── Shared db.ts using node:sqlite (stdlib, Node ≥22) ──────────────────────

const DB_FILE = `import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const DB_PATH = process.env.DB_PATH ?? 'data/app.db';

const dir = dirname(DB_PATH);
if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

const migrations: Array<{ name: string; sql: string }> = [];

export function registerMigration(name: string, sql: string): void {
  migrations.push({ name, sql });
}

export function runMigrations(): void {
  for (const m of migrations) {
    db.exec(m.sql);
  }
}

export { db };
`;

// ─── Export ─────────────────────────────────────────────────────────────────

// Reuse everything from node-typescript except packages and shared db.ts.
// The LLM-facing surface (moduleTemplate, promptExtension, codeExamples) is
// identical: generated modules import { db, registerMigration } from db.js
// and call db.prepare(sql).run() / .get() / .all() — APIs that node:sqlite
// shares with better-sqlite3.

const { ['better-sqlite3']: _drop1, ...packagesNoSqlite } = nodeTypescript.packages;
const { ['@types/better-sqlite3']: _drop2, ...devPackagesNoSqlite } = nodeTypescript.devPackages;

export const nodeTypescriptStdlib: RuntimeTarget = {
  name: 'node-typescript-stdlib',
  description: 'Node.js + TypeScript — Hono, node:sqlite (stdlib), Zod',
  language: 'typescript',

  packages: packagesNoSqlite,
  devPackages: devPackagesNoSqlite,

  moduleTemplate: nodeTypescript.moduleTemplate,
  promptExtension: nodeTypescript.promptExtension,
  codeExamples: nodeTypescript.codeExamples,

  // Same import surface as node-typescript (the shared db.ts exports the same
  // db/registerMigration), but the "do not bypass" hint references the
  // stdlib driver this target actually ships.
  mandatoryImports: `## MANDATORY: Your module MUST start with these exact imports
\`\`\`
import { Hono } from 'hono';
import { db, registerMigration } from '../../db.js';
import { z } from 'zod';
\`\`\`
Do NOT import DatabaseSync from node:sqlite. Do NOT instantiate a Database directly. Use the db import above.`,

  // Strip the runtime's actual driver (node:sqlite) instead of better-sqlite3.
  stripImportPatterns: ['hono', 'db.js', 'node:sqlite', 'zod'],

  sharedFiles: {
    ...nodeTypescript.sharedFiles,
    'src/db.ts': DB_FILE,
  },

  packageExtras: nodeTypescript.packageExtras,
};
