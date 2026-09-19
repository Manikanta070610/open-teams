// chat.js — Company-wide chat on the db/04 tables (app_groups +
// conversations + messages + read receipts). Anyone can DM anyone;
// groups are public (open), private (invite-only), or department scoped.
// Group conversations are 1:1 with app_groups (conversations.group_id
// UNIQUE); participants sync from group_memberships on open, so leaving
// a group revokes chat access. The DB trigger enforce_message_sender
// backstops every write: sender must be a participant.
// Mounted at /api/chat (and alias /chat for spec compat).
import { Router } from 'express';
import { requireAuth } from './auth.js';
import { pool } from './db.js';
import { rateLimited } from './ratelimit.js';
import { isChiefOrAdmin } from './staffing.js';

export const router = Router();
router.use(requireAuth);

const WRITE_MAX = 30;
const WRITE_WINDOW_MS = 60_000;
const VISIBILITY = new Set(['public', 'private', 'department']);
const GROUP_ROLES = new Set(['owner', 'admin', 'member']);

async function myDeptId(userId) {
  const { rows } = await pool.query('SELECT department_id FROM employees WHERE id = $1', [userId]);
  return rows[0]?.department_id ?? null;
}

async function activeEmployee(id) {
  const { rows } = await pool.query(
    'SELECT 1 FROM employees WHERE id = $1 AND is_active = TRUE', [id]
  );
  return rows[0] || null;
}

async function groupRow(id) {
  const { rows } = await pool.query(
    `SELECT g.*, d.name AS department_name,
            (SELECT COUNT(*)::int FROM group_memberships m WHERE m.group_id = g.id) AS member_count
       FROM app_groups g LEFT JOIN departments d ON d.id = g.department_id
      WHERE g.id = $1`,
    [id]
  );
  return rows[0] || null;
}

async function groupRole(groupId, userId) {
  const { rows } = await pool.query(
    'SELECT role FROM group_memberships WHERE group_id = $1 AND employee_id = $2',
    [groupId, userId]
  );
  return rows[0]?.role || null;
}

async function groupMembers(groupId) {
  const { rows } = await pool.query(
    `SELECT m.employee_id AS id, m.role, m.joined_at,
            e.first_name, e.last_name, e.email
       FROM group_memberships m JOIN employees e ON e.id = m.employee_id
      WHERE m.group_id = $1 ORDER BY
        CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, m.joined_at`,
    [groupId]
  );
  return rows;
}

// Visible = member, public, my-department (department scope), or chief/admin.
function canSeeGroup(g, role, user, myDept) {
  if (role) return true;
  if (isChiefOrAdmin(user)) return true;
  if (g.visibility === 'public') return true;
  if (g.visibility === 'department' && Number(g.department_id) === Number(myDept)) return true;
  return false;
}

function isGroupManager(role, user) {
  return role === 'owner' || role === 'admin' || isChiefOrAdmin(user);
}

// Group conversation: find-or-create, then sync participants to match
// current membership (adds joiners, drops leavers).
async function ensureGroupConversation(groupId) {
  const found = await pool.query('SELECT * FROM conversations WHERE group_id = $1', [groupId]);
  let conv = found.rows[0];
  if (!conv) {
    const ins = await pool.query(
      `INSERT INTO conversations (type, group_id) VALUES ('group', $1) RETURNING *`,
      [groupId]
    );
    conv = ins.rows[0];
  }
  await pool.query(
    `INSERT INTO conversation_participants (conversation_id, employee_id)
      SELECT $1, m.employee_id FROM group_memberships m WHERE m.group_id = $2
      ON CONFLICT DO NOTHING`,
    [conv.id, groupId]
  );
  await pool.query(
    `DELETE FROM conversation_participants p
      WHERE p.conversation_id = $1 AND NOT EXISTS (
        SELECT 1 FROM group_memberships m
        WHERE m.group_id = $2 AND m.employee_id = p.employee_id)`,
    [conv.id, groupId]
  );
  return conv;
}

async function convParticipants(convId) {
  const { rows } = await pool.query(
    `SELECT p.employee_id AS id, p.joined_at, e.first_name, e.last_name, e.email
       FROM conversation_participants p JOIN employees e ON e.id = p.employee_id
      WHERE p.conversation_id = $1 ORDER BY e.first_name, e.last_name`,
    [convId]
  );
  return rows;
}

async function isParticipant(convId, userId) {
  const { rows } = await pool.query(
    'SELECT 1 FROM conversation_participants WHERE conversation_id = $1 AND employee_id = $2',
    [convId, userId]
  );
  return rows.length > 0;
}

async function convMessages(convId, { limit = 50, beforeId = null } = {}) {
  const lim = Math.min(Math.max(Number(limit) || 50, 1), 100);
  const vals = [convId];
  let cond = 'm.conversation_id = $1 AND m.is_deleted = FALSE';
  if (Number.isInteger(beforeId)) {
    vals.push(beforeId);
    cond += ` AND m.id < $${vals.length}`;
  }
  vals.push(lim);
  const { rows } = await pool.query(
    `SELECT m.*, e.first_name, e.last_name FROM messages m
       JOIN employees e ON e.id = m.sender_id
      WHERE ${cond} ORDER BY m.id DESC LIMIT $${vals.length}`,
    vals
  );
  return rows.reverse();
}

// Reading marks everything returned as read (receipt rows + cursor).
// Receipts go in as one batched INSERT, not one round-trip per message.
async function markRead(convId, userId, messages) {
  await pool.query(
    `UPDATE conversation_participants SET last_read_at = now()
      WHERE conversation_id = $1 AND employee_id = $2`,
    [convId, userId]
  );
  if (!messages.length) return;
  await pool.query(
    `INSERT INTO message_reads (message_id, employee_id)
      SELECT unnest($1::bigint[]), $2 ON CONFLICT DO NOTHING`,
    [messages.map((m) => Number(m.id)), userId]
  );
}

// --- GET /groups — groups visible to me ---
router.get('/groups', async (req, res, next) => {
  try {
    const myDept = await myDeptId(req.user.id);
    const { rows } = await pool.query(
      `SELECT g.*, d.name AS department_name,
              (SELECT COUNT(*)::int FROM group_memberships m WHERE m.group_id = g.id) AS member_count,
              (SELECT role FROM group_memberships m
                WHERE m.group_id = g.id AND m.employee_id = $1) AS my_role
         FROM app_groups g LEFT JOIN departments d ON d.id = g.department_id
        ORDER BY g.id DESC LIMIT 100`,
      [req.user.id]
    );
    return res.json(rows.filter((g) => canSeeGroup(g, g.my_role, req.user, myDept)));
  } catch (err) { return next(err); }
});

// --- POST /groups — anyone can start a group; creator becomes owner ---
router.post('/groups', async (req, res, next) => {
  try {
    if (rateLimited('chat-group', req.ip, WRITE_MAX, WRITE_WINDOW_MS)) {
      return res.status(429).json({ error: 'too many attempts, try later' });
    }
    const name = String(req.body?.name || '').trim();
    const description = req.body?.description ? String(req.body.description).slice(0, 2000) : null;
    const visibility = String(req.body?.visibility || 'private');
    if (!name) return res.status(400).json({ error: 'name is required' });
    if (name.length > 80) return res.status(400).json({ error: 'name too long (max 80)' });
    if (!VISIBILITY.has(visibility)) {
      return res.status(400).json({ error: 'visibility must be public, private, or department' });
    }
    let departmentId = null;
    if (visibility === 'department') {
      const myDept = await myDeptId(req.user.id);
      departmentId = req.body?.department_id ? Number(req.body.department_id) : myDept;
      if (!Number.isInteger(departmentId)) return res.status(400).json({ error: 'department_id is required' });
      const dept = await pool.query('SELECT id FROM departments WHERE id = $1', [departmentId]);
      if (dept.rows.length === 0) return res.status(400).json({ error: 'unknown department' });
      if (!isChiefOrAdmin(req.user) && Number(departmentId) !== Number(myDept)) {
        return res.status(403).json({ error: 'department groups are for your own department (chiefs excepted)' });
      }
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(
        `INSERT INTO app_groups (name, description, created_by, visibility, department_id)
         VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [name, description, req.user.id, visibility, departmentId]
      );
      const g = rows[0];
      await client.query(
        `INSERT INTO group_memberships (group_id, employee_id, role)
         VALUES ($1,$2,'owner') ON CONFLICT DO NOTHING`,
        [g.id, req.user.id]
      );
      await client.query('COMMIT');
      const detail = await groupRow(g.id);
      return res.status(201).json({ ...detail, my_role: 'owner', members: await groupMembers(g.id) });
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch { /* closed */ }
      throw err;
    } finally {
      client.release();
    }
  } catch (err) { return next(err); }
});

// --- GET /groups/:id — detail for those who may see it ---
router.get('/groups/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'invalid id' });
    const g = await groupRow(id);
    if (!g) return res.status(404).json({ error: 'not found' });
    const role = await groupRole(id, req.user.id);
    if (!canSeeGroup(g, role, req.user, await myDeptId(req.user.id))) {
      return res.status(404).json({ error: 'not found' });
    }
    return res.json({ ...g, my_role: role, members: await groupMembers(id) });
  } catch (err) { return next(err); }
});

// --- PATCH /groups/:id — rename / re-scope (managers) ---
router.patch('/groups/:id', async (req, res, next) => {
  try {
    if (rateLimited('chat-group', req.ip, WRITE_MAX, WRITE_WINDOW_MS)) {
      return res.status(429).json({ error: 'too many attempts, try later' });
    }
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'invalid id' });
    const g = await groupRow(id);
    if (!g) return res.status(404).json({ error: 'not found' });
    if (!isGroupManager(await groupRole(id, req.user.id), req.user)) {
      return res.status(403).json({ error: 'group owners/admins only' });
    }
    const patch = {};
    if (req.body?.name !== undefined) {
      const n = String(req.body.name).trim();
      if (!n) return res.status(400).json({ error: 'name is required' });
      if (n.length > 80) return res.status(400).json({ error: 'name too long (max 80)' });
      patch.name = n;
    }
    if (req.body?.description !== undefined) {
      patch.description = req.body.description ? String(req.body.description).slice(0, 2000) : null;
    }
    if (req.body?.visibility !== undefined) {
      const v = String(req.body.visibility);
      if (!VISIBILITY.has(v)) return res.status(400).json({ error: 'invalid visibility' });
      patch.visibility = v;
      patch.department_id = null;
      if (v === 'department') {
        const myDept = await myDeptId(req.user.id);
        const depId = req.body?.department_id ? Number(req.body.department_id) : Number(g.department_id) || myDept;
        if (!Number.isInteger(depId)) return res.status(400).json({ error: 'department_id is required' });
        if (!isChiefOrAdmin(req.user) && Number(depId) !== Number(myDept)) {
          return res.status(403).json({ error: 'department groups are for your own department (chiefs excepted)' });
        }
        patch.department_id = depId;
      }
    }
    if (Object.keys(patch).length === 0) return res.status(400).json({ error: 'nothing to update' });
    const cols = Object.keys(patch);
    await pool.query(
      `UPDATE app_groups SET ${cols.map((c, i) => `${c} = $${i + 2}`).join(', ')} WHERE id = $1`,
      [id, ...Object.values(patch)]
    );
    const detail = await groupRow(id);
    return res.json({ ...detail, my_role: await groupRole(id, req.user.id), members: await groupMembers(id) });
  } catch (err) { return next(err); }
});

// --- DELETE /groups/:id — owner or chief/admin (cascades chat too) ---
router.delete('/groups/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'invalid id' });
    const g = await groupRow(id);
    if (!g) return res.status(404).json({ error: 'not found' });
    const role = await groupRole(id, req.user.id);
    if (role !== 'owner' && !isChiefOrAdmin(req.user)) {
      return res.status(403).json({ error: 'group owner (or chief) only' });
    }
    await pool.query('DELETE FROM app_groups WHERE id = $1', [id]);
    return res.json({ ok: true });
  } catch (err) { return next(err); }
});

// --- POST /groups/:id/members — managers add active employees ---
router.post('/groups/:id/members', async (req, res, next) => {
  try {
    if (rateLimited('chat-group', req.ip, WRITE_MAX, WRITE_WINDOW_MS)) {
      return res.status(429).json({ error: 'too many attempts, try later' });
    }
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'invalid id' });
    const g = await groupRow(id);
    if (!g) return res.status(404).json({ error: 'not found' });
    if (!isGroupManager(await groupRole(id, req.user.id), req.user)) {
      return res.status(403).json({ error: 'group owners/admins only' });
    }
    const rawIds = Array.isArray(req.body?.employee_ids) ? req.body.employee_ids : [];
    const ids = [...new Set(rawIds.map(Number).filter(Number.isInteger))];
    if (ids.length === 0 || ids.length > 50) {
      return res.status(400).json({ error: 'employee_ids must have 1-50 entries' });
    }
    const role = String(req.body?.role || 'member');
    if (!GROUP_ROLES.has(role) || role === 'owner') {
      return res.status(400).json({ error: "role must be 'member' or 'admin' (owners via role change)" });
    }
    const { rows: found } = await pool.query(
      'SELECT id FROM employees WHERE id = ANY($1::bigint[]) AND is_active = TRUE', [ids]
    );
    if (found.length !== ids.length) {
      return res.status(400).json({ error: 'all members must be existing active employees' });
    }
    for (const empId of ids) {
      await pool.query(
        `INSERT INTO group_memberships (group_id, employee_id, role)
         VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
        [id, empId, role]
      );
    }
    return res.status(201).json({ members: await groupMembers(id) });
  } catch (err) { return next(err); }
});

// --- POST /groups/:id/join — self-join open groups ---
router.post('/groups/:id/join', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'invalid id' });
    const g = await groupRow(id);
    if (!g) return res.status(404).json({ error: 'not found' });
    if (await groupRole(id, req.user.id)) return res.json({ members: await groupMembers(id) });
    const myDept = await myDeptId(req.user.id);
    const open =
      g.visibility === 'public' ||
      (g.visibility === 'department' && Number(g.department_id) === Number(myDept)) ||
      isChiefOrAdmin(req.user);
    if (!open) return res.status(403).json({ error: 'invite-only group — ask an owner/admin' });
    await pool.query(
      `INSERT INTO group_memberships (group_id, employee_id, role)
       VALUES ($1,$2,'member') ON CONFLICT DO NOTHING`,
      [id, req.user.id]
    );
    return res.status(201).json({ members: await groupMembers(id) });
  } catch (err) { return next(err); }
});

// --- PATCH /groups/:id/members/:empId — owner changes roles (never drop the last owner) ---
router.patch('/groups/:id/members/:empId', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const empId = Number(req.params.empId);
    if (!Number.isInteger(id) || !Number.isInteger(empId)) return res.status(400).json({ error: 'invalid id' });
    const g = await groupRow(id);
    if (!g) return res.status(404).json({ error: 'not found' });
    const myRole = await groupRole(id, req.user.id);
    if (myRole !== 'owner' && !isChiefOrAdmin(req.user)) {
      return res.status(403).json({ error: 'group owner (or chief) only' });
    }
    const role = String(req.body?.role || '');
    if (!GROUP_ROLES.has(role)) return res.status(400).json({ error: 'invalid role' });
    const target = await groupRole(id, empId);
    if (!target) return res.status(404).json({ error: 'not a group member' });
    if (target === 'owner' && role !== 'owner') {
      const { rows } = await pool.query(
        `SELECT COUNT(*)::int AS n FROM group_memberships WHERE group_id = $1 AND role = 'owner'`, [id]
      );
      if (rows[0].n <= 1) return res.status(409).json({ error: 'cannot demote the only owner' });
    }
    await pool.query(
      'UPDATE group_memberships SET role = $1 WHERE group_id = $2 AND employee_id = $3',
      [role, id, empId]
    );
    return res.json({ members: await groupMembers(id) });
  } catch (err) { return next(err); }
});

// --- DELETE /groups/:id/members/:empId — managers remove; anyone may leave (last owner stays) ---
router.delete('/groups/:id/members/:empId', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const empId = Number(req.params.empId);
    if (!Number.isInteger(id) || !Number.isInteger(empId)) return res.status(400).json({ error: 'invalid id' });
    const g = await groupRow(id);
    if (!g) return res.status(404).json({ error: 'not found' });
    const myRole = await groupRole(id, req.user.id);
    const selfLeave = Number(empId) === Number(req.user.id);
    if (!selfLeave && !isGroupManager(myRole, req.user)) {
      return res.status(403).json({ error: 'group owners/admins only' });
    }
    const target = await groupRole(id, empId);
    if (!target) return res.status(404).json({ error: 'not a group member' });
    if (target === 'owner') {
      const { rows } = await pool.query(
        `SELECT COUNT(*)::int AS n FROM group_memberships WHERE group_id = $1 AND role = 'owner'`, [id]
      );
      if (rows[0].n <= 1) return res.status(409).json({ error: 'cannot remove the only owner' });
    }
    await pool.query('DELETE FROM group_memberships WHERE group_id = $1 AND employee_id = $2', [id, empId]);
    return res.json({ members: await groupMembers(id) });
  } catch (err) { return next(err); }
});

// --- GET /groups/:id/chat — member-only room history (participants synced) ---
router.get('/groups/:id/chat', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'invalid id' });
    const g = await groupRow(id);
    if (!g) return res.status(404).json({ error: 'not found' });
    if (!(await groupRole(id, req.user.id))) return res.status(404).json({ error: 'not found' });
    const conv = await ensureGroupConversation(id);
    const messages = await convMessages(conv.id, {
      limit: req.query.limit,
      beforeId: req.query.before_id ? Number(req.query.before_id) : null,
    });
    await markRead(conv.id, req.user.id, messages);
    return res.json({ conversation_id: Number(conv.id), messages });
  } catch (err) { return next(err); }
});

// --- POST /groups/:id/chat — member-only post ---
router.post('/groups/:id/chat', async (req, res, next) => {
  try {
    if (rateLimited('chat-msg', req.ip, WRITE_MAX, WRITE_WINDOW_MS)) {
      return res.status(429).json({ error: 'too many attempts, try later' });
    }
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'invalid id' });
    const g = await groupRow(id);
    if (!g) return res.status(404).json({ error: 'not found' });
    if (!(await groupRole(id, req.user.id))) return res.status(404).json({ error: 'not found' });
    const body = String(req.body?.body || '').trim();
    if (!body) return res.status(400).json({ error: 'body is required' });
    if (body.length > 5000) return res.status(400).json({ error: 'body too long (max 5000)' });
    const conv = await ensureGroupConversation(id);
    const { rows } = await pool.query(
      `INSERT INTO messages (conversation_id, sender_id, body) VALUES ($1,$2,$3) RETURNING *`,
      [conv.id, req.user.id, body.slice(0, 5000)]
    );
    await markRead(conv.id, req.user.id, rows);
    const sender = await pool.query('SELECT first_name, last_name FROM employees WHERE id = $1', [req.user.id]);
    return res.status(201).json({ ...rows[0], ...sender.rows[0] });
  } catch (err) { return next(err); }
});

// --- GET /conversations — mine, with peers, last message + unread ---
// Batched: one query for conversations (+last message +unread via LATERAL /
// scalar subquery), one for all participants, one for my group roles —
// constant round-trips no matter how many conversations exist.
router.get('/conversations', async (req, res, next) => {
  try {
    const myDept = await myDeptId(req.user.id);
    const { rows: convs } = await pool.query(
      `SELECT c.*, g.name AS group_name, g.visibility AS group_visibility,
              g.department_id AS group_department_id,
              lm.id AS lm_id, lm.conversation_id AS lm_conv, lm.sender_id AS lm_sender,
              lm.body AS lm_body, lm.created_at AS lm_at,
              le.first_name AS lm_first, le.last_name AS lm_last,
              (SELECT COUNT(*)::int FROM messages m
                WHERE m.conversation_id = c.id AND m.is_deleted = FALSE
                  AND m.sender_id <> $1 AND m.created_at > COALESCE(
                    (SELECT last_read_at FROM conversation_participants
                      WHERE conversation_id = c.id AND employee_id = $1), '-infinity')
              ) AS unread_count
         FROM conversations c
         JOIN conversation_participants p ON p.conversation_id = c.id AND p.employee_id = $1
         LEFT JOIN app_groups g ON g.id = c.group_id
         LEFT JOIN LATERAL (
           SELECT m.* FROM messages m
            WHERE m.conversation_id = c.id AND m.is_deleted = FALSE
            ORDER BY m.id DESC LIMIT 1
         ) lm ON TRUE
         LEFT JOIN employees le ON le.id = lm.sender_id
        ORDER BY c.id DESC`,
      [req.user.id]
    );
    const ids = convs.map((c) => Number(c.id));
    let parts = [];
    if (ids.length > 0) {
      const { rows } = await pool.query(
        `SELECT p.conversation_id, p.employee_id AS id, p.joined_at,
                e.first_name, e.last_name, e.email
           FROM conversation_participants p JOIN employees e ON e.id = p.employee_id
          WHERE p.conversation_id = ANY($1::bigint[])
          ORDER BY e.first_name, e.last_name`,
        [ids]
      );
      parts = rows;
    }
    const partsByConv = new Map();
    for (const pt of parts) {
      const k = Number(pt.conversation_id);
      if (!partsByConv.has(k)) partsByConv.set(k, []);
      const { conversation_id: _drop, ...rest } = pt;
      partsByConv.get(k).push(rest);
    }
    const { rows: myGroups } = await pool.query(
      'SELECT group_id, role FROM group_memberships WHERE employee_id = $1', [req.user.id]
    );
    const roleByGroup = new Map(myGroups.map((r) => [Number(r.group_id), r.role]));
    const out = [];
    for (const c of convs) {
      if (c.type === 'group') {
        // Hide chats of groups I can no longer see (e.g. made private).
        const g = {
          visibility: c.group_visibility,
          department_id: c.group_department_id,
        };
        if (c.group_name && !canSeeGroup(g, roleByGroup.get(Number(c.group_id)) || null, req.user, myDept)) {
          continue;
        }
      }
      const { group_visibility: _v, group_department_id: _d, ...rest } = c;
      out.push({
        ...rest,
        participants: partsByConv.get(Number(c.id)) || [],
        last_message: c.lm_id ? {
          id: c.lm_id,
          conversation_id: c.lm_conv,
          sender_id: c.lm_sender,
          body: c.lm_body,
          created_at: c.lm_at,
          first_name: c.lm_first,
          last_name: c.lm_last,
        } : null,
      });
    }
    out.sort((a, b) => (b.last_message?.id || 0) - (a.last_message?.id || 0) || Number(b.id) - Number(a.id));
    return res.json(out);
  } catch (err) { return next(err); }
});

// --- POST /conversations/direct — 1-1 DM with any active employee (deduped) ---
router.post('/conversations/direct', async (req, res, next) => {
  try {
    if (rateLimited('chat-msg', req.ip, WRITE_MAX, WRITE_WINDOW_MS)) {
      return res.status(429).json({ error: 'too many attempts, try later' });
    }
    const otherId = Number(req.body?.employee_id);
    if (!Number.isInteger(otherId)) return res.status(400).json({ error: 'employee_id is required' });
    if (otherId === Number(req.user.id)) return res.status(400).json({ error: 'cannot DM yourself' });
    if (!(await activeEmployee(otherId))) {
      return res.status(400).json({ error: 'unknown or inactive employee' });
    }
    const { rows: dup } = await pool.query(
      `SELECT c.id FROM conversations c
        WHERE c.type = 'direct'
          AND EXISTS (SELECT 1 FROM conversation_participants p WHERE p.conversation_id = c.id AND p.employee_id = $1)
          AND EXISTS (SELECT 1 FROM conversation_participants p WHERE p.conversation_id = c.id AND p.employee_id = $2)
          AND (SELECT COUNT(*) FROM conversation_participants p WHERE p.conversation_id = c.id) = 2
        LIMIT 1`,
      [req.user.id, otherId]
    );
    if (dup[0]) {
      const { rows: c } = await pool.query('SELECT * FROM conversations WHERE id = $1', [dup[0].id]);
      return res.json({ ...c[0], participants: await convParticipants(c[0].id), reused: true });
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(
        `INSERT INTO conversations (type) VALUES ('direct') RETURNING *`
      );
      const conv = rows[0];
      for (const empId of [req.user.id, otherId]) {
        await client.query(
          `INSERT INTO conversation_participants (conversation_id, employee_id)
           VALUES ($1,$2) ON CONFLICT DO NOTHING`,
          [conv.id, empId]
        );
      }
      await client.query('COMMIT');
      return res.status(201).json({ ...conv, participants: await convParticipants(conv.id) });
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch { /* closed */ }
      throw err;
    } finally {
      client.release();
    }
  } catch (err) { return next(err); }
});

// --- GET /conversations/:id/messages — participant history (marks read) ---
router.get('/conversations/:id/messages', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'invalid id' });
    const { rows } = await pool.query('SELECT * FROM conversations WHERE id = $1', [id]);
    const conv = rows[0];
    if (!conv || !(await isParticipant(id, req.user.id))) {
      return res.status(404).json({ error: 'not found' });
    }
    const messages = await convMessages(id, {
      limit: req.query.limit,
      beforeId: req.query.before_id ? Number(req.query.before_id) : null,
    });
    await markRead(id, req.user.id, messages);
    return res.json({ conversation_id: Number(id), messages });
  } catch (err) { return next(err); }
});

// --- POST /conversations/:id/messages — participant post ---
router.post('/conversations/:id/messages', async (req, res, next) => {
  try {
    if (rateLimited('chat-msg', req.ip, WRITE_MAX, WRITE_WINDOW_MS)) {
      return res.status(429).json({ error: 'too many attempts, try later' });
    }
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'invalid id' });
    const { rows } = await pool.query('SELECT * FROM conversations WHERE id = $1', [id]);
    const conv = rows[0];
    if (!conv || !(await isParticipant(id, req.user.id))) {
      return res.status(404).json({ error: 'not found' });
    }
    const body = String(req.body?.body || '').trim();
    if (!body) return res.status(400).json({ error: 'body is required' });
    if (body.length > 5000) return res.status(400).json({ error: 'body too long (max 5000)' });
    const { rows: ins } = await pool.query(
      `INSERT INTO messages (conversation_id, sender_id, body) VALUES ($1,$2,$3) RETURNING *`,
      [id, req.user.id, body.slice(0, 5000)]
    );
    await markRead(id, req.user.id, ins);
    const sender = await pool.query('SELECT first_name, last_name FROM employees WHERE id = $1', [req.user.id]);
    return res.status(201).json({ ...ins[0], ...sender.rows[0] });
  } catch (err) { return next(err); }
});

export default router;
