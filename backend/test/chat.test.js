// chat.test.js — company-wide chat on the db/04 tables: group visibility,
// membership management, group chat, 1-1 DMs, read receipts. Self-cleaning.
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

const CHIEF = 'cht-chief@example.com';
const JR1 = 'cht-jr1@example.com';
const JR2 = 'cht-jr2@example.com';
const MKT = 'cht-mkt@example.com';
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
  try { data = await res.json(); } catch { /* empty */ }
  return { status: res.status, data };
}

async function login(email) {
  _resetLoginAttempts();
  const r = await req('POST', '/api/auth/login', { body: { email, password: PASSWORD } });
  assert.equal(r.status, 200, `login failed for ${email}: ${JSON.stringify(r.data)}`);
  return r.data.token;
}

let engId; let mktId;
let chiefTok; let jr1Tok; let jr2Tok; let mktTok;
let chiefId; let jr1Id; let jr2Id;
let privId; let pubId; let deptId;
const dmIds = [];

const EMAILS = [CHIEF, JR1, JR2, MKT];

test('setup: users in two departments', async () => {
  engId = (await pool.query(`SELECT id FROM departments WHERE name = 'Engineering'`)).rows[0].id;
  mktId = (await pool.query(`SELECT id FROM departments WHERE name = 'Marketing'`)).rows[0].id;
  await pool.query(
    `INSERT INTO employees (first_name, last_name, email, rank, department_id) VALUES
     ('Cht','Chief', $1, 5, $2), ('Cht','Jr1', $3, 1, $2),
     ('Cht','Jr2', $4, 1, $2), ('Cht','Mkt', $5, 1, $6)`,
    [CHIEF, engId, JR1, JR2, MKT, mktId]
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
  jr1Tok = await login(JR1);
  jr2Tok = await login(JR2);
  mktTok = await login(MKT);
  chiefId = (await pool.query('SELECT id FROM employees WHERE email = $1', [CHIEF])).rows[0].id;
  jr1Id = (await pool.query('SELECT id FROM employees WHERE email = $1', [JR1])).rows[0].id;
  jr2Id = (await pool.query('SELECT id FROM employees WHERE email = $1', [JR2])).rows[0].id;
});

after(async () => {
  const grp = `SELECT id FROM app_groups WHERE name LIKE 'Cht-Test-%'`;
  const convs = `SELECT id FROM conversations WHERE group_id IN (${grp}) OR id = ANY($1::bigint[])`;
  await pool.query(`DELETE FROM messages WHERE conversation_id IN (${convs})`, [dmIds]);
  await pool.query(`DELETE FROM conversation_participants WHERE conversation_id IN (${convs})`, [dmIds]);
  await pool.query(`DELETE FROM conversations WHERE group_id IN (${grp}) OR id = ANY($1::bigint[])`, [dmIds]);
  await pool.query(`DELETE FROM group_memberships WHERE group_id IN (${grp})`);
  await pool.query(`DELETE FROM app_groups WHERE name LIKE 'Cht-Test-%'`);
  await pool.query(`DELETE FROM auth_refresh_sessions WHERE employee_id IN (SELECT id FROM employees WHERE email = ANY($1))`, [EMAILS]);
  await pool.query(`DELETE FROM employees WHERE email = ANY($1)`, [EMAILS]);
  server.close();
  await pool.end();
});

test('unauthenticated -> 401', async () => {
  assert.equal((await req('GET', '/api/chat/groups')).status, 401);
  assert.equal((await req('GET', '/api/chat/conversations')).status, 401);
});

test('private group: hidden from outsiders, visible to members', async () => {
  const mk = await req('POST', '/api/chat/groups', {
    token: chiefTok, body: { name: 'Cht-Test-Priv', visibility: 'private' },
  });
  assert.equal(mk.status, 201);
  privId = mk.data.id;
  assert.ok(mk.data.members.some((m) => Number(m.id) === Number(chiefId) && m.role === 'owner'));

  const outList = await req('GET', '/api/chat/groups', { token: jr1Tok });
  assert.equal(outList.status, 200);
  assert.ok(!outList.data.some((g) => Number(g.id) === Number(privId)));
  assert.equal((await req('GET', `/api/chat/groups/${privId}`, { token: jr1Tok })).status, 404);
  assert.equal((await req('GET', `/api/chat/groups/${privId}/chat`, { token: jr1Tok })).status, 404);
  assert.equal((await req('POST', `/api/chat/groups/${privId}/chat`, { token: jr1Tok, body: { body: 'sneak' } })).status, 404);
});

test('public group: listed, joined, and chatted by anyone', async () => {
  const mk = await req('POST', '/api/chat/groups', {
    token: jr1Tok, body: { name: 'Cht-Test-Pub', description: 'open room', visibility: 'public' },
  });
  assert.equal(mk.status, 201);
  pubId = mk.data.id;

  const list = await req('GET', '/api/chat/groups', { token: jr2Tok });
  assert.ok(list.data.some((g) => Number(g.id) === Number(pubId)));
  const join = await req('POST', `/api/chat/groups/${pubId}/join`, { token: jr2Tok });
  assert.ok([200, 201].includes(join.status));
  const post = await req('POST', `/api/chat/groups/${pubId}/chat`, {
    token: jr2Tok, body: { body: 'hello everyone' },
  });
  assert.equal(post.status, 201);
  const read = await req('GET', `/api/chat/groups/${pubId}/chat`, { token: jr1Tok });
  assert.equal(read.status, 200);
  assert.ok(read.data.messages.some((m) => m.body === 'hello everyone'));
  const empty = await req('POST', `/api/chat/groups/${pubId}/chat`, {
    token: jr1Tok, body: { body: '   ' },
  });
  assert.equal(empty.status, 400);
});

test('department group: same-dept sees, other-dept hidden', async () => {
  const mk = await req('POST', '/api/chat/groups', {
    token: chiefTok, body: { name: 'Cht-Test-Eng', visibility: 'department', department_id: engId },
  });
  assert.equal(mk.status, 201);
  deptId = mk.data.id;
  const same = await req('GET', '/api/chat/groups', { token: jr1Tok });
  assert.ok(same.data.some((g) => Number(g.id) === Number(deptId)));
  const other = await req('GET', '/api/chat/groups', { token: mktTok });
  assert.ok(!other.data.some((g) => Number(g.id) === Number(deptId)));
  assert.equal((await req('GET', `/api/chat/groups/${deptId}`, { token: mktTok })).status, 404);
  const cross = await req('POST', '/api/chat/groups', {
    token: jr1Tok, body: { name: 'Cht-Test-Nope', visibility: 'department', department_id: mktId },
  });
  assert.equal(cross.status, 403);
});

test('membership: manager adds, plain member 403, last owner protected', async () => {
  const add = await req('POST', `/api/chat/groups/${privId}/members`, {
    token: chiefTok, body: { employee_ids: [jr1Id] },
  });
  assert.equal(add.status, 201);
  assert.ok(add.data.members.some((m) => Number(m.id) === Number(jr1Id)));

  const jrAdds = await req('POST', `/api/chat/groups/${privId}/members`, {
    token: jr1Tok, body: { employee_ids: [jr2Id] },
  });
  assert.equal(jrAdds.status, 403);

  const rmOwner = await req('DELETE', `/api/chat/groups/${privId}/members/${chiefId}`, { token: chiefTok });
  assert.equal(rmOwner.status, 409);

  const leave = await req('DELETE', `/api/chat/groups/${privId}/members/${jr1Id}`, { token: jr1Tok });
  assert.equal(leave.status, 200);
  assert.ok(!leave.data.members.some((m) => Number(m.id) === Number(jr1Id)));
});

test('DMs: create, dedupe, send, unread clears on read, third party blocked', async () => {
  const dm = await req('POST', '/api/chat/conversations/direct', {
    token: jr1Tok, body: { employee_id: jr2Id },
  });
  assert.equal(dm.status, 201);
  dmIds.push(dm.data.id);

  const dup = await req('POST', '/api/chat/conversations/direct', {
    token: jr2Tok, body: { employee_id: jr1Id },
  });
  assert.equal(dup.status, 200);
  assert.equal(dup.data.reused, true);
  assert.equal(Number(dup.data.id), Number(dm.data.id));

  const send = await req('POST', `/api/chat/conversations/${dm.data.id}/messages`, {
    token: jr1Tok, body: { body: 'hey jr2' },
  });
  assert.equal(send.status, 201);

  const before = await req('GET', '/api/chat/conversations', { token: jr2Tok });
  const entry = before.data.find((c) => Number(c.id) === Number(dm.data.id));
  assert.ok(entry && entry.unread_count >= 1);

  const read = await req('GET', `/api/chat/conversations/${dm.data.id}/messages`, { token: jr2Tok });
  assert.equal(read.status, 200);
  assert.ok(read.data.messages.some((m) => m.body === 'hey jr2'));

  const afterRead = await req('GET', '/api/chat/conversations', { token: jr2Tok });
  assert.equal(afterRead.data.find((c) => Number(c.id) === Number(dm.data.id)).unread_count, 0);

  assert.equal((await req('GET', `/api/chat/conversations/${dm.data.id}/messages`, { token: mktTok })).status, 404);
  assert.equal((await req('POST', '/api/chat/conversations/direct', { token: jr1Tok, body: { employee_id: jr1Id } })).status, 400);
  assert.equal((await req('POST', '/api/chat/conversations/direct', { token: jr1Tok, body: { employee_id: 999999 } })).status, 400);
});

test('delete: non-owner 403, owner 200 with chat gone', async () => {
  const mk = await req('POST', '/api/chat/groups', {
    token: jr1Tok, body: { name: 'Cht-Test-Del', visibility: 'private' },
  });
  assert.equal(mk.status, 201);
  const delId = mk.data.id;
  assert.equal((await req('DELETE', `/api/chat/groups/${delId}`, { token: jr2Tok })).status, 403);
  assert.equal((await req('DELETE', `/api/chat/groups/${delId}`, { token: jr1Tok })).status, 200);
  assert.equal((await req('GET', `/api/chat/groups/${delId}`, { token: jr1Tok })).status, 404);
});

test('spec alias /chat works', async () => {
  const r = await req('GET', '/chat/groups', { token: jr1Tok });
  assert.equal(r.status, 200);
});
