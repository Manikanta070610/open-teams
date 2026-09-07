// dashboard.js — Homepage data: my work + person profile view.
// GET /api/dashboard/work      — mine: open tasks, overdue, my projects, watching, recent updates.
// GET /api/dashboard/work/:id  — profile for :id: self OR shared-project head/lead OR HR/chief.
import { Router } from 'express';
import { requireAuth } from './auth.js';
import { pool } from './db.js';
import { getProjectMemberIds, getProjectRole, isChiefOrAdmin, isHr, isProjectHeadRole } from './staffing.js';

export const router = Router();
router.use(requireAuth);

async function workFor(employeeId) {
  const tasks = await pool.query(
    `SELECT t.*, p.name AS project_name FROM tasks t
       JOIN projects p ON p.id = t.project_id
      WHERE t.assigned_to = $1 AND t.status NOT IN ('done','cancelled')
      ORDER BY t.due_date NULLS LAST, t.id LIMIT 50`,
    [employeeId]
  );
  const overdue = tasks.rows.filter((t) => t.due_date && String(t.due_date) < new Date().toISOString().slice(0, 10));
  const projects = await pool.query(
    `SELECT p.*, d.name AS owning_department, m.role AS my_role FROM projects p
       JOIN project_members m ON m.project_id = p.id AND m.employee_id = $1
       JOIN departments d ON d.id = p.owning_department_id
      WHERE p.status IN ('planned','active','on_hold') ORDER BY p.id LIMIT 50`,
    [employeeId]
  );
  const watching = await pool.query(
    `SELECT t.*, p.name AS project_name FROM task_watchers w
       JOIN tasks t ON t.id = w.task_id JOIN projects p ON p.id = t.project_id
      WHERE w.employee_id = $1 AND t.status NOT IN ('done','cancelled') AND t.assigned_to <> $1
      ORDER BY t.id DESC LIMIT 20`,
    [employeeId]
  );
  const updates = await pool.query(
    `SELECT u.*, p.name AS project_name, e.first_name, e.last_name FROM project_updates u
       JOIN projects p ON p.id = u.project_id
       JOIN employees e ON e.id = u.author_id
      WHERE u.project_id IN (SELECT project_id FROM project_members WHERE employee_id = $1)
      ORDER BY u.id DESC LIMIT 10`,
    [employeeId]
  );
  const person = (await pool.query(
    `SELECT e.id, e.first_name, e.last_name, e.email, e.rank, d.name AS department
       FROM employees e JOIN departments d ON d.id = e.department_id WHERE e.id = $1`,
    [employeeId]
  )).rows[0] || null;
  return { person, open_tasks: tasks.rows, overdue_count: overdue.length, projects: projects.rows, watching: watching.rows, recent_updates: updates.rows };
}

async function sharesProjectWithHeadAccess(viewerId, targetId) {
  // Viewer is owner|lead of any project the target belongs to.
  const { rows } = await pool.query(
    `SELECT 1 FROM project_members mine JOIN project_members theirs
       ON mine.project_id = theirs.project_id
      WHERE mine.employee_id = $1 AND mine.role IN ('owner','lead') AND theirs.employee_id = $2 LIMIT 1`,
    [viewerId, targetId]
  );
  return rows.length > 0;
}

router.get('/work', async (req, res, next) => {
  try {
    return res.json(await workFor(req.user.id));
  } catch (err) { return next(err); }
});

router.get('/work/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'invalid id' });
    if (Number(id) !== Number(req.user.id)
      && !(await sharesProjectWithHeadAccess(req.user.id, id))
      && !isHr(req.user)) {
      return res.status(404).json({ error: 'not found' });
    }
    const target = await pool.query('SELECT id FROM employees WHERE id = $1 AND is_active = TRUE', [id]);
    if (target.rows.length === 0) return res.status(404).json({ error: 'not found' });
    return res.json(await workFor(id));
  } catch (err) { return next(err); }
});

export default router;
export { getProjectMemberIds, getProjectRole, isChiefOrAdmin, isProjectHeadRole };
