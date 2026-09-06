// workspaces.test.js — Tasks 5/6: POST /workspaces (owner link),
// GET /workspaces + GET /workspaces/:id (members only), plus HR staffing
// (existing staff, allocation, pending_hiring). Self-cleaning.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';

process.env.SETUP_TOKEN ||= 'local-test-setup-token';
process.env.AUTH_SECRET ||=
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

const { default: app, pool } = await import('../src/index.js');
const { _resetLoginAttempts } = await import('../src/admin.js');
const { hashPassword } = await import('../src/crypto.js');

const server = app.listen(0);
await new Promise((resolve) => server.once('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

const CHIEF_EMAIL = 'ws-chief@example.com';
const HR_EMAIL = 'ws-hr@example.com';
const JR_EMAIL = 'ws-jr@example.com';
const OUTSIDER_EMAIL = 'ws-outsider@example.com';
const PASSWORD = 'Testpass123';

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
  } catch { /* empty */ }
  return { status: res.status, data };
}

async function login(email) {
  _resetLoginAttempts();
  const r = await req('POST', '/api/auth/login', { body: { email, password: PASSWORD } });
  assert.equal(r.status, 200, `login failed for ${email}: ${JSON.stringify(r.data)}`);
  return r.data.token;
}

let engDeptId;
let hrDeptId;
let chiefToken;
let hrToken;
let jrToken;
let outsiderToken;
let wsId;
let jrId;

test('setup: chief + HR + junior + outsider with passwords', async () => {
  engDeptId = (await pool.query(`SELECT id FROM departments WHERE name = 'Engineering'`)).rows[0].id;
  hrDeptId = (await pool.query(`SELECT id FROM departments WHERE name = 'HR'`)).rows[0].id;
  await pool.query(
    `INSERT INTO employees (first_name, last_name, email, rank, department_id) VALUES
     ('Ws', 'Chief', $1, 5, $2), ('Ws', 'Hr', $3, 3, $4),
     ('Ws', 'Jr', $5, 1, $2), ('Ws', 'Out', $6, 2, $2)`,
    [CHIEF_EMAIL, engDeptId, HR_EMAIL, hrDeptId, JR_EMAIL, OUTSIDER_EMAIL]
  );
  for (const email of [CHIEF_EMAIL, HR_EMAIL, JR_EMAIL, OUTSIDER_EMAIL]) {
    const { rows } = await pool.query('SELECT id FROM employees WHERE email = $1', [email]);
    await pool.query(
      `INSERT INTO admin_credentials (employee_id, password_hash, must_change_password)
       VALUES ($1, $2, FALSE) ON CONFLICT (employee_id)
       DO UPDATE SET password_hash = EXCLUDED.password_hash, must_change_password = FALSE`,
      [rows[0].id, await hashPassword(PASSWORD)]
    );
  }
  chiefToken = await login(CHIEF_EMAIL);
  hrToken = await login(HR_EMAIL);
  jrToken = await login(JR_EMAIL);
  outsiderToken = await login(OUTSIDER_EMAIL);
  jrId = (await pool.query('SELECT id FROM employees WHERE email = $1', [JR_EMAIL])).rows[0].id;
});

after(async () => {
  await pool.query('DELETE FROM workspace_staff_requests WHERE workspace_id IN (SELECT id FROM workspaces WHERE name LIKE $1)', ['Ws-Test-%']);
  await pool.query('DELETE FROM workspace_members WHERE workspace_id IN (SELECT id FROM workspaces WHERE name LIKE $1)', ['Ws-Test-%']);
  await pool.query('DELETE FROM workspaces WHERE name LIKE $1', ['Ws-Test-%']);
  await pool.query(
    'DELETE FROM auth_refresh_sessions WHERE employee_id IN (SELECT id FROM employees WHERE email = ANY($1))',
    [[CHIEF_EMAIL, HR_EMAIL, JR_EMAIL, OUTSIDER_EMAIL]]
  );
  await pool.query('DELETE FROM employees WHERE email = ANY($1)', [
    [CHIEF_EMAIL, HR_EMAIL, JR_EMAIL, OUTSIDER_EMAIL],
  ]);
  server.close();
  await pool.end();
});

test('unauthenticated -> 401', async () => {
  const r = await req('GET', '/api/workspaces');
  assert.equal(r.status, 401);
});

test('junior cannot create (403); chief creates + owner linked (201)', async () => {
  const denied = await req('POST', '/api/workspaces', {
    token: jrToken,
    body: { name: 'Ws-Test-Denied' },
  });
  assert.equal(denied.status, 403);

  const created = await req('POST', '/api/workspaces', {
    token: chiefToken,
    body: { name: 'Ws-Test-Eng', description: 'eng floor' },
  });
  assert.equal(created.status, 201);
  wsId = created.data.id;
  assert.ok(wsId);
  assert.ok(created.data.members.some((m) => m.role === 'owner' && Number(m.employee_id) === Number(created.data.created_by)));
});

test('duplicate name -> 409; missing name -> 400', async () => {
  const dup = await req('POST', '/api/workspaces', {
    token: chiefToken,
    body: { name: 'Ws-Test-Eng' },
  });
  assert.equal(dup.status, 409);
  const bad = await req('POST', '/api/workspaces', { token: chiefToken, body: {} });
  assert.equal(bad.status, 400);
});

test('list is members-only; detail hidden from outsiders', async () => {
  const mine = await req('GET', '/api/workspaces', { token: chiefToken });
  assert.equal(mine.status, 200);
  assert.ok(mine.data.some((w) => Number(w.id) === Number(wsId)));

  const outsiderList = await req('GET', '/api/workspaces', { token: outsiderToken });
  assert.equal(outsiderList.status, 200);
  assert.ok(!outsiderList.data.some((w) => Number(w.id) === Number(wsId)));

  const forbidden = await req('GET', `/api/workspaces/${wsId}`, { token: outsiderToken });
  assert.equal(forbidden.status, 404);

  const detail = await req('GET', `/api/workspaces/${wsId}`, { token: chiefToken });
  assert.equal(detail.status, 200);
  assert.equal(detail.data.members.length, 1);
});

test('staff request with priority; HR staffs existing Jr part-time; Jr sees workspace', async () => {
  const sr = await req('POST', `/api/workspaces/${wsId}/staff-requests`, {
    token: chiefToken,
    body: { requirements: 'need junior help', headcount: 1, ranks_needed: [1], priority: 'high' },
  });
  assert.equal(sr.status, 201);
  assert.equal(sr.data.priority, 'high');

  const cands = await req('GET', '/api/workspaces/candidates?ranks=1', { token: hrToken });
  assert.equal(cands.status, 200);
  assert.ok(cands.data.some((e) => Number(e.id) === Number(jrId)));

  // Junior (non-HR) cannot staff.
  const jrStaff = await req('POST', `/api/workspaces/${wsId}/members`, {
    token: jrToken,
    body: { members: [{ employee_id: jrId }] },
  });
  assert.ok([403, 404].includes(jrStaff.status));

  const staffed = await req('POST', `/api/workspaces/${wsId}/members`, {
    token: chiefToken,
    body: {
      request_id: sr.data.id,
      members: [{ employee_id: jrId, role: 'member', allocation_pct: 50, is_primary: false }],
    },
  });
  assert.equal(staffed.status, 201);
  const jrMember = staffed.data.members.find((m) => Number(m.employee_id) === Number(jrId));
  assert.equal(jrMember.allocation_pct, 50);
  assert.equal(jrMember.is_primary, false);

  const jrList = await req('GET', '/api/workspaces', { token: jrToken });
  assert.ok(jrList.data.some((w) => Number(w.id) === Number(wsId)));
});

test('inactive employee rejected; pending_hiring when nobody fits', async () => {
  const outId = (await pool.query('SELECT id FROM employees WHERE email = $1', [OUTSIDER_EMAIL])).rows[0].id;
  await pool.query('UPDATE employees SET is_active = FALSE WHERE id = $1', [outId]);
  const bad = await req('POST', `/api/workspaces/${wsId}/members`, {
    token: chiefToken,
    body: { members: [{ employee_id: outId }] },
  });
  assert.equal(bad.status, 400);
  await pool.query('UPDATE employees SET is_active = TRUE WHERE id = $1', [outId]);

  const sr = await req('POST', `/api/workspaces/${wsId}/staff-requests`, {
    token: chiefToken,
    body: { headcount: 2, ranks_needed: [6], priority: 'urgent' },
  });
  assert.equal(sr.status, 201);
  const pend = await req('POST', `/api/workspaces/${wsId}/members`, {
    token: chiefToken,
    body: { request_id: sr.data.id, members: [], pending_hiring: true },
  });
  assert.equal(pend.status, 200);
  assert.ok(pend.data.staff_requests.some((r) => Number(r.id) === Number(sr.data.id) && r.status === 'pending_hiring'));
});

test('spec alias /workspaces works', async () => {
  const r = await req('GET', '/workspaces', { token: chiefToken });
  assert.equal(r.status, 200);
  assert.ok(r.data.some((w) => Number(w.id) === Number(wsId)));
});

test('HR non-member can view detail and staff (they are usually not members yet)', async () => {
  const created = await req('POST', '/api/workspaces', {
    token: chiefToken,
    body: { name: 'Ws-Test-HR-Flow' },
  });
  assert.equal(created.status, 201);
  const hrWsId = created.data.id;

  const hrList = await req('GET', '/api/workspaces', { token: hrToken });
  assert.equal(hrList.status, 200);
  assert.ok(!hrList.data.some((w) => Number(w.id) === Number(hrWsId)));

  const hrDetail = await req('GET', `/api/workspaces/${hrWsId}`, { token: hrToken });
  assert.equal(hrDetail.status, 200);

  const outId = (await pool.query('SELECT id FROM employees WHERE email = $1', [OUTSIDER_EMAIL])).rows[0].id;
  const staffed = await req('POST', `/api/workspaces/${hrWsId}/members`, {
    token: hrToken,
    body: { members: [{ employee_id: outId, role: 'member', allocation_pct: 100 }] },
  });
  assert.equal(staffed.status, 201);
});
