// projects.js — Standalone projects: charter, lifecycle guardrails, direct staffing
// by heads, task assignment (owner/lead), subtasks, comments, updates, audit log.
// Mounted at /api/projects (and alias /projects for spec compat).
import { Router } from 'express';
import { requireAuth } from './auth.js';
import { pool } from './db.js';
import { rateLimited } from './ratelimit.js';
import {
  findProjectCandidates,
  getProjectMemberIds,
  getProjectRole,
  isChiefOrAdmin,
  isHr,
  isProjectHeadRole,
  isWorkspaceHead,
} from './staffing.js';

export const router = Router();
router.use(requireAuth);

const WRITE_MAX = 30;
const WRITE_WINDOW_MS = 60_000;

const PROJ_STATUS = new Set(['planned', 'active', 'on_hold', 'completed', 'cancelled']);
const PROJ_ROLES = new Set(['owner', 'lead', 'member', 'viewer', 'sponsor']);
const TASK_STATUS = new Set(['todo', 'in_progress', 'in_review', 'done', 'blocked', 'cancelled']);
const PRIORITY = new Set(['low', 'medium', 'high', 'urgent']);
const ESTIMATE = new Set(['XS', 'S', 'M', 'L', 'XL']);

async function projectRow(id) {
  const { rows } = await pool.query(
    `SELECT p.*, d.name AS owning_department,
            (SELECT COUNT(*)::int FROM tasks t WHERE t.project_id = p.id AND t.status NOT IN ('done','cancelled')) AS open_tasks
       FROM projects p JOIN departments d ON d.id = p.owning_department_id
      WHERE p.id = $1`,
    [id]
  );
  return rows[0] || null;
}

async function projectDetail(id) {
  const p = await projectRow(id);
  if (!p) return null;
  const members = await pool.query(
    `SELECT m.project_id, m.employee_id, m.role, m.allocation_pct, m.is_primary, m.joined_at,
            e.first_name, e.last_name, e.email, e.rank, d.name AS department
       FROM project_members m
       JOIN employees e ON e.id = m.employee_id
       JOIN departments d ON d.id = e.department_id
      WHERE m.project_id = $1 ORDER BY
        CASE m.role WHEN 'owner' THEN 0 WHEN 'lead' THEN 1 ELSE 2 END, m.joined_at`,
    [id]
  );
  const tasks = await pool.query(
    `SELECT t.*, e.first_name AS assignee_first, e.last_name AS assignee_last,
            (SELECT COUNT(*)::int FROM task_comments c WHERE c.task_id = t.id AND c.is_deleted = FALSE) AS comment_count,
            (SELECT COUNT(*)::int FROM tasks s WHERE s.parent_task_id = t.id) AS subtask_count
       FROM tasks t JOIN employees e ON e.id = t.assigned_to
      WHERE t.project_id = $1 ORDER BY t.id`,
    [id]
  );
  const updates = await pool.query(
    `SELECT u.*, e.first_name, e.last_name FROM project_updates u
       JOIN employees e ON e.id = u.author_id
      WHERE u.project_id = $1 ORDER BY u.id DESC LIMIT 10`,
    [id]
  );
  return { ...p, members: members.rows, tasks: tasks.rows, updates: updates.rows };
}

async function logActivity(projectId, taskId, actorId, action, detail = {}) {
  await pool.query(
    `INSERT INTO project_activity_log (project_id, task_id, actor_id, action, detail)
     VALUES ($1, $2, $3, $4, $5)`,
    [projectId, taskId, actorId, action, detail]
  );
}

async function rankOf(employeeId) {
  const { rows } = await pool.query('SELECT rank FROM employees WHERE id = $1', [employeeId]);
  return rows[0]?.rank ?? null;
}

// Creator rule: chief (rank>=5/admin) anywhere; manager (rank 4) own-dept only;
// workspace head (owner|lead of any workspace) anywhere — any rank.
async function canCreateProject(user, owningDeptId) {
  if (isChiefOrAdmin(user)) return true;
  if (Number(user.rank) === 4) {
    const { rows } = await pool.query('SELECT department_id FROM employees WHERE id = $1', [user.id]);
    if (rows[0] && Number(rows[0].department_id) === Number(owningDeptId)) return true;
  }
  if (await isWorkspaceHead(user.id)) return true;
  return false;
}

// --- POST / — create standalone project, creator becomes owner (DRI) ---
router.post('/', async (req, res, next) => {
  try {
    if (rateLimited('prj-create', req.ip, WRITE_MAX, WRITE_WINDOW_MS)) {
      return res.status(429).json({ error: 'too many attempts, try later' });
    }
    const name = String(req.body?.name || '').trim();
    const owningDeptId = Number(req.body?.owning_department_id);
    const description = req.body?.description ? String(req.body.description).slice(0, 2000) : null;
    const objective = req.body?.objective ? String(req.body.objective).slice(0, 2000) : null;
    const sponsorId = req.body?.sponsor_id ? Number(req.body.sponsor_id) : null;
    const status = req.body?.status ? String(req.body.status) : 'planned';
    const { start_date: startDate, end_date: endDate } = req.body || {};
    if (!name) return res.status(400).json({ error: 'name is required' });
    if (!Number.isInteger(owningDeptId)) return res.status(400).json({ error: 'owning_department_id is required' });
    if (!PROJ_STATUS.has(status)) return res.status(400).json({ error: 'invalid status' });
    if (startDate && endDate && String(endDate) < String(startDate)) {
      return res.status(400).json({ error: 'end_date must be >= start_date' });
    }
    const dept = await pool.query('SELECT id FROM departments WHERE id = $1', [owningDeptId]);
    if (dept.rows.length === 0) return res.status(400).json({ error: 'unknown department' });
    if (sponsorId) {
      const s = await pool.query('SELECT id FROM employees WHERE id = $1 AND is_active = TRUE', [sponsorId]);
      if (s.rows.length === 0) return res.status(400).json({ error: 'unknown sponsor' });
    }
    if (!(await canCreateProject(req.user, owningDeptId))) {
      return res.status(403).json({ error: 'managers (own dept), workspace heads, or chiefs can create projects' });
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(
        `INSERT INTO projects (name, owning_department_id, description, objective, sponsor_id, status, created_by, start_date, end_date)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
        [name, owningDeptId, description, objective, sponsorId, status, req.user.id, startDate || null, endDate || null]
      );
      const pid = rows[0].id;
      await client.query(
        `INSERT INTO project_members (project_id, employee_id, role, allocation_pct, is_primary)
         VALUES ($1,$2,'owner',100,TRUE) ON CONFLICT DO NOTHING`,
        [pid, req.user.id]
      );
      await client.query(
        `INSERT INTO project_activity_log (project_id, actor_id, action, detail) VALUES ($1,$2,'project.created',$3)`,
        [pid, req.user.id, { name }]
      );
      await client.query('COMMIT');
      return res.status(201).json(await projectDetail(pid));
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch { /* closed */ }
      throw err;
    } finally {
      client.release();
    }
  } catch (err) { return next(err); }
});

// --- GET / — my projects ---
router.get('/', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT p.*, d.name AS owning_department, m.role AS my_role, m.allocation_pct AS my_allocation
         FROM projects p
         JOIN project_members m ON m.project_id = p.id AND m.employee_id = $1
         JOIN departments d ON d.id = p.owning_department_id
        ORDER BY p.id`,
      [req.user.id]
    );
    return res.json(rows);
  } catch (err) { return next(err); }
});

// --- GET /departments — owning-dept select for the create form (any member) ---
router.get('/departments', async (_req, res, next) => {
  try {
    const { rows } = await pool.query('SELECT id, name FROM departments ORDER BY name');
    return res.json(rows);
  } catch (err) { return next(err); }
});

// --- GET /candidates — workload-enriched picker (must precede /:id) ---
router.get('/candidates', async (req, res, next) => {
  try {
    const ranks = String(req.query.ranks || '').split(',').map((s) => s.trim()).filter(Boolean).map(Number)
      .filter((r) => Number.isInteger(r) && r >= 1 && r <= 6);
    const departmentIds = String(req.query.departments || '').split(',').map((s) => s.trim()).filter(Boolean).map(Number)
      .filter(Number.isInteger);
    const q = String(req.query.q || '').slice(0, 80);
    const excludeProject = req.query.exclude_members_of ? Number(req.query.exclude_members_of) : null;
    const excludeIds = Number.isInteger(excludeProject) ? await getProjectMemberIds(excludeProject) : [];
    return res.json(await findProjectCandidates({ ranks, departmentIds, q, excludeIds }));
  } catch (err) { return next(err); }
});

// --- GET /:id — detail for members, or HR/chief (auditors) ---
router.get('/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'invalid id' });
    const p = await projectRow(id);
    if (!p) return res.status(404).json({ error: 'not found' });
    const role = await getProjectRole(id, req.user.id);
    if (!role && !isHr(req.user)) return res.status(404).json({ error: 'not found' });
    const detail = await projectDetail(id);
    detail.my_role = role;
    return res.json(detail);
  } catch (err) { return next(err); }
});

// --- PATCH /:id — edit charter / lifecycle (heads only; guardrails, no WIP caps) ---
router.patch('/:id', async (req, res, next) => {
  try {
    if (rateLimited('prj-edit', req.ip, WRITE_MAX, WRITE_WINDOW_MS)) {
      return res.status(429).json({ error: 'too many attempts, try later' });
    }
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'invalid id' });
    const role = await getProjectRole(id, req.user.id);
    const head = isProjectHeadRole(role) || isChiefOrAdmin(req.user);
    if (!head) return res.status(403).json({ error: 'project heads only' });
    const p = await projectRow(id);
    if (!p) return res.status(404).json({ error: 'not found' });
    const patch = {};
    for (const k of ['description', 'objective', 'cancelled_reason']) {
      if (req.body?.[k] !== undefined) patch[k] = req.body[k] ? String(req.body[k]).slice(0, 2000) : null;
    }
    if (req.body?.name !== undefined) {
      const n = String(req.body.name).trim();
      if (!n) return res.status(400).json({ error: 'name is required' });
      patch.name = n;
    }
    if (req.body?.status !== undefined) {
      const s = String(req.body.status);
      if (!PROJ_STATUS.has(s)) return res.status(400).json({ error: 'invalid status' });
      if ((s === 'completed' || s === 'cancelled') && p.open_tasks > 0 && p.status !== s) {
        return res.status(409).json({ error: `close all ${p.open_tasks} open tasks first` });
      }
      patch.status = s;
      if (s === 'completed') patch.completed_at = new Date().toISOString();
      if (s === 'cancelled' && !patch.cancelled_reason && !p.cancelled_reason && !req.body?.cancelled_reason) {
        return res.status(400).json({ error: 'cancelled_reason is required' });
      }
    }
    if (req.body?.sponsor_id !== undefined) {
      const sid = req.body.sponsor_id ? Number(req.body.sponsor_id) : null;
      if (sid) {
        const s = await pool.query('SELECT id FROM employees WHERE id = $1 AND is_active = TRUE', [sid]);
        if (s.rows.length === 0) return res.status(400).json({ error: 'unknown sponsor' });
      }
      patch.sponsor_id = sid;
    }
    if (Object.keys(patch).length === 0) return res.status(400).json({ error: 'nothing to update' });
    const cols = Object.keys(patch);
    const vals = Object.values(patch);
    await pool.query(`UPDATE projects SET ${cols.map((c, i) => `${c} = $${i + 2}`).join(', ')} WHERE id = $1`, [id, ...vals]);
    await logActivity(id, null, req.user.id, 'project.status', patch);
    return res.json(await projectDetail(id));
  } catch (err) { return next(err); }
});

// --- POST /:id/members — direct add by heads (single/multi-dept) ---
router.post('/:id/members', async (req, res, next) => {
  try {
    if (rateLimited('prj-staff', req.ip, WRITE_MAX, WRITE_WINDOW_MS)) {
      return res.status(429).json({ error: 'too many attempts, try later' });
    }
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'invalid id' });
    const p = await projectRow(id);
    if (!p) return res.status(404).json({ error: 'not found' });
    const role = await getProjectRole(id, req.user.id);
    if (!isProjectHeadRole(role) && !isChiefOrAdmin(req.user)) {
      return res.status(403).json({ error: 'project heads only' });
    }
    const list = Array.isArray(req.body?.members) ? req.body.members : null;
    if (!list || list.length === 0 || list.length > 50) {
      return res.status(400).json({ error: 'members[] must have 1-50 entries' });
    }
    const existing = new Set(await getProjectMemberIds(id));
    const toAdd = [];
    for (const m of list) {
      const employeeId = Number(m?.employee_id);
      const r = String(m?.role || 'member');
      const allocation = Number(m?.allocation_pct ?? 100);
      if (!Number.isInteger(employeeId)) return res.status(400).json({ error: 'invalid employee_id' });
      if (!PROJ_ROLES.has(r)) return res.status(400).json({ error: 'invalid role' });
      if (!Number.isInteger(allocation) || allocation < 1 || allocation > 100) {
        return res.status(400).json({ error: 'allocation_pct must be 1-100' });
      }
      if (existing.has(employeeId)) return res.status(409).json({ error: `employee ${employeeId} already in project` });
      toAdd.push({ employeeId, role: r, allocation, primary: m?.is_primary !== false });
    }
    const { rows: found } = await pool.query(
      'SELECT id FROM employees WHERE id = ANY($1::bigint[]) AND is_active = TRUE',
      [toAdd.map((t) => t.employeeId)]
    );
    if (found.length !== toAdd.length) {
      return res.status(400).json({ error: 'all members must be existing active employees' });
    }
    // Single-owner (DRI): promoting to owner demotes the current owner.
    if (toAdd.some((t) => t.role === 'owner')) {
      await pool.query(`UPDATE project_members SET role = 'lead' WHERE project_id = $1 AND role = 'owner'`, [id]);
    }
    for (const t of toAdd) {
      await pool.query(
        `INSERT INTO project_members (project_id, employee_id, role, allocation_pct, is_primary)
         VALUES ($1,$2,$3,$4,$5)`,
        [id, t.employeeId, t.role, t.allocation, t.primary]
      );
      await logActivity(id, null, req.user.id, 'member.add', { employee_id: t.employeeId, role: t.role });
    }
    return res.status(201).json(await projectDetail(id));
  } catch (err) { return next(err); }
});

// --- GET /:id/tasks — filtered list ---
router.get('/:id/tasks', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'invalid id' });
    const role = await getProjectRole(id, req.user.id);
    if (!role && !isHr(req.user)) return res.status(404).json({ error: 'not found' });
    const conds = ['t.project_id = $1'];
    const vals = [id];
    if (req.query.status) {
      if (!TASK_STATUS.has(String(req.query.status))) return res.status(400).json({ error: 'invalid status' });
      vals.push(String(req.query.status));
      conds.push(`t.status = $${vals.length}`);
    }
    if (req.query.assignee) {
      vals.push(Number(req.query.assignee));
      conds.push(`t.assigned_to = $${vals.length}`);
    }
    const { rows } = await pool.query(
      `SELECT t.*, e.first_name AS assignee_first, e.last_name AS assignee_last FROM tasks t
         JOIN employees e ON e.id = t.assigned_to WHERE ${conds.join(' AND ')} ORDER BY t.id LIMIT 100`,
      vals
    );
    return res.json(rows);
  } catch (err) { return next(err); }
});

// --- POST /:id/tasks — assign work (owner/lead only, downward delegation) ---
router.post('/:id/tasks', async (req, res, next) => {
  try {
    if (rateLimited('prj-task', req.ip, WRITE_MAX, WRITE_WINDOW_MS)) {
      return res.status(429).json({ error: 'too many attempts, try later' });
    }
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'invalid id' });
    const p = await projectRow(id);
    if (!p) return res.status(404).json({ error: 'not found' });
    const role = await getProjectRole(id, req.user.id);
    if (!isProjectHeadRole(role) && !isChiefOrAdmin(req.user)) {
      return res.status(403).json({ error: 'project heads only can assign' });
    }
    const title = String(req.body?.title || '').trim();
    const assignedTo = Number(req.body?.assigned_to);
    const reviewerId = req.body?.reviewer_id ? Number(req.body.reviewer_id) : null;
    const parentId = req.body?.parent_task_id ? Number(req.body.parent_task_id) : null;
    const status = req.body?.status ? String(req.body.status) : 'todo';
    const priority = req.body?.priority ? String(req.body.priority) : 'medium';
    const estimate = req.body?.estimate ? String(req.body.estimate) : null;
    const labels = Array.isArray(req.body?.labels) ? req.body.labels.map(String).slice(0, 10) : [];
    if (!title) return res.status(400).json({ error: 'title is required' });
    if (!Number.isInteger(assignedTo)) return res.status(400).json({ error: 'assigned_to is required' });
    if (!TASK_STATUS.has(status)) return res.status(400).json({ error: 'invalid status' });
    if (!PRIORITY.has(priority)) return res.status(400).json({ error: 'invalid priority' });
    if (estimate && !ESTIMATE.has(estimate)) return res.status(400).json({ error: 'invalid estimate' });
    if (status === 'blocked' && !String(req.body?.blocked_reason || '').trim()) {
      return res.status(400).json({ error: 'blocked_reason is required when blocked' });
    }
    const memberIds = new Set(await getProjectMemberIds(id));
    if (!memberIds.has(assignedTo) || !memberIds.has(Number(req.user.id))) {
      return res.status(400).json({ error: 'assigner and assignee must both be project members' });
    }
    if (reviewerId && !memberIds.has(reviewerId)) {
      return res.status(400).json({ error: 'reviewer must be a project member' });
    }
    if (parentId) {
      const par = await pool.query('SELECT id, parent_task_id, project_id FROM tasks WHERE id = $1', [parentId]);
      if (par.rows.length === 0 || Number(par.rows[0].project_id) !== id) {
        return res.status(400).json({ error: 'unknown parent task' });
      }
      if (par.rows[0].parent_task_id) {
        return res.status(400).json({ error: 'subtasks are one level only' });
      }
    }
    const fromRank = await rankOf(req.user.id);
    const toRank = await rankOf(assignedTo);
    if (fromRank == null || toRank == null) return res.status(400).json({ error: 'unknown assignee' });
    if (Number(fromRank) < Number(toRank)) {
      return res.status(403).json({ error: `rank ${fromRank} cannot assign to rank ${toRank}` });
    }
    const { rows } = await pool.query(
      `INSERT INTO tasks (project_id, title, description, assigned_by, assigned_to, reviewer_id, parent_task_id,
                          status, priority, estimate, labels, blocked_reason, due_date)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::text[],$12,$13) RETURNING *`,
      [id, title, req.body?.description ? String(req.body.description).slice(0, 2000) : null,
       req.user.id, assignedTo, reviewerId, parentId, status, priority, estimate, labels,
       req.body?.blocked_reason ? String(req.body.blocked_reason).slice(0, 1000) : null,
       req.body?.due_date || null]
    );
    const t = rows[0];
    await pool.query(
      `INSERT INTO task_watchers (task_id, employee_id) VALUES ($1,$2),($1,$3)
       ON CONFLICT DO NOTHING`, [t.id, assignedTo, req.user.id]
    );
    if (reviewerId) {
      await pool.query(`INSERT INTO task_watchers (task_id, employee_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [t.id, reviewerId]);
    }
    await logActivity(id, t.id, req.user.id, 'task.created', { title, assigned_to: assignedTo });
    return res.status(201).json(t);
  } catch (err) { return next(err); }
});

// --- PATCH /:id/tasks/:tid — free status (assignee/reviewer/head); reassign heads-only ---
router.patch('/:id/tasks/:tid', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const tid = Number(req.params.tid);
    if (!Number.isInteger(id) || !Number.isInteger(tid)) return res.status(400).json({ error: 'invalid id' });
    const { rows } = await pool.query('SELECT * FROM tasks WHERE id = $1 AND project_id = $2', [tid, id]);
    const t = rows[0];
    if (!t) return res.status(404).json({ error: 'not found' });
    const role = await getProjectRole(id, req.user.id);
    const head = isProjectHeadRole(role) || isChiefOrAdmin(req.user);
    const involved = Number(t.assigned_to) === Number(req.user.id) || Number(t.reviewer_id) === Number(req.user.id);
    if (!head && !involved) return res.status(403).json({ error: 'assignee, reviewer, or heads only' });
    const patch = {};
    if (req.body?.status !== undefined) {
      const s = String(req.body.status);
      if (!TASK_STATUS.has(s)) return res.status(400).json({ error: 'invalid status' });
      if (s === 'blocked' && !String(req.body.blocked_reason ?? t.blocked_reason ?? '').trim()) {
        return res.status(400).json({ error: 'blocked_reason is required when blocked' });
      }
      patch.status = s;
      patch.blocked_reason = s === 'blocked'
        ? String(req.body.blocked_reason ?? t.blocked_reason ?? '').slice(0, 1000)
        : null;
      patch.completed_at = s === 'done' ? new Date().toISOString() : null;
    }
    if (req.body?.blocked_reason !== undefined && patch.status === undefined) {
      patch.blocked_reason = req.body.blocked_reason ? String(req.body.blocked_reason).slice(0, 1000) : null;
    }
    for (const k of ['title', 'description']) {
      if (req.body?.[k] !== undefined) {
        const v = String(req.body[k]).trim();
        if (k === 'title' && !v) return res.status(400).json({ error: 'title is required' });
        patch[k] = k === 'title' ? v : (v ? v.slice(0, 2000) : null);
      }
    }
    if (req.body?.priority !== undefined) {
      if (!PRIORITY.has(String(req.body.priority))) return res.status(400).json({ error: 'invalid priority' });
      patch.priority = String(req.body.priority);
    }
    if (req.body?.estimate !== undefined) {
      const e = req.body.estimate ? String(req.body.estimate) : null;
      if (e && !ESTIMATE.has(e)) return res.status(400).json({ error: 'invalid estimate' });
      patch.estimate = e;
    }
    if (req.body?.due_date !== undefined) patch.due_date = req.body.due_date || null;
    if (req.body?.assigned_to !== undefined) {
      if (!head) return res.status(403).json({ error: 'only heads can reassign' });
      const nt = Number(req.body.assigned_to);
      const memberIds = new Set(await getProjectMemberIds(id));
      if (!memberIds.has(nt)) return res.status(400).json({ error: 'assignee must be a project member' });
      const toRank = await rankOf(nt);
      const fromRank = await rankOf(req.user.id);
      if (Number(fromRank) < Number(toRank)) return res.status(403).json({ error: 'upward delegation forbidden' });
      patch.assigned_to = nt;
      patch.assigned_by = req.user.id;
    }
    if (Object.keys(patch).length === 0) return res.status(400).json({ error: 'nothing to update' });
    const cols = Object.keys(patch);
    const { rows: upd } = await pool.query(
      `UPDATE tasks SET ${cols.map((c, i) => `${c} = $${i + 3}`).join(', ')} WHERE id = $1 AND project_id = $2 RETURNING *`,
      [tid, id, ...Object.values(patch)]
    );
    await logActivity(id, tid, req.user.id, 'task.status', patch);
    return res.json(upd[0]);
  } catch (err) { return next(err); }
});

// --- Comments: any member posts; author or head edits/deletes (soft) ---
router.get('/:id/tasks/:tid/comments', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const tid = Number(req.params.tid);
    const role = await getProjectRole(id, req.user.id);
    if (!role && !isHr(req.user)) return res.status(404).json({ error: 'not found' });
    const t = await pool.query('SELECT id FROM tasks WHERE id = $1 AND project_id = $2', [tid, id]);
    if (t.rows.length === 0) return res.status(404).json({ error: 'not found' });
    const { rows } = await pool.query(
      `SELECT c.*, e.first_name, e.last_name FROM task_comments c
         JOIN employees e ON e.id = c.author_id
        WHERE c.task_id = $1 ORDER BY c.id LIMIT 100`, [tid]
    );
    return res.json(rows);
  } catch (err) { return next(err); }
});

router.post('/:id/tasks/:tid/comments', async (req, res, next) => {
  try {
    if (rateLimited('prj-comment', req.ip, WRITE_MAX, WRITE_WINDOW_MS)) {
      return res.status(429).json({ error: 'too many attempts, try later' });
    }
    const id = Number(req.params.id);
    const tid = Number(req.params.tid);
    const role = await getProjectRole(id, req.user.id);
    if (!role) return res.status(404).json({ error: 'not found' });
    const t = await pool.query('SELECT id FROM tasks WHERE id = $1 AND project_id = $2', [tid, id]);
    if (t.rows.length === 0) return res.status(404).json({ error: 'not found' });
    const body = String(req.body?.body || '').trim();
    if (!body) return res.status(400).json({ error: 'body is required' });
    const { rows } = await pool.query(
      `INSERT INTO task_comments (task_id, author_id, body) VALUES ($1,$2,$3) RETURNING *`,
      [tid, req.user.id, body.slice(0, 5000)]
    );
    await logActivity(id, tid, req.user.id, 'comment', {});
    return res.status(201).json(rows[0]);
  } catch (err) { return next(err); }
});

// --- Updates: any member posts weekly status; list recent ---
router.get('/:id/updates', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const role = await getProjectRole(id, req.user.id);
    if (!role && !isHr(req.user)) return res.status(404).json({ error: 'not found' });
    const { rows } = await pool.query(
      `SELECT u.*, e.first_name, e.last_name FROM project_updates u
         JOIN employees e ON e.id = u.author_id
        WHERE u.project_id = $1 ORDER BY u.id DESC LIMIT 20`, [id]
    );
    return res.json(rows);
  } catch (err) { return next(err); }
});

router.post('/:id/updates', async (req, res, next) => {
  try {
    if (rateLimited('prj-update', req.ip, WRITE_MAX, WRITE_WINDOW_MS)) {
      return res.status(429).json({ error: 'too many attempts, try later' });
    }
    const id = Number(req.params.id);
    const role = await getProjectRole(id, req.user.id);
    if (!role) return res.status(404).json({ error: 'not found' });
    const body = String(req.body?.body || '').trim();
    if (!body) return res.status(400).json({ error: 'body is required' });
    const { rows } = await pool.query(
      `INSERT INTO project_updates (project_id, author_id, body) VALUES ($1,$2,$3) RETURNING *`,
      [id, req.user.id, body.slice(0, 2000)]
    );
    await logActivity(id, null, req.user.id, 'update.posted', {});
    return res.status(201).json(rows[0]);
  } catch (err) { return next(err); }
});

// --- GET /:id/activity — audit trail (members + HR/chief) ---
router.get('/:id/activity', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const role = await getProjectRole(id, req.user.id);
    if (!role && !isHr(req.user)) return res.status(404).json({ error: 'not found' });
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 100);
    const before = req.query.before_id ? Number(req.query.before_id) : null;
    const vals = [id];
    let cond = 'l.project_id = $1';
    if (Number.isInteger(before)) {
      vals.push(before);
      cond += ` AND l.id < $${vals.length}`;
    }
    vals.push(limit);
    const { rows } = await pool.query(
      `SELECT l.*, e.first_name, e.last_name FROM project_activity_log l
         LEFT JOIN employees e ON e.id = l.actor_id
        WHERE ${cond} ORDER BY l.id DESC LIMIT $${vals.length}`, vals
    );
    return res.json(rows);
  } catch (err) { return next(err); }
});

export default router;
