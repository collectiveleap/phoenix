import { Hono } from 'hono';
import { db, registerMigration } from '../../db.js';
import { z } from 'zod';

// ─── Database migrations ────────────────────────────────────────────────────

// ─── Database migrations ────────────────────────────────────────────────────

// ─── Database migrations ────────────────────────────────────────────────────

const router = new Hono();

registerMigration('tasks', `
  CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    priority TEXT NOT NULL DEFAULT 'normal',
    due_date TEXT,
    completed INTEGER NOT NULL DEFAULT 0,
    project_id INTEGER REFERENCES projects(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

const PRIORITIES = ['urgent', 'high', 'normal', 'low'] as const;

const isValidDate = (s: string) => !isNaN(Date.parse(s));

const CreateTaskSchema = z.object({
  title: z.string().min(1, 'Title is required').max(500, 'Title must not exceed 500 characters'),
  description: z.string().max(5000, 'Description must not exceed 5000 characters').optional().default(''),
  priority: z.enum(PRIORITIES).default('normal'),
  due_date: z.string().nullable().optional().refine(v => v == null || isValidDate(v), { message: 'Invalid date' }),
  project_id: z.number().int().nullable().optional(),
  completed: z.boolean().optional().default(false),
});

const UpdateTaskSchema = z.object({
  title: z.string().min(1, 'Title is required').max(500, 'Title must not exceed 500 characters').optional(),
  description: z.string().max(5000, 'Description must not exceed 5000 characters').optional(),
  priority: z.enum(PRIORITIES).optional(),
  due_date: z.string().nullable().optional().refine(v => v == null || isValidDate(v), { message: 'Invalid date' }),
  project_id: z.number().int().nullable().optional(),
  completed: z.boolean().optional(),
});

router.get('/stats', (c) => {
  const today = new Date().toISOString().slice(0, 10);
  const total = (db.prepare('SELECT COUNT(*) as count FROM tasks').get() as any).count as number;
  const completed = (db.prepare('SELECT COUNT(*) as count FROM tasks WHERE completed = 1').get() as any).count as number;
  const overdue = (db.prepare(
    "SELECT COUNT(*) as count FROM tasks WHERE completed = 0 AND due_date IS NOT NULL AND due_date < ?"
  ).get(today) as any).count as number;
  const completion_percentage = total > 0 ? Math.round((completed / total) * 100) : 0;
  return c.json({ total, completed, overdue, completion_percentage });
});

router.get('/', (c) => {
  const conditions: string[] = [];
  const params: unknown[] = [];

  const status = c.req.query('status');
  if (status === 'active') { conditions.push('tasks.completed = 0'); }
  else if (status === 'completed') { conditions.push('tasks.completed = 1'); }

  const projectId = c.req.query('project_id');
  if (projectId !== undefined) { conditions.push('tasks.project_id = ?'); params.push(Number(projectId)); }

  const priority = c.req.query('priority');
  if (priority !== undefined) { conditions.push('tasks.priority = ?'); params.push(priority); }

  let sql = 'SELECT tasks.*, projects.name as project_name FROM tasks LEFT JOIN projects ON tasks.project_id = projects.id';
  if (conditions.length > 0) sql += ' WHERE ' + conditions.join(' AND ');
  sql += `
    ORDER BY
      CASE WHEN tasks.completed = 0 AND tasks.due_date IS NOT NULL AND tasks.due_date < date('now') THEN 0 ELSE 1 END ASC,
      CASE tasks.priority WHEN 'urgent' THEN 1 WHEN 'high' THEN 2 WHEN 'normal' THEN 3 WHEN 'low' THEN 4 END ASC,
      tasks.created_at ASC`;

  const rows = db.prepare(sql).all(...params) as any[];
  return c.json(rows.map(r => ({ ...r, completed: r.completed === 1 })));
});

router.get('/:id', (c) => {
  const row = db.prepare(
    'SELECT tasks.*, projects.name as project_name FROM tasks LEFT JOIN projects ON tasks.project_id = projects.id WHERE tasks.id = ?'
  ).get(c.req.param('id')) as any;
  if (!row) return c.json({ error: 'Not found' }, 404);
  return c.json({ ...row, completed: row.completed === 1 });
});

router.post('/', async (c) => {
  let body; try { body = await c.req.json(); } catch { return c.json({ error: 'Invalid JSON' }, 400); }
  const result = CreateTaskSchema.safeParse(body);
  if (!result.success) return c.json({ error: result.error.issues[0].message }, 400);
  const { title, description, priority, due_date, project_id, completed } = result.data;
  if (project_id != null) {
    if (!db.prepare('SELECT id FROM projects WHERE id = ?').get(project_id)) return c.json({ error: 'Project not found' }, 400);
  }
  const info = db.prepare(
    'INSERT INTO tasks (title, description, priority, due_date, project_id, completed) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(title, description, priority, due_date ?? null, project_id ?? null, completed ? 1 : 0);
  const row = db.prepare(
    'SELECT tasks.*, projects.name as project_name FROM tasks LEFT JOIN projects ON tasks.project_id = projects.id WHERE tasks.id = ?'
  ).get(info.lastInsertRowid) as any;
  return c.json({ ...row, completed: row.completed === 1 }, 201);
});

router.patch('/:id', async (c) => {
  const id = c.req.param('id');
  if (!db.prepare('SELECT id FROM tasks WHERE id = ?').get(id)) return c.json({ error: 'Not found' }, 404);
  let body; try { body = await c.req.json(); } catch { return c.json({ error: 'Invalid JSON' }, 400); }
  const result = UpdateTaskSchema.safeParse(body);
  if (!result.success) return c.json({ error: result.error.issues[0].message }, 400);
  const u = result.data;
  if (u.project_id != null) {
    if (!db.prepare('SELECT id FROM projects WHERE id = ?').get(u.project_id)) return c.json({ error: 'Project not found' }, 400);
  }
  if (u.title !== undefined) db.prepare('UPDATE tasks SET title = ? WHERE id = ?').run(u.title, id);
  if (u.description !== undefined) db.prepare('UPDATE tasks SET description = ? WHERE id = ?').run(u.description, id);
  if (u.priority !== undefined) db.prepare('UPDATE tasks SET priority = ? WHERE id = ?').run(u.priority, id);
  if ('due_date' in u) db.prepare('UPDATE tasks SET due_date = ? WHERE id = ?').run(u.due_date ?? null, id);
  if ('project_id' in u) db.prepare('UPDATE tasks SET project_id = ? WHERE id = ?').run(u.project_id ?? null, id);
  if (u.completed !== undefined) db.prepare('UPDATE tasks SET completed = ? WHERE id = ?').run(u.completed ? 1 : 0, id);
  const row = db.prepare(
    'SELECT tasks.*, projects.name as project_name FROM tasks LEFT JOIN projects ON tasks.project_id = projects.id WHERE tasks.id = ?'
  ).get(id) as any;
  return c.json({ ...row, completed: row.completed === 1 });
});

router.delete('/:id', (c) => {
  const id = c.req.param('id');
  if (!db.prepare('SELECT id FROM tasks WHERE id = ?').get(id)) return c.json({ error: 'Not found' }, 404);
  db.prepare('DELETE FROM tasks WHERE id = ?').run(id);
  return c.body(null, 204);
});

/** @internal Phoenix VCS traceability — do not remove. */


/** @internal Phoenix VCS traceability — do not remove. */


export default router;

/** @internal Phoenix VCS traceability — do not remove. */
export const _phoenix = {
  iu_id: 'b9750869e2d99d4ece62e819b457ae999fea151a5e8e78543e89e212832e06ec',
  name: 'Tasks',
  risk_tier: 'high',
  canon_ids: [14 as const],
} as const;
