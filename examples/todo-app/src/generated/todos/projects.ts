import { Hono } from 'hono';
import { db, registerMigration } from '../../db.js';
import { z } from 'zod';

// ─── Database migrations ────────────────────────────────────────────────────

// ─── Database migrations ────────────────────────────────────────────────────

const router = new Hono();

registerMigration('projects', `
  CREATE TABLE IF NOT EXISTS projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    color TEXT NOT NULL DEFAULT '#6366f1',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

const CreateProjectSchema = z.object({
  name: z.string().min(1).max(200),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional().default('#6366f1'),
});

const UpdateProjectSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
});

router.get('/', (c) => {
  const projects = db.prepare(`
    SELECT
      projects.*,
      COUNT(CASE WHEN tasks.completed = 0 THEN 1 END) as active_task_count
    FROM projects
    LEFT JOIN tasks ON tasks.project_id = projects.id
    GROUP BY projects.id
    ORDER BY projects.created_at ASC
  `).all();
  return c.json(projects);
});

router.get('/:id', (c) => {
  const id = c.req.param('id');
  const project = db.prepare(`
    SELECT
      projects.*,
      COUNT(CASE WHEN tasks.completed = 0 THEN 1 END) as active_task_count
    FROM projects
    LEFT JOIN tasks ON tasks.project_id = projects.id
    WHERE projects.id = ?
    GROUP BY projects.id
  `).get(id);
  if (!project) return c.json({ error: 'Not found' }, 404);
  return c.json(project);
});

router.post('/', async (c) => {
  let body;
  try { body = await c.req.json(); } catch { return c.json({ error: 'Invalid JSON' }, 400); }
  const result = CreateProjectSchema.safeParse(body);
  if (!result.success) return c.json({ error: result.error.issues[0].message }, 400);
  const { name, color } = result.data;
  const info = db.prepare('INSERT INTO projects (name, color) VALUES (?, ?)').run(name, color);
  const project = db.prepare(`
    SELECT
      projects.*,
      COUNT(CASE WHEN tasks.completed = 0 THEN 1 END) as active_task_count
    FROM projects
    LEFT JOIN tasks ON tasks.project_id = projects.id
    WHERE projects.id = ?
    GROUP BY projects.id
  `).get(info.lastInsertRowid);
  return c.json(project, 201);
});

router.patch('/:id', async (c) => {
  const id = c.req.param('id');
  if (!db.prepare('SELECT id FROM projects WHERE id = ?').get(id)) return c.json({ error: 'Not found' }, 404);
  let body;
  try { body = await c.req.json(); } catch { return c.json({ error: 'Invalid JSON' }, 400); }
  const result = UpdateProjectSchema.safeParse(body);
  if (!result.success) return c.json({ error: result.error.issues[0].message }, 400);
  const u = result.data;
  if (u.name !== undefined) db.prepare('UPDATE projects SET name = ? WHERE id = ?').run(u.name, id);
  if (u.color !== undefined) db.prepare('UPDATE projects SET color = ? WHERE id = ?').run(u.color, id);
  const project = db.prepare(`
    SELECT
      projects.*,
      COUNT(CASE WHEN tasks.completed = 0 THEN 1 END) as active_task_count
    FROM projects
    LEFT JOIN tasks ON tasks.project_id = projects.id
    WHERE projects.id = ?
    GROUP BY projects.id
  `).get(id);
  return c.json(project);
});

router.delete('/:id', (c) => {
  const id = c.req.param('id');
  if (!db.prepare('SELECT id FROM projects WHERE id = ?').get(id)) return c.json({ error: 'Not found' }, 404);
  const taskCount = db.prepare('SELECT COUNT(*) as count FROM tasks WHERE project_id = ?').get(id) as { count: number };
  if (taskCount.count > 0) return c.json({ error: 'Cannot delete a project that contains tasks' }, 400);
  db.prepare('DELETE FROM projects WHERE id = ?').run(id);
  return c.body(null, 204);
});

/** @internal Phoenix VCS traceability — do not remove. */


export default router;

/** @internal Phoenix VCS traceability — do not remove. */
export const _phoenix = {
  iu_id: '999c90e3d85c6c3cec717725ac34b1a85112bf7f3220671339d4a8fbedc8bf4b',
  name: 'Projects',
  risk_tier: 'high',
  canon_ids: [6 as const],
} as const;
