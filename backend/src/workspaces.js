// workspaces.js — Workspace containers + HR staffing from existing employees.
// Mounted at /api/workspaces (and alias /workspaces for spec compat).
// POST /          — chief (rank>=5) or admin creates; creator becomes owner.
// GET  /          — members-only list (Task 6: list user's workspaces).
// GET  /:id       — members + HR/chief detail (members + staff requests).
// POST /:id/staff-requests — any member requests people (headcount/ranks/priority).
// POST /:id/members        — HR/chief staffs existing active employees or
//                            marks request pending_hiring when nobody fits.
//                            HR/chief need not be workspace members.
import { Router } from 'express';
import { requireAuth } from './auth.js';
import { pool } from './db.js';
import { rateLimited } from './ratelimit.js';
import { findCandidates, getMemberIds, isChiefOrAdmin, isHr } from './staffing.js';

export const router = Router();
router.use(requireAuth);

// Anti-spam on writes (per IP); reads stay unthrottled for normal UX.
const WRITE_MAX = 30;
const WRITE_WINDOW_MS = 60_000;

const ROLES = new Set(['owner', 'lead', 'member', 'viewer']);
const PRIORITIES = new Set(['low', 'medium', 'high', 'urgent']);
const REQ_STATUS = new Set(['open', 'staffed', 'pending_hiring', 'closed']);

async function isMember(workspaceId, employeeId) {
  const { rows } = await pool.query(
    'SELECT 1 FROM workspace_members WHERE workspace_id = $1 AND employee_id = $2',
    [workspaceId, employeeId]
  );
  return rows.length > 0;
}

async function workspaceDetail(id) {
  const { rows } = await pool.query('SELECT * FROM workspaces WHERE id = $1', [id]);
  if (rows.length === 0) return null;
  const ws = rows[0];
  const members = await pool.query(
    `SELECT m.workspace_id, m.employee_id, m.role, m.allocation_pct, m.is_primary, m.joined_at,
            e.first_name, e.last_name, e.email, e.rank, d.name AS department
       FROM workspace_members m
       JOIN employees e ON e.id = m.employee_id
       JOIN departments d ON d.id = e.department_id
      WHERE m.workspace_id = $1 ORDER BY m.joined_at`,
    [id]
  );
  const requests = await pool.query(
    'SELECT * FROM workspace_staff_requests WHERE workspace_id = $1 ORDER BY id DESC',
    [id]
  );
  return { ...ws, members: members.rows, staff_requests: requests.rows };
}

// --- POST / — create workspace, link creator as owner ---
router.post('/', async (req, res, next) => {
  try {
    if (rateLimited('ws-create', req.ip, WRITE_MAX, WRITE_WINDOW_MS)) {
      return res.status(429).json({ error: 'too many attempts, try later' });
    }
    if (!isChiefOrAdmin(req.user)) {
      return res.status(403).json({ error: 'only chiefs (rank 5+) or admins can create workspaces' });
    }
    const name = String(req.body?.name || '').trim();
    const description = req.body?.description ? String(req.body.description).slice(0, 2000) : null;
    const status = req.body?.status ? String(req.body.status) : 'active';
    if (!name) return res.status(400).json({ error: 'name is required' });
    if (!['planned', 'active', 'archived'].includes(status)) {
      return res.status(400).json({ error: 'invalid status' });
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      let ws;
      try {
        const { rows } = await client.query(
          `INSERT INTO workspaces (name, description, created_by, status)
           VALUES ($1, $2, $3, $4) RETURNING *`,
          [name, description, req.user.id, status]
        );
        ws = rows[0];
      } catch (err) {
        if (err.code === '23505') {
          await client.query('ROLLBACK');
          return res.status(409).json({ error: 'workspace name already exists' });
        }
        throw err;
      }
      await client.query(
        `INSERT INTO workspace_members (workspace_id, employee_id, role, allocation_pct, is_primary)
         VALUES ($1, $2, 'owner', 100, TRUE) ON CONFLICT DO NOTHING`,
        [ws.id, req.user.id]
      );
      await client.query('COMMIT');
      return res.status(201).json(await workspaceDetail(ws.id));
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch { /* already closed */ }
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    return next(err);
  }
});

// --- GET / — list my workspaces ---
router.get('/', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT w.*, m.role AS my_role, m.allocation_pct AS my_allocation
         FROM workspaces w
         JOIN workspace_members m ON m.workspace_id = w.id AND m.employee_id = $1
        ORDER BY w.id`,
      [req.user.id]
    );
    return res.json(rows);
  } catch (err) {
    return next(err);
  }
});

// --- GET /candidates — HR helper (must precede /:id) ---
router.get('/candidates', async (req, res, next) => {
  try {
    if (!isHr(req.user)) return res.status(403).json({ error: 'HR or chief access required' });
    const ranks = String(req.query.ranks || '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s !== '')
      .map(Number)
      .filter((r) => Number.isInteger(r) && r >= 1 && r <= 6);
    const departmentIds = String(req.query.departments || '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s !== '')
      .map(Number)
      .filter(Number.isInteger);
    return res.json(await findCandidates({ ranks, departmentIds }));
  } catch (err) {
    return next(err);
  }
});

// --- GET /:id — detail for members, or any HR/chief (who staff it) ---
router.get('/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'invalid id' });
    const ws = await pool.query('SELECT id FROM workspaces WHERE id = $1', [id]);
    if (ws.rows.length === 0) return res.status(404).json({ error: 'not found' });
    if (!isHr(req.user) && !(await isMember(id, req.user.id))) {
      return res.status(404).json({ error: 'not found' });
    }
    return res.json(await workspaceDetail(id));
  } catch (err) {
    return next(err);
  }
});

// --- POST /:id/staff-requests — request people with priority ---
router.post('/:id/staff-requests', async (req, res, next) => {
  try {
    if (rateLimited('ws-staffreq', req.ip, WRITE_MAX, WRITE_WINDOW_MS)) {
      return res.status(429).json({ error: 'too many attempts, try later' });
    }
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'invalid id' });
    if (!(await isMember(id, req.user.id))) return res.status(404).json({ error: 'not found' });
    const headcount = Number(req.body?.headcount ?? 1);
    const priority = String(req.body?.priority || 'medium');
    const requirements = req.body?.requirements ? String(req.body.requirements).slice(0, 2000) : null;
    const ranks = Array.isArray(req.body?.ranks_needed)
      ? req.body.ranks_needed.map(Number).filter((r) => Number.isInteger(r) && r >= 1 && r <= 6)
      : [];
    if (!Number.isInteger(headcount) || headcount < 1 || headcount > 100) {
      return res.status(400).json({ error: 'headcount must be 1-100' });
    }
    if (!PRIORITIES.has(priority)) return res.status(400).json({ error: 'invalid priority' });
    const { rows } = await pool.query(
      `INSERT INTO workspace_staff_requests (workspace_id, requester_id, requirements, headcount, ranks_needed, priority)
       VALUES ($1, $2, $3, $4, $5::int[], $6) RETURNING *`,
      [id, req.user.id, requirements, headcount, ranks, priority]
    );
    return res.status(201).json(rows[0]);
  } catch (err) {
    return next(err);
  }
});

// --- POST /:id/members — HR/chief staffs existing active employees ---
router.post('/:id/members', async (req, res, next) => {
  try {
    if (rateLimited('ws-staff', req.ip, WRITE_MAX, WRITE_WINDOW_MS)) {
      return res.status(429).json({ error: 'too many attempts, try later' });
    }
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'invalid id' });
    const ws = await pool.query('SELECT id FROM workspaces WHERE id = $1', [id]);
    if (ws.rows.length === 0) return res.status(404).json({ error: 'not found' });
    // HR/chief staff any workspace (they are usually not members yet).
    if (!isHr(req.user)) return res.status(403).json({ error: 'HR or chief access required' });

    const list = Array.isArray(req.body?.members) ? req.body.members : null;
    const requestId = req.body?.request_id ? Number(req.body.request_id) : null;
    // Allow marking pending_hiring with no members when nobody fits.
    if ((!list || list.length === 0) && requestId) {
      if (req.body?.pending_hiring === true) {
        await pool.query(
          `UPDATE workspace_staff_requests SET status = 'pending_hiring' WHERE id = $1 AND workspace_id = $2`,
          [requestId, id]
        );
        return res.json(await workspaceDetail(id));
      }
      return res.status(400).json({ error: 'members[] required (or pending_hiring with request_id)' });
    }
    if (!list || list.length === 0 || list.length > 50) {
      return res.status(400).json({ error: 'members[] must have 1-50 entries' });
    }
    const existing = new Set(await getMemberIds(id));
    const toAdd = [];
    for (const m of list) {
      const employeeId = Number(m?.employee_id);
      const role = String(m?.role || 'member');
      const allocation = Number(m?.allocation_pct ?? 100);
      if (!Number.isInteger(employeeId)) return res.status(400).json({ error: 'invalid employee_id' });
      if (!ROLES.has(role)) return res.status(400).json({ error: 'invalid role' });
      if (!Number.isInteger(allocation) || allocation < 1 || allocation > 100) {
        return res.status(400).json({ error: 'allocation_pct must be 1-100' });
      }
      if (existing.has(employeeId)) return res.status(409).json({ error: `employee ${employeeId} already in workspace` });
      toAdd.push({ employeeId, role, allocation, primary: m?.is_primary !== false });
    }
    // All must be active existing employees (rank/dept match enforced by caller via /candidates).
    const { rows: found } = await pool.query(
      'SELECT id FROM employees WHERE id = ANY($1::bigint[]) AND is_active = TRUE',
      [toAdd.map((t) => t.employeeId)]
    );
    if (found.length !== toAdd.length) {
      return res.status(400).json({ error: 'all members must be existing active employees' });
    }
    for (const t of toAdd) {
      await pool.query(
        `INSERT INTO workspace_members (workspace_id, employee_id, role, allocation_pct, is_primary)
         VALUES ($1, $2, $3, $4, $5)`,
        [id, t.employeeId, t.role, t.allocation, t.primary]
      );
    }
    if (requestId) {
      await pool.query(
        `UPDATE workspace_staff_requests SET status = 'staffed' WHERE id = $1 AND workspace_id = $2`,
        [requestId, id]
      );
    }
    return res.status(201).json(await workspaceDetail(id));
  } catch (err) {
    return next(err);
  }
});

// --- PATCH /:wid/staff-requests/:rid — update status (HR/chief) ---
router.patch('/:wid/staff-requests/:rid', async (req, res, next) => {
  try {
    if (!isHr(req.user)) return res.status(403).json({ error: 'HR or chief access required' });
    const status = String(req.body?.status || '');
    if (!REQ_STATUS.has(status)) return res.status(400).json({ error: 'invalid status' });
    const { rows } = await pool.query(
      `UPDATE workspace_staff_requests SET status = $1
        WHERE id = $2 AND workspace_id = $3 RETURNING *`,
      [status, Number(req.params.rid), Number(req.params.wid)]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'not found' });
    return res.json(rows[0]);
  } catch (err) {
    return next(err);
  }
});

export default router;
