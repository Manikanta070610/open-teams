// auth.js — General employee auth (both tiers): JWE access tokens + rotating
// opaque refresh cookies with a sliding inactivity window.
// Mounted at /api/auth. See tokens.js (JWE) and settings.js (policy).
import { Router } from 'express';
import { hashPassword, newToken, sha256hex, verifyPassword } from './crypto.js';
import { pool } from './db.js';
import { rateLimited } from './ratelimit.js';
import {
  audit,
  getAccessTtlMin,
  getInactivityDays,
} from './settings.js';
import { issueAccessToken, verifyAccessToken } from './tokens.js';

export const router = Router();

const LOGIN_MAX = 5;
const LOGIN_WINDOW_MS = 60_000;
const MIN_PASSWORD_LEN = 8;
const MAX_PASSWORD_LEN = 200;
const DUMMY_HASH =
  'scrypt$16384$8$1$00000000000000000000000000000000$0000000000000000000000000000000000000000000000000000000000000000';
const REFRESH_COOKIE = 'oms_refresh';

// --- cookie helpers (no extra deps) ---
function parseCookies(req) {
  const out = {};
  const h = req.get('cookie');
  if (!h) return out;
  for (const part of String(h).split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function cookieFlags(req, maxAgeSec) {
  const secure =
    process.env.COOKIE_SECURE === 'true' ||
    req.secure ||
    String(req.get('x-forwarded-proto') || '').split(',')[0].trim() === 'https' ||
    process.env.NODE_ENV === 'production';
  let c = `Path=/api/auth; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}`;
  if (secure) c += '; Secure';
  return c;
}

function setRefreshCookie(res, req, token, maxAgeSec) {
  res.append(
    'Set-Cookie',
    `${REFRESH_COOKIE}=${encodeURIComponent(token)}; ${cookieFlags(req, maxAgeSec)}`
  );
}

function clearRefreshCookie(res, req) {
  res.append(
    'Set-Cookie',
    `${REFRESH_COOKIE}=; Path=/api/auth; HttpOnly; SameSite=Lax; Max-Age=0`
  );
}

function isEligibleAdmin(row) {
  return !!row && row.is_active === true && (row.rank === 6 || row.dept_name === 'IT');
}

async function findEmployeeByEmail(email) {
  const { rows } = await pool.query(
    `SELECT e.id, e.email, e.first_name, e.last_name, e.rank, e.is_active,
            e.password_version, e.contact_email,
            d.name AS dept_name, c.password_hash, c.must_change_password
       FROM employees e
       JOIN departments d ON d.id = e.department_id
       LEFT JOIN admin_credentials c ON c.employee_id = e.id
      WHERE e.email = $1`,
    [email]
  );
  return rows[0] || null;
}

async function createRefreshSession(employeeId, req, inactivityDays) {
  await pool.query("DELETE FROM auth_refresh_sessions WHERE expires_at < now() OR (revoked_at IS NOT NULL AND revoked_at < now() - interval '30 days')");
  const token = newToken();
  await pool.query(
    `INSERT INTO auth_refresh_sessions (employee_id, token_hash, last_seen_at, expires_at, user_agent, ip)
     VALUES ($1, $2, now(), now() + make_interval(days => $3), $4, $5::inet)`,
    [
      employeeId,
      sha256hex(token),
      inactivityDays,
      String(req.get('user-agent') || '').slice(0, 256),
      (() => {
        const ip = String(req.ip || '').split(',')[0].trim();
        return ip || null;
      })(),
    ]
  );
  return token;
}

async function buildUserPayload(emp) {
  return {
    id: emp.id,
    email: emp.email,
    rank: emp.rank,
    dept_name: emp.dept_name,
    isAdmin: isEligibleAdmin(emp),
    password_version: emp.password_version ?? 1,
    must_change_password: emp.must_change_password ?? true,
  };
}

// --- middleware: valid JWE + still active + password version matches ---
export async function requireAuth(req, res, next) {
  res.set('Cache-Control', 'no-store');
  try {
    const m = /^Bearer (.+)$/.exec(req.get('authorization') || '');
    if (!m) return res.status(401).json({ error: 'unauthorized' });
    let claims;
    try {
      claims = await verifyAccessToken(m[1]);
    } catch {
      return res.status(401).json({ error: 'unauthorized' });
    }
    const { rows } = await pool.query(
      `SELECT e.id, e.email, e.rank, e.is_active, e.password_version,
              d.name AS dept_name, c.must_change_password
         FROM employees e
         JOIN departments d ON d.id = e.department_id
         LEFT JOIN admin_credentials c ON c.employee_id = e.id
        WHERE e.id = $1`,
      [claims.id]
    );
    const emp = rows[0];
    if (!emp || emp.is_active !== true) return res.status(401).json({ error: 'unauthorized' });
    if (Number(emp.password_version ?? 1) !== Number(claims.password_version ?? 1)) {
      return res.status(401).json({ error: 'session expired, sign in again' });
    }
    req.user = {
      id: emp.id,
      email: emp.email,
      rank: emp.rank,
      dept_name: emp.dept_name,
      isAdmin: isEligibleAdmin(emp),
      must_change_password: emp.must_change_password ?? false,
    };
    return next();
  } catch (err) {
    return next(err);
  }
}

// --- POST /api/auth/login ---
router.post('/login', async (req, res, next) => {
  try {
    if (rateLimited('auth-login', req.ip, LOGIN_MAX, LOGIN_WINDOW_MS)) {
      return res.status(429).json({ error: 'too many attempts, try later' });
    }
    const { email, password, remember = true } = req.body || {};
    const emp = email ? await findEmployeeByEmail(email) : null;
    const ok =
      emp &&
      emp.password_hash &&
      (await verifyPassword(String(password || ''), emp.password_hash));
    if (!ok) {
      await verifyPassword(String(password || ''), DUMMY_HASH);
      await audit(emp?.id ?? null, 'login-fail', req.ip);
      return res.status(401).json({ error: 'invalid credentials' });
    }
    if (emp.is_active !== true) {
      await audit(emp.id, 'login-inactive', req.ip);
      return res.status(401).json({ error: 'invalid credentials' });
    }
    const payload = await buildUserPayload(emp);
    const ttlMin = await getAccessTtlMin();
    const token = await issueAccessToken(payload, ttlMin);
    let refreshSet = false;
    if (remember !== false) {
      const days = await getInactivityDays();
      const refresh = await createRefreshSession(emp.id, req, days);
      setRefreshCookie(res, req, refresh, days * 86400);
      refreshSet = true;
    }
    await audit(emp.id, 'login-success', req.ip);
    return res.json({
      token,
      expiresAt: new Date(Date.now() + ttlMin * 60000).toISOString(),
      user: { id: emp.id, email: emp.email, rank: emp.rank, dept: emp.dept_name, isAdmin: payload.isAdmin },
      mustChange: emp.must_change_password ?? false,
      refreshSet,
    });
  } catch (err) {
    return next(err);
  }
});

// --- POST /api/auth/refresh (silent auto-login, rotates) ---
router.post('/refresh', async (req, res, next) => {
  try {
    if (rateLimited('auth-refresh', req.ip, 20, LOGIN_WINDOW_MS)) {
      return res.status(429).json({ error: 'too many attempts, try later' });
    }
    const raw = parseCookies(req)[REFRESH_COOKIE];
    if (!raw) return res.status(401).json({ error: 'no session, sign in again' });
    const { rows } = await pool.query(
      `SELECT s.id, s.employee_id, s.last_seen_at, s.revoked_at,
              e.email, e.rank, e.is_active, e.password_version, d.name AS dept_name,
              c.password_hash, c.must_change_password
         FROM auth_refresh_sessions s
         JOIN employees e ON e.id = s.employee_id
         JOIN departments d ON d.id = e.department_id
         LEFT JOIN admin_credentials c ON c.employee_id = e.id
        WHERE s.token_hash = $1`,
      [sha256hex(raw)]
    );
    const s = rows[0];
    if (!s || s.revoked_at || !s.password_hash) {
      // Reuse of an already-rotated token: possible theft → revoke all user sessions.
      if (s?.employee_id) {
        await pool.query(
          'UPDATE auth_refresh_sessions SET revoked_at = now() WHERE employee_id = $1 AND revoked_at IS NULL',
          [s.employee_id]
        );
        await audit(s.employee_id, 'refresh-reuse-revoked', req.ip);
      }
      clearRefreshCookie(res, req);
      return res.status(401).json({ error: 'session expired, sign in again' });
    }
    const days = await getInactivityDays();
    const idleMs = Date.now() - new Date(s.last_seen_at).getTime();
    if (idleMs > days * 86400000 || s.is_active !== true) {
      await pool.query('UPDATE auth_refresh_sessions SET revoked_at = now() WHERE token_hash = $1', [
        sha256hex(raw),
      ]);
      clearRefreshCookie(res, req);
      await audit(s.employee_id, 'session-expired-inactivity', req.ip);
      return res.status(401).json({ error: 'session expired, sign in again' });
    }
    // Rotate: delete old, create new.
    await pool.query('DELETE FROM auth_refresh_sessions WHERE token_hash = $1', [sha256hex(raw)]);
    const refresh = await createRefreshSession(s.employee_id, req, days);
    setRefreshCookie(res, req, refresh, days * 86400);
    const payload = await buildUserPayload(s);
    const ttlMin = await getAccessTtlMin();
    const token = await issueAccessToken(payload, ttlMin);
    return res.json({
      token,
      expiresAt: new Date(Date.now() + ttlMin * 60000).toISOString(),
      user: { id: s.employee_id, email: s.email, rank: s.rank, dept: s.dept_name, isAdmin: payload.isAdmin },
      mustChange: s.must_change_password ?? false,
    });
  } catch (err) {
    return next(err);
  }
});

// --- GET /api/auth/verify ---
router.get('/verify', requireAuth, async (req, res) => {
  return res.json({ user: req.user });
});

// --- GET /api/auth/policy (public: inactivity days for UI messaging) ---
router.get('/policy', async (_req, res, next) => {
  try {
    const { getInactivityDays: days } = await import('./settings.js');
    return res.json({ inactivityDays: await days() });
  } catch (err) {
    return next(err);
  }
});

// --- GET /api/auth/my-ip (prefill for admin setup) ---
router.get('/my-ip', async (req, res) => {
  return res.json({ ip: req.ip });
});

// --- POST /api/auth/change-password ---
router.post('/change-password', requireAuth, async (req, res, next) => {
  try {
    const { oldPassword, newPassword } = req.body || {};
    if (!newPassword || String(newPassword).length < MIN_PASSWORD_LEN || String(newPassword).length > MAX_PASSWORD_LEN) {
      return res.status(400).json({ error: `new password must be ${MIN_PASSWORD_LEN}-${MAX_PASSWORD_LEN} chars` });
    }
    const { rows } = await pool.query(
      'SELECT password_hash FROM admin_credentials WHERE employee_id = $1',
      [req.user.id]
    );
    const hash = rows[0]?.password_hash;
    if (!hash || !(await verifyPassword(String(oldPassword || ''), hash))) {
      return res.status(401).json({ error: 'current password is incorrect' });
    }
    if (String(oldPassword) === String(newPassword)) {
      return res.status(400).json({ error: 'new password must differ from current password' });
    }
    const raw = parseCookies(req)[REFRESH_COOKIE];
    const keepHash = raw ? sha256hex(raw) : null;
    await pool.query(
      'UPDATE admin_credentials SET password_hash = $1, must_change_password = FALSE WHERE employee_id = $2',
      [await hashPassword(String(newPassword)), req.user.id]
    );
    await pool.query('UPDATE employees SET password_version = password_version + 1 WHERE id = $1', [
      req.user.id,
    ]);
    if (keepHash) {
      await pool.query(
        'UPDATE auth_refresh_sessions SET revoked_at = now() WHERE employee_id = $1 AND token_hash <> $2 AND revoked_at IS NULL',
        [req.user.id, keepHash]
      );
    } else {
      await pool.query(
        'UPDATE auth_refresh_sessions SET revoked_at = now() WHERE employee_id = $1 AND revoked_at IS NULL',
        [req.user.id]
      );
    }
    await audit(req.user.id, 'password-change', req.ip);
    const ttlMin = await getAccessTtlMin();
    const emp = await findEmployeeByEmail(req.user.email);
    const token = await issueAccessToken(await buildUserPayload(emp), ttlMin);
    return res.json({ ok: true, token, expiresAt: new Date(Date.now() + ttlMin * 60000).toISOString() });
  } catch (err) {
    return next(err);
  }
});

// --- GET /api/auth/sessions (my devices) ---
router.get('/sessions', requireAuth, async (req, res, next) => {
  try {
    const raw = parseCookies(req)[REFRESH_COOKIE];
    const { rows } = await pool.query(
      `SELECT id, created_at, last_seen_at, ip, user_agent,
              (token_hash = $2) AS current
         FROM auth_refresh_sessions
        WHERE employee_id = $1 AND revoked_at IS NULL AND expires_at > now()
        ORDER BY last_seen_at DESC LIMIT 20`,
      [req.user.id, raw ? sha256hex(raw) : '']
    );
    return res.json(rows);
  } catch (err) {
    return next(err);
  }
});

// --- DELETE /api/auth/sessions (sign out everywhere) ---
router.delete('/sessions', requireAuth, async (req, res, next) => {
  try {
    await pool.query(
      'UPDATE auth_refresh_sessions SET revoked_at = now() WHERE employee_id = $1 AND revoked_at IS NULL',
      [req.user.id]
    );
    clearRefreshCookie(res, req);
    await audit(req.user.id, 'logout-everywhere', req.ip);
    return res.status(204).end();
  } catch (err) {
    return next(err);
  }
});

// --- POST /api/auth/logout (this device) ---
router.post('/logout', async (req, res, next) => {
  try {
    const raw = parseCookies(req)[REFRESH_COOKIE];
    if (raw) {
      await pool.query('UPDATE auth_refresh_sessions SET revoked_at = now() WHERE token_hash = $1', [
        sha256hex(raw),
      ]);
    }
    clearRefreshCookie(res, req);
    return res.status(204).end();
  } catch (err) {
    return next(err);
  }
});

export default router;
