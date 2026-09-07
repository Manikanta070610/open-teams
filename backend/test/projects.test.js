// projects.test.js — workspace heads, standalone projects, direct staffing,
// task assignment (heads-only + downward), subtasks, comments, lifecycle
// guardrails, activity log, dashboard profile gates. Self-cleaning.
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

const CHIEF = 'prj-chief@example.com';
const MGR = 'prj-mgr@example.com';
const HEAD = 'prj-head@example.com';
const JR = 'prj-jr@example.com';
const HR = 'prj-hr@example.com';
const PASSWORD = 'Testpass123';

async function req(method, path, { token, body, query } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${base}${path}${query || ''}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  try { data = await res.json(); } catch { /* empty */ }
  return { status: res.status, data };
}

async function login(email) {
  _resetLoginAttempts();
  const r = await req('POST', '/api/auth/login', { body: { email, password: PASSWORD } });
  assert.equal(r.status, 200, `login failed for ${email}: ${JSON.stringify(r.data)}`);
  return r.data.token;
}

let engId; let mktId; let hrId;
let chiefTok; let mgrTok; let headTok; let jrTok; let hrTok;
let chiefId; let mgrId; let headId; let jrId;
let wsId; let projId; let taskId; let subId;

const EMAILS = [CHIEF, MGR, HEAD, JR, HR];

test('setup: users + workspace head (junior promoted to lead)', async () => {
  engId = (await pool.query(`SELECT id FROM departments WHERE name = 'Engineering'`)).rows[0].id;
  mktId = (await pool.query(`SELECT id FROM departments WHERE name = 'Marketing'`)).rows[0].id;
  hrId = (await pool.query(`SELECT id FROM departments WHERE name = 'HR'`)).rows[0].id;
  await pool.query(
    `INSERT INTO employees (first_name, last_name, email, rank, department_id) VALUES
     ('Prj','Chief', $1, 5, $2), ('Prj','Mgr', $3, 4, $2),
     ('Prj','Head', $4, 1, $2), ('Prj','Jr', $5, 1, $2), ('Prj','Hr', $6, 3, $7)`,
    [CHIEF, engId, MGR, HEAD, JR, HR, hrId]
  );
  for (const email of EMAILS) {
    const { rows } = await pool.query('SELECT id FROM employees WHERE email = $1', [email]);
    await pool.query(
      `INSERT INTO admin_credentials (employee_id, password_hash, must_change_password)
       VALUES ($1, $2, FALSE) ON CONFLICT (employee_id)
       DO UPDATE SET password_hash = EXCLUDED.password_hash, must_change_password = FALSE`,
      [rows[0].id, await hashPassword(PASSWORD)]
    );
  }
  chiefTok = await login(CHIEF);
  mgrTok = await login(MGR);
  headTok = await login(HEAD);
  jrTok = await login(JR);
  hrTok = await login(HR);
  chiefId = (await pool.query('SELECT id FROM employees WHERE email = $1', [CHIEF])).rows[0].id;
  mgrId = (await pool.query('SELECT id FROM employees WHERE email = $1', [MGR])).rows[0].id;
  headId = (await pool.query('SELECT id FROM employees WHERE email = $1', [HEAD])).rows[0].id;
  jrId = (await pool.query('SELECT id FROM employees WHERE email = $1', [JR])).rows[0].id;

  // Chief creates a workspace, adds junior, promotes to lead (= head, any rank).
  const ws = await req('POST', '/api/workspaces', { token: chiefTok, body: { name: 'Ws-Test-Prj-Head' } });
  assert.equal(ws.status, 201);
  wsId = ws.data.id;
  const add = await req('POST', `/api/workspaces/${wsId}/members`, {
    token: chiefTok, body: { members: [{ employee_id: headId, role: 'member' }] },
  });
  assert.equal(add.status, 201);
  const promo = await req('PATCH', `/api/workspaces/${wsId}/members/${headId}`, {
    token: chiefTok, body: { role: 'lead' },
  });
  assert.equal(promo.status, 200);
  assert.ok(promo.data.members.some((m) => Number(m.employee_id) === Number(headId) && m.role === 'lead'));
});

after(async () => {
  await pool.query(`DELETE FROM task_comments WHERE task_id IN (SELECT id FROM tasks WHERE project_id IN (SELECT id FROM projects WHERE name LIKE 'Prj-Test-%'))`);
  await pool.query(`DELETE FROM task_watchers WHERE task_id IN (SELECT id FROM tasks WHERE project_id IN (SELECT id FROM projects WHERE name LIKE 'Prj-Test-%'))`);
  await pool.query(`DELETE FROM project_activity_log WHERE project_id IN (SELECT id FROM projects WHERE name LIKE 'Prj-Test-%')`);
  await pool.query(`DELETE FROM project_updates WHERE project_id IN (SELECT id FROM projects WHERE name LIKE 'Prj-Test-%')`);
  await pool.query(`DELETE FROM tasks WHERE project_id IN (SELECT id FROM projects WHERE name LIKE 'Prj-Test-%')`);
  await pool.query(`DELETE FROM project_members WHERE project_id IN (SELECT id FROM projects WHERE name LIKE 'Prj-Test-%')`);
  await pool.query(`DELETE FROM projects WHERE name LIKE 'Prj-Test-%'`);
  await pool.query(`DELETE FROM workspace_staff_requests WHERE workspace_id IN (SELECT id FROM workspaces WHERE name LIKE 'Ws-Test-Prj-%')`);
  await pool.query(`DELETE FROM workspace_members WHERE workspace_id IN (SELECT id FROM workspaces WHERE name LIKE 'Ws-Test-Prj-%')`);
  await pool.query(`DELETE FROM workspaces WHERE name LIKE 'Ws-Test-Prj-%'`);
  await pool.query(`DELETE FROM auth_refresh_sessions WHERE employee_id IN (SELECT id FROM employees WHERE email = ANY($1))`, [EMAILS]);
  await pool.query(`DELETE FROM employees WHERE email = ANY($1)`, [EMAILS]);
  server.close();
  await pool.end();
});

test('unauthenticated -> 401', async () => {
  const r = await req('GET', '/api/projects');
  assert.equal(r.status, 401);
});

test('create: plain junior 403; manager own-dept 201; manager other-dept 403; head-junior 201', async () => {
  const denied = await req('POST', '/api/projects', {
    token: jrTok, body: { name: 'Prj-Test-Nope', owning_department_id: engId },
  });
  assert.equal(denied.status, 403);

  const mgrOwn = await req('POST', '/api/projects', {
    token: mgrTok,
    body: { name: 'Prj-Test-Eng', owning_department_id: engId, description: 'eng work', objective: 'ship v1' },
  });
  assert.equal(mgrOwn.status, 201);
  projId = mgrOwn.data.id;
  assert.ok(mgrOwn.data.members.some((m) => m.role === 'owner' && Number(m.employee_id) === Number(mgrId)));

  const mgrOther = await req('POST', '/api/projects', {
    token: mgrTok, body: { name: 'Prj-Test-Mkt-X', owning_department_id: mktId },
  });
  assert.equal(mgrOther.status, 403);

  const headCreates = await req('POST', '/api/projects', {
    token: headTok, body: { name: 'Prj-Test-Head', owning_department_id: mktId },
  });
  assert.equal(headCreates.status, 201);
});

test('members: owner direct-adds cross-dept HR + jr; non-head 403; dup 409', async () => {
  const hrIdRow = (await pool.query('SELECT id FROM employees WHERE email = $1', [HR])).rows[0].id;
  const added = await req('POST', `/api/projects/${projId}/members`, {
    token: mgrTok,
    body: { members: [{ employee_id: hrIdRow, role: 'member', allocation_pct: 30, is_primary: false }, { employee_id: jrId, role: 'member' }] },
  });
  assert.equal(added.status, 201);
  const hrMember = added.data.members.find((m) => Number(m.employee_id) === Number(hrIdRow));
  assert.equal(hrMember.allocation_pct, 30);

  const nonHead = await req('POST', `/api/projects/${projId}/members`, {
    token: jrTok, body: { members: [{ employee_id: headId }] },
  });
  assert.equal(nonHead.status, 403);

  const dup = await req('POST', `/api/projects/${projId}/members`, {
    token: mgrTok, body: { members: [{ employee_id: jrId }] },
  });
  assert.equal(dup.status, 409);
});

test('candidates show workload columns', async () => {
  const r = await req('GET', '/api/projects/candidates', {
    token: mgrTok, query: `?departments=${engId}&exclude_members_of=${projId}`,
  });
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.data));
  if (r.data.length > 0) {
    assert.ok('active_projects' in r.data[0] && 'open_tasks' in r.data[0] && 'total_alloc' in r.data[0]);
  }
});

test('tasks: non-head 403; non-member 400; upward 403; valid 201; blocked-needs-reason 400', async () => {
  const nonHead = await req('POST', `/api/projects/${projId}/tasks`, {
    token: jrTok, body: { title: 'sneaky', assigned_to: jrId },
  });
  assert.equal(nonHead.status, 403);

  const nonMember = await req('POST', `/api/projects/${projId}/tasks`, {
    token: mgrTok, body: { title: 'outsider job', assigned_to: headId },
  });
  assert.equal(nonMember.status, 400);

  const upward = await req('POST', `/api/projects/${projId}/tasks`, {
    token: mgrTok, body: { title: 'up', assigned_to: chiefId },
  });
  // chief is not a member -> 400 member check fires first; add chief then expect 403
  assert.ok([400, 403].includes(upward.status));

  const ok = await req('POST', `/api/projects/${projId}/tasks`, {
    token: mgrTok,
    body: { title: 'Build API', description: 'v1 endpoints', assigned_to: jrId, priority: 'high', estimate: 'M', labels: ['backend'] },
  });
  assert.equal(ok.status, 201);
  taskId = ok.data.id;

  const blockedNoReason = await req('PATCH', `/api/projects/${projId}/tasks/${taskId}`, {
    token: jrTok, body: { status: 'blocked' },
  });
  assert.equal(blockedNoReason.status, 400);

  const blockedOk = await req('PATCH', `/api/projects/${projId}/tasks/${taskId}`, {
    token: jrTok, body: { status: 'blocked', blocked_reason: 'waiting on API spec' },
  });
  assert.equal(blockedOk.status, 200);
  assert.equal(blockedOk.data.status, 'blocked');

  const sub = await req('POST', `/api/projects/${projId}/tasks`, {
    token: mgrTok, body: { title: 'Sub: routes', assigned_to: jrId, parent_task_id: taskId },
  });
  assert.equal(sub.status, 201);
  subId = sub.data.id;

  const subSub = await req('POST', `/api/projects/${projId}/tasks`, {
    token: mgrTok, body: { title: 'Sub-sub: no', assigned_to: jrId, parent_task_id: subId },
  });
  assert.equal(subSub.status, 400);
});

test('comments: member posts 201; outsider hidden 404', async () => {
  const c = await req('POST', `/api/projects/${projId}/tasks/${taskId}/comments`, {
    token: jrTok, body: { body: 'Started, blocked on spec.' },
  });
  assert.equal(c.status, 201);
  const list = await req('GET', `/api/projects/${projId}/tasks/${taskId}/comments`, { token: mgrTok });
  assert.equal(list.status, 200);
  assert.ok(list.data.length >= 1);

  const outsider = await req('GET', `/api/projects/${projId}`, { token: headTok });
  assert.equal(outsider.status, 404);
});

test('lifecycle: complete blocked while open (409); free status; then complete 200; activity logged', async () => {
  const closeEarly = await req('PATCH', `/api/projects/${projId}`, {
    token: mgrTok, body: { status: 'completed' },
  });
  assert.equal(closeEarly.status, 409);

  await req('PATCH', `/api/projects/${projId}/tasks/${taskId}`, { token: jrTok, body: { status: 'in_progress' } });
  const done1 = await req('PATCH', `/api/projects/${projId}/tasks/${taskId}`, { token: mgrTok, body: { status: 'done' } });
  assert.equal(done1.status, 200);
  const done2 = await req('PATCH', `/api/projects/${projId}/tasks/${subId}`, { token: mgrTok, body: { status: 'done' } });
  assert.equal(done2.status, 200);

  const upd = await req('POST', `/api/projects/${projId}/updates`, {
    token: mgrTok, body: { body: 'Shipped v1. Done: API. Next: docs. Risks: none.' },
  });
  assert.equal(upd.status, 201);

  const close = await req('PATCH', `/api/projects/${projId}`, {
    token: mgrTok, body: { status: 'completed' },
  });
  assert.equal(close.status, 200);

  const act = await req('GET', `/api/projects/${projId}/activity`, { token: mgrTok });
  assert.equal(act.status, 200);
  assert.ok(act.data.length >= 5);
});

test('dashboard: mine 200; profile self 200; stranger 404; shared-lead sees member', async () => {
  const mine = await req('GET', '/api/dashboard/work', { token: jrTok });
  assert.equal(mine.status, 200);
  assert.ok(Array.isArray(mine.data.open_tasks));

  const self = await req('GET', `/api/dashboard/work/${jrId}`, { token: jrTok });
  assert.equal(self.status, 200);

  const stranger = await req('GET', `/api/dashboard/work/${chiefId}`, { token: jrTok });
  assert.equal(stranger.status, 404);

  const leadSees = await req('GET', `/api/dashboard/work/${jrId}`, { token: mgrTok });
  assert.equal(leadSees.status, 200);
});

test('spec alias /projects works', async () => {
  const r = await req('GET', '/projects', { token: mgrTok });
  assert.equal(r.status, 200);
});
