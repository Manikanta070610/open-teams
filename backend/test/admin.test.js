// admin.test.js — Admin API tests. Needs schema 01..09 applied (CI migrates;
// locally point at the disposable cluster per AGENT.md). Creates its own
// rank-6 test owner + test employees and deletes them afterwards, so the
// seed data is left untouched.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';

process.env.SETUP_TOKEN ||= 'local-test-setup-token';

const { default: app, pool } = await import('../src/index.js');
const { _resetLoginAttempts } = await import('../src/admin.js');
const { hashPassword } = await import('../src/crypto.js');

const server = app.listen(0);
await new Promise((resolve) => server.once('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

const OWNER_EMAIL = 'testowner@example.com';
const IT_EMAIL = 'it-admin-test@example.com';
const QA_EMAIL = 'qa-admin-test@example.com';
const PASSWORD = 'Testpass123';
const TEST_DOMAIN = 'acme.test';

async function req(method, path, { token, body } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* 204 / empty */
  }
  return { status: res.status, data };
}

let engDeptId;
let ownerToken;

test('setup: engineering dept id + test owner employee', async () => {
  const d = await pool.query(`SELECT id FROM departments WHERE name = 'Engineering'`);
  engDeptId = d.rows[0].id;
  await pool.query(
    `INSERT INTO employees (first_name, last_name, email, rank, department_id)
     VALUES ('Test', 'Owner', $1, 6, $2)`,
    [OWNER_EMAIL, engDeptId]
  );
});

after(async () => {
  await pool.query(`DELETE FROM allowed_email_domains WHERE domain = $1`, [TEST_DOMAIN]);
  await pool.query(`DELETE FROM employees WHERE email = ANY($1)`, [
    [OWNER_EMAIL, IT_EMAIL, QA_EMAIL],
  ]);
  server.close();
  await pool.end();
});

test('unauthenticated admin request -> 401', async () => {
  const r = await req('GET', '/api/admin/overview');
  assert.equal(r.status, 401);
});

test('bootstrap creates credential; duplicate -> 409', async () => {
  const b = await req('POST', '/api/admin/bootstrap', {
    body: { email: OWNER_EMAIL, password: PASSWORD, setupToken: process.env.SETUP_TOKEN },
  });
  assert.equal(b.status, 201);
  const dup = await req('POST', '/api/admin/bootstrap', {
    body: { email: OWNER_EMAIL, password: PASSWORD, setupToken: process.env.SETUP_TOKEN },
  });
  assert.equal(dup.status, 409);
});

test('bootstrap with wrong setup token -> 403', async () => {
  const r = await req('POST', '/api/admin/bootstrap', {
    body: { email: OWNER_EMAIL, password: PASSWORD, setupToken: 'nope' },
  });
  assert.equal(r.status, 403);
});

test('login: wrong password + unknown email share generic 401', async () => {
  _resetLoginAttempts();
  const bad = await req('POST', '/api/admin/login', {
    body: { email: OWNER_EMAIL, password: 'wrong-pass' },
  });
  assert.equal(bad.status, 401);
  assert.equal(bad.data.error, 'invalid credentials');
  const unknown = await req('POST', '/api/admin/login', {
    body: { email: 'nobody@example.com', password: 'wrong-pass' },
  });
  assert.equal(unknown.status, 401);
  assert.equal(unknown.data.error, 'invalid credentials');
});

test('login rate limit trips after 5 attempts', async () => {
  _resetLoginAttempts();
  for (let i = 0; i < 5; i++) {
    const r = await req('POST', '/api/admin/login', {
      body: { email: OWNER_EMAIL, password: 'wrong-pass' },
    });
    assert.equal(r.status, 401);
  }
  const limited = await req('POST', '/api/admin/login', {
    body: { email: OWNER_EMAIL, password: 'wrong-pass' },
  });
  assert.equal(limited.status, 429);
  _resetLoginAttempts();
});

test('login ok returns token; non-eligible credential -> 403', async () => {
  // L1 employee with a valid password but no admin eligibility.
  await pool.query(
    `INSERT INTO employees (first_name, last_name, email, rank, department_id)
     VALUES ('Low', 'Rank', 'lowrank@example.com', 1, $1)`,
    [engDeptId]
  );
  const l1 = await pool.query(`SELECT id FROM employees WHERE email = 'lowrank@example.com'`);
  await pool.query('INSERT INTO admin_credentials (employee_id, password_hash) VALUES ($1, $2)', [
    l1.rows[0].id,
    await hashPassword(PASSWORD),
  ]);
  const denied = await req('POST', '/api/admin/login', {
    body: { email: 'lowrank@example.com', password: PASSWORD },
  });
  assert.equal(denied.status, 403);
  await pool.query(`DELETE FROM employees WHERE email = 'lowrank@example.com'`);

  const ok = await req('POST', '/api/admin/login', {
    body: { email: OWNER_EMAIL, password: PASSWORD },
  });
  assert.equal(ok.status, 200);
  assert.ok(ok.data.token);
  ownerToken = ok.data.token;
});

test('email domains: list, validate, add, duplicate, delete', async () => {
  const list = await req('GET', '/api/admin/email-domains', { token: ownerToken });
  assert.equal(list.status, 200);
  assert.ok(list.data.some((d) => d.domain === 'example.com'));

  const bad = await req('POST', '/api/admin/email-domains', {
    token: ownerToken,
    body: { domain: 'not a domain!!' },
  });
  assert.equal(bad.status, 400);

  const add = await req('POST', '/api/admin/email-domains', {
    token: ownerToken,
    body: { domain: TEST_DOMAIN },
  });
  assert.equal(add.status, 201);

  const dup = await req('POST', '/api/admin/email-domains', {
    token: ownerToken,
    body: { domain: TEST_DOMAIN },
  });
  assert.equal(dup.status, 409);

  const del = await req('DELETE', `/api/admin/email-domains/${TEST_DOMAIN}`, { token: ownerToken });
  assert.equal(del.status, 204);
  const gone = await req('DELETE', `/api/admin/email-domains/${TEST_DOMAIN}`, { token: ownerToken });
  assert.equal(gone.status, 404);
  // Re-add for the employee tests below.
  await req('POST', '/api/admin/email-domains', { token: ownerToken, body: { domain: TEST_DOMAIN } });
});

test('employees: bad domain rejected, create/rename/paginate', async () => {
  const badDomain = await req('POST', '/api/admin/employees', {
    token: ownerToken,
    body: {
      first_name: 'No',
      last_name: 'Way',
      email: `x@banned-${Date.now()}.test`,
      rank: 2,
      department_id: engDeptId,
    },
  });
  assert.equal(badDomain.status, 400);

  const created = await req('POST', '/api/admin/employees', {
    token: ownerToken,
    body: {
      first_name: 'Qa',
      last_name: 'Tester',
      email: QA_EMAIL,
      rank: 2,
      department_id: engDeptId,
    },
  });
  assert.equal(created.status, 201);

  const renamed = await req('PATCH', `/api/admin/employees/${created.data.id}`, {
    token: ownerToken,
    body: { last_name: 'Renamed' },
  });
  assert.equal(renamed.status, 200);
  assert.equal(renamed.data.last_name, 'Renamed');

  const badRank = await req('PATCH', `/api/admin/employees/${created.data.id}`, {
    token: ownerToken,
    body: { rank: 9 },
  });
  assert.equal(badRank.status, 400);

  const page = await req('GET', '/api/admin/employees?q=Renamed&limit=10&page=1', {
    token: ownerToken,
  });
  assert.equal(page.status, 200);
  assert.ok(page.data.total >= 1);
  assert.ok(page.data.rows.some((e) => e.email === QA_EMAIL));
});

test('deactivated admin loses access immediately', async () => {
  const itDept = await pool.query(`SELECT id FROM departments WHERE name = 'IT'`);
  const created = await req('POST', '/api/admin/employees', {
    token: ownerToken,
    body: {
      first_name: 'It',
      last_name: 'Admin',
      email: IT_EMAIL,
      rank: 3,
      department_id: itDept.rows[0].id,
    },
  });
  assert.equal(created.status, 201);
  const boot = await req('POST', '/api/admin/bootstrap', {
    body: { email: IT_EMAIL, password: PASSWORD, setupToken: process.env.SETUP_TOKEN },
  });
  assert.equal(boot.status, 201);
  const login = await req('POST', '/api/admin/login', {
    body: { email: IT_EMAIL, password: PASSWORD },
  });
  assert.equal(login.status, 200);

  const off = await req('PATCH', `/api/admin/employees/${created.data.id}`, {
    token: ownerToken,
    body: { is_active: false },
  });
  assert.equal(off.status, 200);

  const locked = await req('GET', '/api/admin/overview', { token: login.data.token });
  assert.equal(locked.status, 401);
});

test('expired session rejected; logout revokes', async () => {
  const { sha256hex } = await import('../src/crypto.js');
  const owner = await pool.query(`SELECT id FROM employees WHERE email = $1`, [OWNER_EMAIL]);
  // Short-lived session: proves the expires_at check without racing the clock.
  await pool.query(
    `INSERT INTO admin_sessions (employee_id, token_hash, expires_at)
     VALUES ($1, $2, now() + interval '2 seconds')`,
    [owner.rows[0].id, sha256hex('expired-token-xyz')]
  );
  await new Promise((r) => setTimeout(r, 2500));
  const stale = await req('GET', '/api/admin/overview', { token: 'expired-token-xyz' });
  assert.equal(stale.status, 401);

  const login = await req('POST', '/api/admin/login', {
    body: { email: OWNER_EMAIL, password: PASSWORD },
  });
  assert.equal(login.status, 200);
  const out = await req('POST', '/api/admin/logout', { token: login.data.token });
  assert.equal(out.status, 204);
  const reused = await req('GET', '/api/admin/overview', { token: login.data.token });
  assert.equal(reused.status, 401);
});

test('overview returns totals', async () => {
  const r = await req('GET', '/api/admin/overview', { token: ownerToken });
  assert.equal(r.status, 200);
  assert.ok(r.data.totals.employees >= 7);
  assert.ok(Array.isArray(r.data.byDepartment));
});
