// staffing.js — shared candidate lookup for workspaces now, projects later.
// Single source of truth so hiring existing staff works the same everywhere.
import { pool } from './db.js';

export function isChiefOrAdmin(user) {
  if (!user) return false;
  return Number(user.rank) >= 5 || user.isAdmin === true;
}

export function isHr(user) {
  if (!user) return false;
  return user.dept_name === 'HR' || isChiefOrAdmin(user);
}

// Reusable: find active employees matching ranks/depts, excluding ids.
// Used by workspace staffing; future project staffing should import this.
export async function findCandidates({ ranks = [], departmentIds = [], excludeIds = [], limit = 20 } = {}) {
  const vals = [];
  const conds = ['e.is_active = TRUE'];
  if (ranks.length > 0) {
    vals.push(ranks.map(Number).filter((r) => Number.isInteger(r) && r >= 1 && r <= 6));
    conds.push(`e.rank = ANY($${vals.length}::int[])`);
  }
  if (departmentIds.length > 0) {
    vals.push(departmentIds.map(Number).filter(Number.isInteger));
    conds.push(`e.department_id = ANY($${vals.length}::bigint[])`);
  }
  if (excludeIds.length > 0) {
    vals.push(excludeIds.map(Number).filter(Number.isInteger));
    conds.push(`e.id <> ALL($${vals.length}::bigint[])`);
  }
  vals.push(Math.min(Math.max(Number(limit) || 20, 1), 50));
  const { rows } = await pool.query(
    `SELECT e.id, e.first_name, e.last_name, e.email, e.rank, e.department_id,
            d.name AS department
       FROM employees e JOIN departments d ON d.id = e.department_id
      WHERE ${conds.join(' AND ')}
      ORDER BY e.rank DESC, e.id LIMIT $${vals.length}`,
    vals
  );
  return rows;
}

export async function getMemberIds(workspaceId) {
  const { rows } = await pool.query(
    'SELECT employee_id FROM workspace_members WHERE workspace_id = $1',
    [workspaceId]
  );
  return rows.map((r) => Number(r.employee_id));
}

// Workspace head = owner|lead of ANY workspace (any rank/dept — designated, not rank-gated).
export async function isWorkspaceHead(employeeId) {
  if (!employeeId) return false;
  const { rows } = await pool.query(
    `SELECT 1 FROM workspace_members WHERE employee_id = $1 AND role IN ('owner','lead') LIMIT 1`,
    [employeeId]
  );
  return rows.length > 0;
}

export async function getProjectMemberIds(projectId) {
  const { rows } = await pool.query(
    'SELECT employee_id FROM project_members WHERE project_id = $1',
    [projectId]
  );
  return rows.map((r) => Number(r.employee_id));
}

export async function getProjectRole(projectId, employeeId) {
  const { rows } = await pool.query(
    'SELECT role FROM project_members WHERE project_id = $1 AND employee_id = $2',
    [projectId, employeeId]
  );
  return rows[0]?.role || null;
}

export function isProjectHeadRole(role) {
  return role === 'owner' || role === 'lead';
}

// Workload-enriched candidates: current role + dept + other work so heads
// don't overload people when staffing single- or multi-department projects.
export async function findProjectCandidates({ ranks = [], departmentIds = [], q = '', excludeIds = [], limit = 20 } = {}) {
  const vals = [];
  const conds = ['e.is_active = TRUE'];
  if (ranks.length > 0) {
    vals.push(ranks.map(Number).filter((r) => Number.isInteger(r) && r >= 1 && r <= 6));
    conds.push(`e.rank = ANY($${vals.length}::int[])`);
  }
  if (departmentIds.length > 0) {
    vals.push(departmentIds.map(Number).filter(Number.isInteger));
    conds.push(`e.department_id = ANY($${vals.length}::bigint[])`);
  }
  if (excludeIds.length > 0) {
    vals.push(excludeIds.map(Number).filter(Number.isInteger));
    conds.push(`e.id <> ALL($${vals.length}::bigint[])`);
  }
  if (q) {
    vals.push(`%${String(q).slice(0, 80)}%`);
    conds.push(`(e.first_name ILIKE $${vals.length} OR e.last_name ILIKE $${vals.length} OR e.email ILIKE $${vals.length})`);
  }
  vals.push(Math.min(Math.max(Number(limit) || 20, 1), 50));
  const { rows } = await pool.query(
    `SELECT e.id, e.first_name, e.last_name, e.email, e.rank, e.department_id,
            d.name AS department,
            (SELECT COUNT(*)::int FROM project_members pm
               JOIN projects p ON p.id = pm.project_id
              WHERE pm.employee_id = e.id AND p.status IN ('planned','active','on_hold')) AS active_projects,
            (SELECT COUNT(*)::int FROM tasks t
              WHERE t.assigned_to = e.id AND t.status NOT IN ('done','cancelled')) AS open_tasks,
            COALESCE((SELECT SUM(pm2.allocation_pct)::int FROM project_members pm2
               JOIN projects p2 ON p2.id = pm2.project_id
              WHERE pm2.employee_id = e.id AND p2.status IN ('planned','active','on_hold')), 0)
            + COALESCE((SELECT SUM(wm.allocation_pct)::int FROM workspace_members wm
               JOIN workspaces w ON w.id = wm.workspace_id
              WHERE wm.employee_id = e.id AND w.status = 'active'), 0) AS total_alloc
       FROM employees e JOIN departments d ON d.id = e.department_id
      WHERE ${conds.join(' AND ')}
      ORDER BY e.rank DESC, e.id LIMIT $${vals.length}`,
    vals
  );
  return rows;
}
