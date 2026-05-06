/**
 * Runtime Target: node-typescript
 *
 * Compiles web-api architecture to Node.js + TypeScript.
 * Stack: Hono (HTTP) + better-sqlite3 (DB) + Zod (validation)
 */

import type { RuntimeTarget, RouteWiring, ServiceDescriptor } from '../models/architecture.js';
import type { ImplementationUnit } from '../models/iu.js';

// ─── Module template (LLM fills in marked sections) ─────────────────────────

const MODULE_TEMPLATE = `import { Hono } from 'hono';
import { db, registerMigration } from '../../db.js';
import { z } from 'zod';

// ─── Database migrations ────────────────────────────────────────────────────
/* __MIGRATIONS__ */

// ─── Validation schemas ─────────────────────────────────────────────────────
/* __SCHEMAS__ */

// ─── Routes ─────────────────────────────────────────────────────────────────
const router = new Hono();

/* __ROUTES__ */

export default router;

/* __PHOENIX_METADATA__ */
`;

// ─── Shared files ───────────────────────────────────────────────────────────

const DB_FILE = `import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const DB_PATH = process.env.DB_PATH ?? 'data/app.db';

const dir = dirname(DB_PATH);
if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

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

const APP_FILE = `import { Hono } from 'hono';
import { logger } from 'hono/logger';
import { cors } from 'hono/cors';

const app = new Hono();

app.use('*', logger());
app.use('*', cors());

app.get('/health', (c) => c.json({ status: 'ok', uptime: process.uptime() }));

app.onError((err, c) => {
  console.error('Unhandled error:', err.message, err.stack);
  return c.json({ error: err.message }, 500);
});

export function mount(path: string, router: Hono): void {
  app.route(path, router);
}

export { app };
`;

// ─── Prompt extension ───────────────────────────────────────────────────────

const PROMPT_EXTENSION = `
## Runtime: Node.js + TypeScript (Hono + better-sqlite3 + Zod)

You are filling in sections of a module template. The imports, router, and exports are already provided.
You MUST output ONLY the content for the marked sections, in this exact format:

\`\`\`
__MIGRATIONS__
registerMigration('tablename', \`
  CREATE TABLE IF NOT EXISTS tablename (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ...columns...
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
\`);

__SCHEMAS__
const CreateSchema = z.object({ ... });
const UpdateSchema = z.object({ ... });

__ROUTES__
router.get('/', (c) => { ... });
router.post('/', async (c) => { ... });
router.get('/:id', (c) => { ... });
router.patch('/:id', async (c) => { ... });
router.delete('/:id', (c) => { ... });
\`\`\`

### Rules
- Use better-sqlite3 synchronous API: db.prepare(sql).run(), .get(), .all()
- Use parameterized queries ALWAYS — never interpolate user input into SQL
- In SQL, use single quotes for string literals: datetime('now'). NEVER double quotes.
- ALWAYS use snake_case for column names and JSON response keys
- Nullable FK fields: z.number().int().nullable().optional()
- FK validation: if (fk_id != null) { check exists } (loose equality)
- LEFT JOIN to include related resource names (e.g., project_name)
- Query parameter filtering: build WHERE clause dynamically from c.req.query()
- Return created/updated resource after mutation
- 200=read, 201=create, 204=delete, 400=validation, 404=not found

### Web interface modules
- Return c.html() with a complete HTML document
- Use fetch('/resource-name') to call sibling API modules (no /api/ prefix)
- Include ALL CSS and JavaScript inline
`;

// ─── Code examples ──────────────────────────────────────────────────────────

const CODE_EXAMPLES = `
## Example: CRUD module sections for a "notes" resource

\`\`\`
__MIGRATIONS__
registerMigration('notes', \`
  CREATE TABLE IF NOT EXISTS notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    body TEXT NOT NULL DEFAULT '',
    category_id INTEGER REFERENCES categories(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
\`);

__SCHEMAS__
const CreateNoteSchema = z.object({
  title: z.string().min(1).max(200),
  body: z.string().optional().default(''),
  category_id: z.number().int().nullable().optional(),
});

const UpdateNoteSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  body: z.string().optional(),
  category_id: z.number().int().nullable().optional(),
});

__ROUTES__
router.get('/', (c) => {
  let sql = 'SELECT notes.*, categories.name as category_name FROM notes LEFT JOIN categories ON notes.category_id = categories.id';
  const conditions: string[] = [];
  const params: unknown[] = [];
  const categoryId = c.req.query('category_id');
  if (categoryId !== undefined) { conditions.push('notes.category_id = ?'); params.push(Number(categoryId)); }
  if (conditions.length > 0) sql += ' WHERE ' + conditions.join(' AND ');
  sql += ' ORDER BY notes.created_at DESC';
  return c.json(db.prepare(sql).all(...params));
});

router.get('/:id', (c) => {
  const note = db.prepare('SELECT notes.*, categories.name as category_name FROM notes LEFT JOIN categories ON notes.category_id = categories.id WHERE notes.id = ?').get(c.req.param('id'));
  if (!note) return c.json({ error: 'Not found' }, 404);
  return c.json(note);
});

router.post('/', async (c) => {
  let body; try { body = await c.req.json(); } catch { return c.json({ error: 'Invalid JSON' }, 400); }
  const result = CreateNoteSchema.safeParse(body);
  if (!result.success) return c.json({ error: result.error.issues[0].message }, 400);
  const { title, body: noteBody, category_id } = result.data;
  if (category_id != null) {
    if (!db.prepare('SELECT id FROM categories WHERE id = ?').get(category_id)) return c.json({ error: 'Category not found' }, 400);
  }
  const info = db.prepare('INSERT INTO notes (title, body, category_id) VALUES (?, ?, ?)').run(title, noteBody, category_id ?? null);
  const note = db.prepare('SELECT notes.*, categories.name as category_name FROM notes LEFT JOIN categories ON notes.category_id = categories.id WHERE notes.id = ?').get(info.lastInsertRowid);
  return c.json(note, 201);
});

router.patch('/:id', async (c) => {
  const id = c.req.param('id');
  if (!db.prepare('SELECT id FROM notes WHERE id = ?').get(id)) return c.json({ error: 'Not found' }, 404);
  let body; try { body = await c.req.json(); } catch { return c.json({ error: 'Invalid JSON' }, 400); }
  const result = UpdateNoteSchema.safeParse(body);
  if (!result.success) return c.json({ error: result.error.issues[0].message }, 400);
  const u = result.data;
  if (u.title !== undefined) db.prepare('UPDATE notes SET title = ? WHERE id = ?').run(u.title, id);
  if (u.body !== undefined) db.prepare('UPDATE notes SET body = ? WHERE id = ?').run(u.body, id);
  if (u.category_id !== undefined) db.prepare('UPDATE notes SET category_id = ? WHERE id = ?').run(u.category_id, id);
  return c.json(db.prepare('SELECT notes.*, categories.name as category_name FROM notes LEFT JOIN categories ON notes.category_id = categories.id WHERE notes.id = ?').get(id));
});

router.delete('/:id', (c) => {
  const id = c.req.param('id');
  if (!db.prepare('SELECT id FROM notes WHERE id = ?').get(id)) return c.json({ error: 'Not found' }, 404);
  db.prepare('DELETE FROM notes WHERE id = ?').run(id);
  return c.body(null, 204);
});
\`\`\`
`;

// ─── Server entry generator ─────────────────────────────────────────────────

/**
 * Build src/server.ts for a Hono + @hono/node-server target. Both
 * node-typescript and node-typescript-stdlib reuse this — they share the
 * server pattern; only the SQLite driver in src/db.ts differs between them.
 */
function generateHonoServerEntry(routes: RouteWiring[]): string {
  const routeImports = routes.map(r => `import ${r.importName} from '${r.importPath}';`);
  const routeMounts = routes.map(r => `mount('${r.mountPath}', ${r.importName});`);
  return [
    `import { serve } from '@hono/node-server';`,
    `import { app, mount } from './app.js';`,
    `import { runMigrations } from './db.js';`,
    ``,
    `// Generated route modules`,
    ...routeImports,
    ``,
    `// Mount routes`,
    ...routeMounts,
    ``,
    `// JSON 404 fallback — keeps unknown-route responses consistent`,
    `// across runtime targets (instead of Hono's text/plain default).`,
    `app.notFound((c) => c.json({ error: 'Not Found' }, 404));`,
    ``,
    `const port = parseInt(process.env.PORT ?? '3000', 10);`,
    `runMigrations();`,
    `console.log(\`Server running at http://localhost:\${port}\`);`,
    `serve({ fetch: app.fetch, port });`,
    ``,
  ].join('\n');
}

// ─── Module stub & test scaffold ────────────────────────────────────────────

/**
 * Stub module body emitted when no LLM is available. Produces a valid Hono
 * router that responds with a "not implemented" placeholder. Both Hono
 * targets share this implementation.
 */
function generateHonoModuleStub(iu: ImplementationUnit): string {
  return `import { Hono } from 'hono';

const router = new Hono();

router.get('/', (c) => c.json({ stub: true, module: '${iu.name}', message: 'Not yet implemented' }));

export default router;

/** @internal Phoenix VCS traceability — do not remove. */
export const _phoenix = {
  iu_id: '${iu.iu_id}',
  name: '${iu.name}',
  risk_tier: '${iu.risk_tier}',
  canon_ids: [${iu.source_canon_ids.length} as const],
} as const;
`;
}

/**
 * Per-service vitest file. The assertion `typeof router.fetch === 'function'`
 * is Hono-specific (Hono's app exposes a fetch handler).
 */
function generateHonoServiceTests(svc: ServiceDescriptor): string {
  const lines: string[] = [];
  lines.push(`/**`);
  lines.push(` * ${svc.name} — Generated Tests`);
  lines.push(` * AUTO-GENERATED by Phoenix VCS`);
  lines.push(` */`);
  lines.push(``);
  lines.push(`import { describe, it, expect } from 'vitest';`);

  for (const mod of svc.modules) {
    const importName = mod.replace('.ts', '').replace(/-/g, '_');
    lines.push(`import ${importName} from '../${mod.replace('.ts', '.js')}';`);
  }

  lines.push(``);
  lines.push(`describe('${svc.name} modules', () => {`);

  for (const mod of svc.modules) {
    const importName = mod.replace('.ts', '').replace(/-/g, '_');
    const displayName = mod.replace('.ts', '').replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    lines.push(`  describe('${displayName}', () => {`);
    lines.push(`    it('exports a Hono router as default', () => {`);
    lines.push(`      expect(${importName}).toBeDefined();`);
    lines.push(`      expect(typeof ${importName}.fetch).toBe('function');`);
    lines.push(`    });`);
    lines.push(`  });`);
  }

  lines.push(`});`);
  lines.push(``);
  return lines.join('\n');
}

// ─── Project-files factory (shared across all Node-TS runtime variants) ────

/**
 * Build a `generateProjectFiles` implementation for a Node + TypeScript
 * runtime target. Returns a function that produces the same shape of
 * package.json / tsconfig.json / vitest.config.ts that scaffold.ts used
 * to emit inline — just parameterized by the runtime's own dep set.
 *
 * Reused by the Hono target, the stdlib variant, and the Express target;
 * each passes its own packages/devPackages/packageExtras.
 */
export function makeNodeTsProjectFiles(
  packages: Record<string, string>,
  devPackages: Record<string, string>,
  packageExtras: Record<string, unknown>,
): RuntimeTarget['generateProjectFiles'] {
  return (projectName, services) => {
    const files = new Map<string, string>();

    const archScripts = (packageExtras?.scripts ?? {}) as Record<string, string>;
    const pkg = {
      name: projectName,
      version: '0.1.0',
      description: `Generated by Phoenix VCS — ${services.length} services`,
      type: 'module',
      scripts: {
        build: 'tsc',
        typecheck: 'tsc --noEmit',
        test: 'vitest run',
        'test:watch': 'vitest',
        ...archScripts,
      },
      dependencies: packages,
      devDependencies: devPackages,
    };
    files.set('package.json', JSON.stringify(pkg, null, 2) + '\n');

    const tsconfig = {
      compilerOptions: {
        target: 'ES2022',
        module: 'ESNext',
        moduleResolution: 'bundler',
        declaration: true,
        outDir: 'dist',
        rootDir: 'src',
        strict: true,
        esModuleInterop: true,
        skipLibCheck: true,
        forceConsistentCasingInFileNames: true,
        resolveJsonModule: true,
        sourceMap: true,
      },
      include: ['src/**/*'],
      exclude: ['node_modules', 'dist'],
    };
    files.set('tsconfig.json', JSON.stringify(tsconfig, null, 2) + '\n');

    files.set('vitest.config.ts', `import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/__tests__/**/*.test.ts'],
  },
});
`);

    return files;
  };
}

// ─── Export ─────────────────────────────────────────────────────────────────

const NODE_TS_PACKAGES = {
  'hono': '^4.6.0',
  '@hono/node-server': '^1.13.0',
  'better-sqlite3': '^11.7.0',
  'zod': '^3.24.0',
};

const NODE_TS_DEV_PACKAGES = {
  'typescript': '^5.4.0',
  'vitest': '^2.0.0',
  '@types/node': '^22.0.0',
  '@types/better-sqlite3': '^7.6.0',
  'tsx': '^4.0.0',
};

const NODE_TS_PACKAGE_EXTRAS = {
  scripts: {
    dev: 'tsx watch src/server.ts',
    start: 'tsx src/server.ts',
    build: 'tsc',
    test: 'vitest run',
  },
};

export const nodeTypescript: RuntimeTarget = {
  name: 'node-typescript',
  description: 'Node.js + TypeScript — Hono, better-sqlite3, Zod',
  language: 'typescript',

  packages: NODE_TS_PACKAGES,
  devPackages: NODE_TS_DEV_PACKAGES,

  moduleTemplate: MODULE_TEMPLATE,
  promptExtension: PROMPT_EXTENSION,
  codeExamples: CODE_EXAMPLES,

  mandatoryImports: `## MANDATORY: Your module MUST start with these exact imports
\`\`\`
import { Hono } from 'hono';
import { db, registerMigration } from '../../db.js';
import { z } from 'zod';
\`\`\`
Do NOT import Database from better-sqlite3. Do NOT create new Database(). Use the db import above.`,

  stripImportPatterns: ['hono', 'db.js', 'better-sqlite3', 'zod'],
  generateServerEntry: generateHonoServerEntry,
  generateModuleStub: generateHonoModuleStub,
  generateServiceTests: generateHonoServiceTests,
  generateProjectFiles: makeNodeTsProjectFiles(NODE_TS_PACKAGES, NODE_TS_DEV_PACKAGES, NODE_TS_PACKAGE_EXTRAS),

  sharedFiles: {
    'src/db.ts': DB_FILE,
    'src/app.ts': APP_FILE,
  },

  packageExtras: NODE_TS_PACKAGE_EXTRAS,
};
