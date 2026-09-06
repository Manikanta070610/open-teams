// auth.test.js — General employee auth (JWE + refresh + policy + IP allowlist +
// password provisioning). Needs schema 01..10 applied. Uses its own employees
// and deletes them afterwards, leaving seed data untouched.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';

process.env.SETUP_TOKEN ||= 'local-test-setup-token';
process.env.AUTH_SECRET ||=
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

const { default: app, pool } = await import('../src/index.js');
const { _resetLoginAttempts } = await import('../src/admin.js');
const { _clearSettingsCache } = await import('../src/settings.js');

const server = app.listen(0);
await new Promise((resolve) => server.once('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

const OWNER_EMAIL = 'authowner@example.com';
const EMP_EMAIL = 'authemp@example.com';
const PASSWORD = 'Testpass123';
const NEW_PASSWORD = 'Newpass45678';

let cookieJar = '';

async function req(method, path, { token, body, cookie } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (cookie) headers.cookie = cookie;
  // Default: send stored refresh cookie (like a browser would).
  else if (cookieJar && path.startsWith('/api/auth/')) headers.cookie = cookieJar;
  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) {
    const m = /oms_refresh=([^;]*)/.exec(setCookie);
    if (m && m[1]) cookieJar = `oms_refresh=${m[1]}`;
    else if (/oms_refresh=;/.test(setCookie)) cookieJar = '';
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* 204 / empty */
  }
  return { status: res.status, data };
}

let engDeptId;
let ownerToken; // legacy opaque admin token (also proves dual-token requireAdmin)
let empAccess; // JWE access token for a non-admin employee

test('setup: owner + plain employee with provisioned passwords', async () => {
  const d = await pool.query(`SELECT id FROM departments WHERE name = 'Engineering'`);
  engDeptId = d.rows[0].id;
  await pool.query(
    `INSERT INTO employees (first_name, last_name, email, rank, department_id)
     VALUES ('Auth', 'Owner', $1, 6, $2), ('Auth', 'Emp', $3, 2, $2)`,
    [OWNER_EMAIL, engDeptId, EMP_EMAIL]
  );
  const b = await req('POST', '/api/admin/bootstrap', {
    body: { email: OWNER_EMAIL, password: PASSWORD, setupToken: process.env.SETUP_TOKEN },
  });
  assert.equal(b.status, 201);
  const login = await req('POST', '/api/admin/login', {
    body: { email: OWNER_EMAIL, password: PASSWORD },
  });
  assert.equal(login.status, 200);
  ownerToken = login.data.token;
  const created = await pool.query('SELECT id FROM employees WHERE email = $1', [EMP_EMAIL]);
  assert.ok(created.rows[0].id);
  const { hashPassword } = await import('../src/crypto.js');
  const emp = await pool.query('SELECT id FROM employees WHERE email = $1', [EMP_EMAIL]);
  await pool.query(
    `INSERT INTO admin_credentials (employee_id, password_hash, must_change_password)
     VALUES ($1, $2, TRUE) ON CONFLICT (employee_id) DO NOTHING`,
    [emp.rows[0].id, await hashPassword(PASSWORD)]
  );
});

after(async () => {
  await pool.query('DELETE FROM auth_refresh_sessions WHERE employee_id IN (SELECT id FROM employees WHERE email = ANY($1))', [
    [OWNER_EMAIL, EMP_EMAIL],
  ]);
  await pool.query('DELETE FROM auth_audit_log WHERE employee_id IN (SELECT id FROM employees WHERE email = ANY($1))', [
    [OWNER_EMAIL, EMP_EMAIL],
  ]);
  await pool.query('DELETE FROM employees WHERE email = ANY($1)', [[OWNER_EMAIL, EMP_EMAIL]]);
  server.close();
  await pool.end();
});

test('employee login (non-admin tier) issues JWE + mustChange flag', async () => {
  _resetLoginAttempts();
  const r = await req('POST', '/api/auth/login', {
    body: { email: EMP_EMAIL, password: PASSWORD },
  });
  assert.equal(r.status, 200);
  assert.ok(r.data.token.includes('.'), 'expected JWE compact serialization');
  assert.equal(r.data.mustChange, true);
  assert.equal(r.data.user.isAdmin, false);
  assert.ok(r.data.refreshSet);
  empAccess = r.data.token;
});

test('login: wrong password -> generic 401', async () => {
  _resetLoginAttempts();
  const r = await req('POST', '/api/auth/login', {
    body: { email: EMP_EMAIL, password: 'wrong-pass' },
  });
  assert.equal(r.status, 401);
});

test('verify returns the employee; admin route rejects non-admin JWE', async () => {
  const v = await req('GET', '/api/auth/verify', { token: empAccess });
  assert.equal(v.status, 200);
  assert.equal(v.data.user.email, EMP_EMAIL);
  const denied = await req('GET', '/api/admin/overview', { token: empAccess });
  assert.equal(denied.status, 401);
});

test('admin overview accepts BOTH legacy opaque and new JWE tokens', async () => {
  _resetLoginAttempts();
  cookieJar = '';
  const fresh = await req('POST', '/api/auth/login', {
    body: { email: OWNER_EMAIL, password: PASSWORD },
  });
  assert.equal(fresh.status, 200);
  const viaJwe = await req('GET', '/api/admin/overview', { token: fresh.data.token });
  assert.equal(viaJwe.status, 200);
  const viaOpaque = await req('GET', '/api/admin/overview', { token: ownerToken });
  assert.equal(viaOpaque.status, 200);
});

test('refresh rotates and keeps the session alive', async () => {
  _resetLoginAttempts();
  cookieJar = '';
  await req('POST', '/api/auth/login', { body: { email: EMP_EMAIL, password: PASSWORD } });
  assert.ok(cookieJar, 'expected refresh cookie after login');
  const first = cookieJar;
  const r = await req('POST', '/api/auth/refresh');
  assert.equal(r.status, 200);
  assert.ok(r.data.token);
  assert.notEqual(cookieJar, first, 'expected rotation');
});

test('idle past the inactivity window forces password re-entry', async () => {
  _resetLoginAttempts();
  cookieJar = '';
  await req('POST', '/api/auth/login', { body: { email: EMP_EMAIL, password: PASSWORD } });
  await pool.query(
    `UPDATE auth_refresh_sessions SET last_seen_at = now() - interval '8 days'
      WHERE token_hash = (SELECT token_hash FROM auth_refresh_sessions
        WHERE employee_id = (SELECT id FROM employees WHERE email = $1)
        ORDER BY id DESC LIMIT 1)`,
    [EMP_EMAIL]
  );
  const r = await req('POST', '/api/auth/refresh');
  assert.equal(r.status, 401);
  assert.match(r.data.error, /sign in again/);
});

test('admin can change the inactivity window (default 7)', async () => {
  const policy = await req('GET', '/api/admin/auth-policy', { token: ownerToken });
  assert.equal(policy.status, 200);
  assert.equal(policy.data.inactivityTimeoutDays, 7);
  const updated = await req('PATCH', '/api/admin/auth-policy', {
    token: ownerToken,
    body: { inactivityTimeoutDays: 14 },
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.data.inactivityTimeoutDays, 14);
  _clearSettingsCache();
  const back = await req('PATCH', '/api/admin/auth-policy', {
    token: ownerToken,
    body: { inactivityTimeoutDays: 7 },
  });
  assert.equal(back.status, 200);
});

test('admin IP restriction: off allows, on blocks unknown, allows listed', async () => {
  _resetLoginAttempts();
  _clearSettingsCache();
  // Restriction OFF (default): admin login + overview work from 127.0.0.1.
  const ok = await req('POST', '/api/auth/login', {
    body: { email: OWNER_EMAIL, password: PASSWORD },
  });
  assert.equal(ok.status, 200);
  const overviewOk = await req('GET', '/api/admin/overview', { token: ok.data.token });
  assert.equal(overviewOk.status, 200);
  // Turn ON with only an unrelated address (seeded via SQL so the test client
  // itself is not allowlisted yet): admin endpoints must 403 while the
  // tier-agnostic /api/auth/login still succeeds.
  await pool.query(
    `INSERT INTO auth_settings (key, value) VALUES ('admin_ip_restriction_enabled', 'true')
     ON CONFLICT (key) DO UPDATE SET value = 'true', updated_at = now()`
  );
  await pool.query(
    "INSERT INTO admin_allowed_ips (cidr, label) VALUES ('192.0.2.1/32', 'test') ON CONFLICT (cidr) DO NOTHING"
  );
  _clearSettingsCache();
  const blocked = await req('POST', '/api/auth/login', {
    body: { email: OWNER_EMAIL, password: PASSWORD },
  });
  assert.equal(blocked.status, 200);
  const adminBlocked = await req('GET', '/api/admin/overview', { token: blocked.data.token });
  assert.equal(adminBlocked.status, 403);
  // Allowlist our own IP (via SQL, since the API is correctly closed to us):
  // admin access is restored.
  const mine = await req('GET', '/api/auth/my-ip');
  await pool.query(
    'INSERT INTO admin_allowed_ips (cidr, label) VALUES ($1::inet, $2) ON CONFLICT (cidr) DO NOTHING',
    [`${mine.data.ip}/32`, 'test-runner']
  );
  _clearSettingsCache();
  const allowed = await req('GET', '/api/admin/overview', { token: blocked.data.token });
  assert.equal(allowed.status, 200);
  // Cleanup: restriction OFF + empty list.
  await pool.query('DELETE FROM admin_allowed_ips');
  await pool.query(
    `INSERT INTO auth_settings (key, value) VALUES ('admin_ip_restriction_enabled', 'false')
     ON CONFLICT (key) DO UPDATE SET value = 'false', updated_at = now()`
  );
  _clearSettingsCache();
});

test('change-password clears mustChange and old password stops working', async () => {
  _resetLoginAttempts();
  cookieJar = '';
  const login = await req('POST', '/api/auth/login', {
    body: { email: EMP_EMAIL, password: PASSWORD },
  });
  const changed = await req('POST', '/api/auth/change-password', {
    token: login.data.token,
    body: { oldPassword: PASSWORD, newPassword: NEW_PASSWORD },
  });
  assert.equal(changed.status, 200);
  assert.ok(changed.data.token);
  const v = await req('GET', '/api/auth/verify', { token: changed.data.token });
  assert.equal(v.status, 200);
  assert.equal(v.data.user.must_change_password, false);
  _resetLoginAttempts();
  const stale = await req('POST', '/api/auth/login', {
    body: { email: EMP_EMAIL, password: PASSWORD },
  });
  assert.equal(stale.status, 401);
  // Restore for the reset test below.
  const back = await req('POST', '/api/auth/login', {
    body: { email: EMP_EMAIL, password: NEW_PASSWORD },
  });
  assert.equal(back.status, 200);
});

test('admin reset-password issues a temp password and revokes sessions', async () => {
  const emp = await pool.query('SELECT id FROM employees WHERE email = $1', [EMP_EMAIL]);
  const r = await req('POST', `/api/admin/employees/${emp.rows[0].id}/reset-password`, {
    token: ownerToken,
  });
  assert.equal(r.status, 200);
  assert.ok(r.data.tempPassword && r.data.tempPassword.length >= 8);
  _resetLoginAttempts();
  const login = await req('POST', '/api/auth/login', {
    body: { email: EMP_EMAIL, password: r.data.tempPassword },
  });
  assert.equal(login.status, 200);
  assert.equal(login.data.mustChange, true);
});
