// admin.js — Admin panel API: auth (password + opaque sessions) + allowlist,
// employee management, access control, overview. Mounted at /api/admin.
// Auth model: employee email + password; only active rank-6 (Owner) or
// IT-department employees are eligible. Sessions are opaque tokens stored
// as SHA-256 in admin_sessions with a 30-minute expiry.
import { Router } from 'express';
import { hashPassword, newToken, setupTokenMatches, sha256hex, verifyPassword } from './crypto.js';
import { pool } from './db.js';

export const router = Router();

const SESSION_TTL_MIN = 30;
const LOGIN_WINDOW_MS = 60_000;
const LOGIN_MAX_ATTEMPTS = 5;
const MIN_PASSWORD_LEN = 8;
// Dummy hash so unknown emails take the same code path (no user enumeration).
const DUMMY_HASH = 'scrypt$16384$8$1$00000000000000000000000000000000$0000000000000000000000000000000000000000000000000000000000000000';
const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

// --- login rate limiter (per IP; single-instance) ---
const loginAttempts = new Map(); // ip -> { count, resetAt }
export function _resetLoginAttempts() {
  loginAttempts.clear();
}
function loginAllowed(ip) {
  const now = Date.now();
  const cur = loginAttempts.get(ip);
  if (!cur || now >= cur.resetAt) {
    loginAttempts.set(ip, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
    return true;
  }
  cur.count += 1;
  return cur.count <= LOGIN_MAX_ATTEMPTS;
}

// --- eligibility: active AND (Owner rank 6 OR IT department) ---
function eligible(row) {
  return !!row && row.is_active === true && (row.rank === 6 || row.dept_name === 'IT');
}

// --- auth middleware: valid unexpired session + still eligible ---
export async function requireAdmin(req, res, next) {
  res.set('Cache-Control', 'no-store');
  try {
    const m = /^Bearer (.+)$/.exec(req.get('authorization') || '');
    if (!m) return res.status(401).json({ error: 'unauthorized' });
    const { rows } = await pool.query(
      `SELECT e.id, e.email, e.rank, e.is_active, d.name AS dept_name
         FROM admin_sessions s
         JOIN employees e ON e.id = s.employee_id
         JOIN departments d ON d.id = e.department_id
        WHERE s.token_hash = $1 AND s.expires_at > now()`,
      [sha256hex(m[1])]
    );
    const a = rows[0];
    if (!eligible(a)) return res.status(401).json({ error: 'unauthorized' });
    req.admin = { id: a.id, email: a.email, rank: a.rank };
    return next();
  } catch (err) {
    return next(err);
  }
}

// --- first-time credential creation, guarded by one-time SETUP_TOKEN ---
router.post('/bootstrap', async (req, res, next) => {
  try {
    const setupToken = process.env.SETUP_TOKEN;
    if (!setupToken) return res.status(403).json({ error: 'bootstrap disabled' });
    const { email, password, setupToken: provided } = req.body || {};
    if (!setupTokenMatches(provided, setupToken)) {
      return res.status(403).json({ error: 'bootstrap disabled' });
    }
    if (!email || !password || String(password).length < MIN_PASSWORD_LEN) {
      return res.status(400).json({ error: 'email and password (min 8 chars) required' });
    }
    const emp = await pool.query(
      `SELECT e.id, e.is_active, e.rank, d.name AS dept_name
         FROM employees e JOIN departments d ON d.id = e.department_id
        WHERE e.email = $1`,
      [email]
    );
    if (emp.rows.length === 0) return res.status(404).json({ error: 'employee not found' });
    if (!eligible(emp.rows[0])) return res.status(403).json({ error: 'not eligible for admin access' });
    const existing = await pool.query('SELECT 1 FROM admin_credentials WHERE employee_id = $1', [
      emp.rows[0].id,
    ]);
    if (existing.rows.length > 0) return res.status(409).json({ error: 'credential already exists' });
    await pool.query('INSERT INTO admin_credentials (employee_id, password_hash) VALUES ($1, $2)', [
      emp.rows[0].id,
      await hashPassword(String(password)),
    ]);
    return res.status(201).json({ ok: true });
  } catch (err) {
    return next(err);
  }
});

// --- login: generic 401 either way (no enumeration) ---
router.post('/login', async (req, res, next) => {
  try {
    if (!loginAllowed(req.ip)) return res.status(429).json({ error: 'too many attempts, try later' });
    const { email, password } = req.body || {};
    const emp = email
      ? await pool.query(
          `SELECT e.id, e.is_active, e.rank, d.name AS dept_name
             FROM employees e JOIN departments d ON d.id = e.department_id
            WHERE e.email = $1`,
          [email]
        )
      : { rows: [] };
    const row = emp.rows[0];
    const cred = row
      ? await pool.query('SELECT password_hash FROM admin_credentials WHERE employee_id = $1', [row.id])
      : { rows: [] };
    const ok =
      row &&
      cred.rows[0] &&
      (await verifyPassword(String(password || ''), cred.rows[0].password_hash));
    if (!ok) {
      // Same work factor for unknown users so timing reveals nothing.
      await verifyPassword(String(password || ''), DUMMY_HASH);
      return res.status(401).json({ error: 'invalid credentials' });
    }
    if (!eligible(row)) return res.status(403).json({ error: 'admin access required' });
    await pool.query('DELETE FROM admin_sessions WHERE expires_at < now()');
    const token = newToken();
    const { rows } = await pool.query(
      `INSERT INTO admin_sessions (employee_id, token_hash, expires_at)
       VALUES ($1, $2, now() + make_interval(mins => $3))
       RETURNING expires_at`,
      [row.id, sha256hex(token), SESSION_TTL_MIN]
    );
    return res.json({ token, expiresAt: rows[0].expires_at });
  } catch (err) {
    return next(err);
  }
});

router.post('/logout', requireAdmin, async (req, res, next) => {
  try {
    const m = /^Bearer (.+)$/.exec(req.get('authorization') || '');
    await pool.query('DELETE FROM admin_sessions WHERE token_hash = $1', [sha256hex(m[1])]);
    return res.status(204).end();
  } catch (err) {
    return next(err);
  }
});

// --- email domain allowlist ---
router.get('/email-domains', requireAdmin, async (_req, res, next) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, domain, created_at FROM allowed_email_domains ORDER BY domain'
    );
    return res.json(rows);
  } catch (err) {
    return next(err);
  }
});

router.post('/email-domains', requireAdmin, async (req, res, next) => {
  try {
    const domain = String(req.body?.domain || '').trim().toLowerCase();
    if (!DOMAIN_RE.test(domain)) return res.status(400).json({ error: 'invalid domain format' });
    try {
      const { rows } = await pool.query(
        'INSERT INTO allowed_email_domains (domain, created_by) VALUES ($1, $2) RETURNING id, domain, created_at',
        [domain, req.admin.id]
      );
      return res.status(201).json(rows[0]);
    } catch (err) {
      if (err.code === '23505') return res.status(409).json({ error: 'domain already allowed' });
      throw err;
    }
  } catch (err) {
    return next(err);
  }
});

router.delete('/email-domains/:domain', requireAdmin, async (req, res, next) => {
  try {
    const { rowCount } = await pool.query('DELETE FROM allowed_email_domains WHERE domain = $1', [
      String(req.params.domain).toLowerCase(),
    ]);
    if (rowCount === 0) return res.status(404).json({ error: 'domain not found' });
    return res.status(204).end();
  } catch (err) {
    return next(err);
  }
});

// --- departments (for employee form selects) ---
router.get('/departments', requireAdmin, async (_req, res, next) => {
  try {
    const { rows } = await pool.query('SELECT id, name FROM departments ORDER BY name');
    return res.json(rows);
  } catch (err) {
    return next(err);
  }
});

// --- employees: paginated directory with prefix search (indexed: email UNIQUE, last_name) ---
const EMP_COLS = `e.id, e.first_name, e.last_name, e.email, e.rank, e.department_id,
                  d.name AS department, e.manager_id, e.hire_date, e.is_active`;

router.get('/employees', requireAdmin, async (req, res, next) => {
  try {
    const q = String(req.query.q || '').slice(0, 100);
    const limit = Math.min(Math.max(Number(req.query.limit) || 25, 1), 50);
    const page = Math.max(Number(req.query.page) || 1, 1);
    const where = `WHERE ($1 = '' OR e.email ILIKE $1 || '%' OR e.last_name ILIKE $1 || '%')`;
    const total = await pool.query(
      `SELECT COUNT(*)::int AS total FROM employees e ${where}`,
      [q]
    );
    const { rows } = await pool.query(
      `SELECT ${EMP_COLS} FROM employees e JOIN departments d ON d.id = e.department_id
       ${where} ORDER BY e.id LIMIT $2 OFFSET $3`,
      [q, limit, (page - 1) * limit]
    );
    return res.json({ rows, total: total.rows[0].total, page, limit });
  } catch (err) {
    return next(err);
  }
});

router.post('/employees', requireAdmin, async (req, res, next) => {
  try {
    const { first_name, last_name, email, rank, department_id, manager_id } = req.body || {};
    const r = Number(rank);
    if (!first_name || !last_name || !email || !Number.isInteger(r) || r < 1 || r > 6 || !department_id) {
      return res.status(400).json({ error: 'first/last/email/rank(1-6)/department required' });
    }
    try {
      const { rows } = await pool.query(
        `INSERT INTO employees (first_name, last_name, email, rank, department_id, manager_id)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, first_name, last_name, email, rank, department_id, manager_id, is_active`,
        [first_name, last_name, email, r, department_id, manager_id || null]
      );
      return res.status(201).json(rows[0]);
    } catch (err) {
      // FK / unique / domain-trigger violations all surface here with DB messages.
      return res.status(400).json({ error: err.message });
    }
  } catch (err) {
    return next(err);
  }
});

const PATCHABLE = new Set([
  'first_name',
  'last_name',
  'email',
  'rank',
  'department_id',
  'manager_id',
  'is_active',
]);

router.patch('/employees/:id', requireAdmin, async (req, res, next) => {
  try {
    const sets = [];
    const vals = [];
    for (const [k, v] of Object.entries(req.body || {})) {
      if (PATCHABLE.has(k)) {
        vals.push(v);
        sets.push(`${k} = $${vals.length}`);
      }
    }
    if (sets.length === 0) return res.status(400).json({ error: 'no editable fields provided' });
    if ('rank' in (req.body || {})) {
      const r = Number(req.body.rank);
      if (!Number.isInteger(r) || r < 1 || r > 6) {
        return res.status(400).json({ error: 'rank must be 1-6' });
      }
    }
    vals.push(req.params.id);
    try {
      const { rows } = await pool.query(
        `UPDATE employees SET ${sets.join(', ')} WHERE id = $${vals.length}
         RETURNING id, first_name, last_name, email, rank, department_id, manager_id, is_active`,
        vals
      );
      if (rows.length === 0) return res.status(404).json({ error: 'employee not found' });
      return res.json(rows[0]);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
  } catch (err) {
    return next(err);
  }
});

// --- overview: single aggregate query + one grouped query (no N+1) ---
router.get('/overview', requireAdmin, async (_req, res, next) => {
  try {
    const totals = await pool.query(
      `SELECT (SELECT COUNT(*)::int FROM employees) AS employees,
              (SELECT COUNT(*)::int FROM employees WHERE is_active) AS active,
              (SELECT COUNT(*)::int FROM allowed_email_domains) AS domains,
              (SELECT COUNT(*)::int FROM hr_tickets WHERE status = 'open') AS open_tickets,
              (SELECT COUNT(*)::int FROM projects WHERE status = 'active') AS active_projects`
    );
    const byDept = await pool.query(
      `SELECT d.name AS department, COUNT(e.id)::int AS headcount
         FROM departments d LEFT JOIN employees e
           ON e.department_id = d.id AND e.is_active
        GROUP BY d.name ORDER BY d.name`
    );
    return res.json({ totals: totals.rows[0], byDepartment: byDept.rows });
  } catch (err) {
    return next(err);
  }
});

export default router;
