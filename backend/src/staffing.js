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
