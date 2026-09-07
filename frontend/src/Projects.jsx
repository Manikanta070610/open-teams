import { useEffect, useState } from 'react';
import { api } from './adminApi.js';
import { useAuth } from './AuthContext.jsx';
import Profile from './Profile.jsx';

const TASK_STATUS = ['todo', 'in_progress', 'in_review', 'done', 'blocked', 'cancelled'];
const PRIORITIES = ['low', 'medium', 'high', 'urgent'];
const ESTIMATES = ['XS', 'S', 'M', 'L', 'XL'];

function personBtn(m, onProfile) {
  return (
    <button
      onClick={() => onProfile(m.employee_id)}
      title={`${m.email} — rank ${m.rank}, ${m.department}`}
      style={{ background: 'none', border: 'none', padding: 0, color: '#0645ad', cursor: 'pointer', textDecoration: 'underline' }}
    >
      {m.first_name} {m.last_name}
    </button>
  );
}

// Projects tab: standalone projects with charter, heads (owner/lead = full
// access), cross-dept direct add with workload visibility, tasks + subtasks,
// comments, weekly updates, and audit log. Same auth/fetch UX as Workspaces.
export default function Projects() {
  const { user, sessionExpired, policyDays } = useAuth();
  const [list, setList] = useState(null);
  const [err, setErr] = useState('');
  const [selected, setSelected] = useState(null);
  const [profileId, setProfileId] = useState(null);

  // create form
  const [name, setName] = useState('');
  const [deptId, setDeptId] = useState('');
  const [description, setDescription] = useState('');
  const [objective, setObjective] = useState('');
  const [creating, setCreating] = useState(false);
  const [depts, setDepts] = useState([]);

  // add-member picker
  const [candDept, setCandDept] = useState('');
  const [candQ, setCandQ] = useState('');
  const [cands, setCands] = useState(null);

  // task form
  const [taskForm, setTaskForm] = useState({ title: '', assigned_to: '', priority: 'medium', estimate: '', due_date: '' });

  // per-task UI
  const [taskStatus, setTaskStatus] = useState({});
  const [blockedReason, setBlockedReason] = useState({});
  const [comments, setComments] = useState({});
  const [commentDraft, setCommentDraft] = useState({});
  const [updateDraft, setUpdateDraft] = useState('');
  const [activity, setActivity] = useState(null);

  function fail(e) {
    if (e.status === 401) sessionExpired(policyDays);
    else setErr(e.message);
  }

  function load() {
    const c = new AbortController();
    setErr('');
    api('/api/projects', { signal: c.signal })
      .then((rows) => setList(Array.isArray(rows) ? rows : []))
      .catch((e) => {
        if (e.name === 'AbortError') return;
        fail(e);
      });
    api('/api/projects/departments').catch(() => null).then((d) => {
      if (Array.isArray(d)) setDepts(d);
    });
    return () => c.abort();
  }

  useEffect(load, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function open(id) {
    setErr('');
    setActivity(null);
    setCands(null);
    try {
      const d = await api(`/api/projects/${id}`);
      setSelected(d);
      const init = {};
      for (const t of d.tasks || []) init[t.id] = t.status;
      setTaskStatus(init);
    } catch (e) {
      if (e.status === 404) setErr('Not a member of this project.');
      else fail(e);
    }
  }

  async function create(e) {
    e.preventDefault();
    if (!name.trim()) {
      setErr('Project name is required.');
      return;
    }
    if (!deptId) {
      setErr('Owning department is required.');
      return;
    }
    setCreating(true);
    setErr('');
    try {
      const p = await api('/api/projects', {
        method: 'POST',
        body: {
          name: name.trim(),
          owning_department_id: Number(deptId),
          description: description.trim() || undefined,
          objective: objective.trim() || undefined,
        },
      });
      setName('');
      setDeptId('');
      setDescription('');
      setObjective('');
      setList((prev) => (prev ? [p, ...prev] : [p]));
      setSelected(p);
    } catch (e2) {
      fail(e2);
    } finally {
      setCreating(false);
    }
  }

  async function searchCands(e) {
    e?.preventDefault();
    if (!selected) return;
    setErr('');
    try {
      const q = `?exclude_members_of=${selected.id}${candDept ? `&departments=${candDept}` : ''}${candQ.trim() ? `&q=${encodeURIComponent(candQ.trim())}` : ''}`;
      setCands(await api(`/api/projects/candidates${q}`));
    } catch (e2) {
      fail(e2);
    }
  }

  async function addMember(empId, role = 'member') {
    setErr('');
    try {
      const d = await api(`/api/projects/${selected.id}/members`, {
        method: 'POST',
        body: { members: [{ employee_id: empId, role }] },
      });
      setSelected(d);
      setCands((prev) => (prev ? prev.filter((c) => Number(c.id) !== Number(empId)) : prev));
    } catch (e2) {
      fail(e2);
    }
  }

  async function assignTask(e) {
    e.preventDefault();
    if (!taskForm.title.trim() || !taskForm.assigned_to) {
      setErr('Task title and assignee are required.');
      return;
    }
    setErr('');
    try {
      const t = await api(`/api/projects/${selected.id}/tasks`, {
        method: 'POST',
        body: {
          title: taskForm.title.trim(),
          assigned_to: Number(taskForm.assigned_to),
          priority: taskForm.priority,
          estimate: taskForm.estimate || undefined,
          due_date: taskForm.due_date || undefined,
        },
      });
      setSelected((prev) => (prev ? { ...prev, tasks: [...(prev.tasks || []), t] } : prev));
      setTaskStatus((prev) => ({ ...prev, [t.id]: t.status }));
      setTaskForm({ title: '', assigned_to: '', priority: 'medium', estimate: '', due_date: '' });
    } catch (e2) {
      fail(e2);
    }
  }

  async function setStatus(taskId, status) {
    setErr('');
    try {
      const body = { status };
      if (status === 'blocked') {
        const reason = (blockedReason[taskId] || '').trim();
        if (!reason) {
          setErr('blocked_reason is required when marking blocked.');
          return;
        }
        body.blocked_reason = reason;
      }
      const t = await api(`/api/projects/${selected.id}/tasks/${taskId}`, { method: 'PATCH', body });
      setSelected((prev) => (prev ? { ...prev, tasks: (prev.tasks || []).map((x) => (x.id === taskId ? { ...x, ...t } : x)) } : prev));
      setTaskStatus((prev) => ({ ...prev, [taskId]: t.status }));
    } catch (e2) {
      fail(e2);
    }
  }

  async function loadComments(taskId) {
    setErr('');
    try {
      const rows = await api(`/api/projects/${selected.id}/tasks/${taskId}/comments`);
      setComments((prev) => ({ ...prev, [taskId]: rows }));
    } catch (e2) {
      fail(e2);
    }
  }

  async function postComment(e, taskId) {
    e.preventDefault();
    const body = (commentDraft[taskId] || '').trim();
    if (!body) return;
    setErr('');
    try {
      const c = await api(`/api/projects/${selected.id}/tasks/${taskId}/comments`, { method: 'POST', body: { body } });
      setComments((prev) => ({ ...prev, [taskId]: [...(prev[taskId] || []), c] }));
      setCommentDraft((prev) => ({ ...prev, [taskId]: '' }));
      setSelected((prev) => {
        if (!prev) return prev;
        return { ...prev, tasks: (prev.tasks || []).map((x) => (x.id === taskId ? { ...x, comment_count: (x.comment_count || 0) + 1 } : x)) };
      });
    } catch (e2) {
      fail(e2);
    }
  }

  async function postUpdate(e) {
    e.preventDefault();
    if (!updateDraft.trim()) return;
    setErr('');
    try {
      const u = await api(`/api/projects/${selected.id}/updates`, { method: 'POST', body: { body: updateDraft.trim() } });
      setSelected((prev) => (prev ? { ...prev, updates: [u, ...(prev.updates || [])] } : prev));
      setUpdateDraft('');
    } catch (e2) {
      fail(e2);
    }
  }

  async function loadActivity() {
    setErr('');
    try {
      setActivity(await api(`/api/projects/${selected.id}/activity`));
    } catch (e2) {
      fail(e2);
    }
  }

  async function closeProject(status) {
    setErr('');
    try {
      const body = { status };
      if (status === 'cancelled') {
        const reason = window.prompt('Cancellation reason (required):', '') || '';
        if (!reason.trim()) {
          setErr('cancelled_reason is required.');
          return;
        }
        body.cancelled_reason = reason.trim();
      }
      setSelected(await api(`/api/projects/${selected.id}`, { method: 'PATCH', body }));
    } catch (e2) {
      fail(e2);
    }
  }

  const myRole = selected?.my_role;
  const isHead = myRole === 'owner' || myRole === 'lead' || (user && (Number(user.rank) >= 5 || user.isAdmin));
  const heads = (selected?.members || []).filter((m) => m.role === 'owner' || m.role === 'lead');
  const rest = (selected?.members || []).filter((m) => m.role !== 'owner' && m.role !== 'lead');
  const topTasks = (selected?.tasks || []).filter((t) => !t.parent_task_id);
  const subsOf = (pid) => (selected?.tasks || []).filter((t) => Number(t.parent_task_id) === Number(pid));

  return (
    <section>
      <h2>Projects</h2>
      {err && <p style={{ color: 'darkred' }}>Error: {err}</p>}
      <form onSubmit={create}>
        <h3>New project (managers in own dept, workspace heads, chiefs)</h3>
        <input placeholder="Project name" value={name} onChange={(e) => setName(e.target.value)} />{' '}
        <select value={deptId} onChange={(e) => setDeptId(e.target.value)}>
          <option value="">Owning dept…</option>
          {depts.map((d) => (
            <option key={d.id} value={d.id}>{d.name}</option>
          ))}
        </select>{' '}
        <input placeholder="Description (optional)" value={description} onChange={(e) => setDescription(e.target.value)} style={{ width: '20em' }} />{' '}
        <input placeholder="Objective (optional)" value={objective} onChange={(e) => setObjective(e.target.value)} style={{ width: '20em' }} />{' '}
        <button type="submit" disabled={creating}>Create</button>
      </form>
      {list === null ? (
        <p>Loading…</p>
      ) : list.length === 0 ? (
        <p>No projects yet. Create one above.</p>
      ) : (
        <ul>
          {list.map((p) => (
            <li key={p.id}>
              <button onClick={() => open(p.id)}>{p.name}</button>{' '}
              <small>({p.my_role}, {p.status})</small>
            </li>
          ))}
        </ul>
      )}
      {selected && (
        <article style={{ border: '1px solid #ccc', padding: 8, marginTop: 8 }}>
          <h3>{selected.name} <small>({selected.status}{selected.owning_department ? `, ${selected.owning_department}` : ''})</small></h3>
          {selected.description && <p>{selected.description}</p>}
          {selected.objective && <p><em>Objective: {selected.objective}</em></p>}
          {isHead && selected.status !== 'completed' && selected.status !== 'cancelled' && (
            <p>
              <button onClick={() => closeProject('completed')}>Mark completed</button>{' '}
              <button onClick={() => closeProject('cancelled')}>Cancel project</button>{' '}
              <small>(requires 0 open tasks)</small>
            </p>
          )}
          <h4>Heads (full access)</h4>
          <ul>
            {heads.map((m) => (
              <li key={m.employee_id}>
                {personBtn(m, setProfileId)} — {m.role}, rank {m.rank}, {m.department}
                {m.allocation_pct < 100 ? ` (${m.allocation_pct}%)` : ''}
              </li>
            ))}
          </ul>
          <h4>Members</h4>
          {rest.length === 0 ? <p>No other members.</p> : (
            <ul>
              {rest.map((m) => (
                <li key={m.employee_id}>
                  {personBtn(m, setProfileId)} — {m.role}, rank {m.rank}, {m.department}
                  {m.allocation_pct < 100 ? ` (${m.allocation_pct}%${m.is_primary ? '' : ', shared'})` : ''}
                </li>
              ))}
            </ul>
          )}
          {isHead && (
            <form onSubmit={searchCands}>
              <h4>Add people (any dept — workload shown to avoid overload)</h4>
              <input placeholder="Dept id (blank = all)" value={candDept} onChange={(e) => setCandDept(e.target.value)} style={{ width: '10em' }} />{' '}
              <input placeholder="Search name/email" value={candQ} onChange={(e) => setCandQ(e.target.value)} />{' '}
              <button type="submit">Search</button>
              {cands && (
                <ul>
                  {cands.map((c) => {
                    const overloaded = (c.total_alloc ?? 0) >= 100 || (c.open_tasks ?? 0) >= 5;
                    return (
                      <li key={c.id} style={overloaded ? { color: '#8a5a00' } : undefined}>
                        {c.first_name} {c.last_name} — rank {c.rank}, {c.department} —{' '}
                        {c.active_projects} projects, {c.open_tasks} open tasks, {c.total_alloc}% alloc
                        {overloaded ? ' — HEAVY LOAD' : ''}{' '}
                        <button onClick={() => addMember(c.id)}>Add</button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </form>
          )}
          <h4>Tasks</h4>
          {(topTasks || []).length === 0 ? <p>No tasks yet.</p> : (
            <ul>
              {topTasks.map((t) => (
                <li key={t.id}>
                  <strong>{t.title}</strong> — {t.assignee_first} {t.assignee_last} — {t.status} — {t.priority}
                  {t.estimate ? ` — ${t.estimate}` : ''}{t.due_date ? ` — due ${String(t.due_date).slice(0, 10)}` : ''}
                  {t.status === 'blocked' && t.blocked_reason ? ` (blocked: ${t.blocked_reason})` : ''}
                  {t.comment_count ? ` — ${t.comment_count} comments` : ''}
                  {' '}
                  <select value={taskStatus[t.id] || t.status} onChange={(e) => setStatus(t.id, e.target.value)}>
                    {TASK_STATUS.map((s) => <option key={s} value={s}>{s}</option>)}
                  </select>{' '}
                  {(taskStatus[t.id] || t.status) === 'blocked' && (
                    <input
                      placeholder="blocked reason (required)"
                      value={blockedReason[t.id] || ''}
                      onChange={(e) => setBlockedReason((p) => ({ ...p, [t.id]: e.target.value }))}
                    />
                  )}{' '}
                  <button onClick={() => loadComments(t.id)}>Comments</button>
                  {comments[t.id] && (
                    <ul>
                      {comments[t.id].map((c) => (
                        <li key={c.id}><small>{c.first_name}: {c.body}</small></li>
                      ))}
                      <li>
                        <form onSubmit={(e) => postComment(e, t.id)}>
                          <input
                            placeholder="Add a comment…"
                            value={commentDraft[t.id] || ''}
                            onChange={(e) => setCommentDraft((p) => ({ ...p, [t.id]: e.target.value }))}
                            style={{ width: '24em' }}
                          />{' '}
                          <button type="submit">Post</button>
                        </form>
                      </li>
                    </ul>
                  )}
                  {subsOf(t.id).length > 0 && (
                    <ul>
                      {subsOf(t.id).map((s) => (
                        <li key={s.id}>
                          ↳ {s.title} — {s.assignee_first} {s.assignee_last} — {s.status}{' '}
                          <select value={taskStatus[s.id] || s.status} onChange={(e) => setStatus(s.id, e.target.value)}>
                            {TASK_STATUS.map((x) => <option key={x} value={x}>{x}</option>)}
                          </select>
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ul>
          )}
          {isHead && (
            <form onSubmit={assignTask}>
              <h4>Assign work (heads only)</h4>
              <input placeholder="Task title" value={taskForm.title} onChange={(e) => setTaskForm((f) => ({ ...f, title: e.target.value }))} />{' '}
              <select value={taskForm.assigned_to} onChange={(e) => setTaskForm((f) => ({ ...f, assigned_to: e.target.value }))}>
                <option value="">Assignee…</option>
                {(selected.members || []).map((m) => (
                  <option key={m.employee_id} value={m.employee_id}>{m.first_name} {m.last_name} (rank {m.rank})</option>
                ))}
              </select>{' '}
              <select value={taskForm.priority} onChange={(e) => setTaskForm((f) => ({ ...f, priority: e.target.value }))}>
                {PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
              </select>{' '}
              <select value={taskForm.estimate} onChange={(e) => setTaskForm((f) => ({ ...f, estimate: e.target.value }))}>
                <option value="">Size…</option>
                {ESTIMATES.map((x) => <option key={x} value={x}>{x}</option>)}
              </select>{' '}
              <input type="date" value={taskForm.due_date} onChange={(e) => setTaskForm((f) => ({ ...f, due_date: e.target.value }))} />{' '}
              <button type="submit">Assign</button>
            </form>
          )}
          <h4>Status updates</h4>
          {(selected.updates || []).length === 0 ? <p>No updates yet.</p> : (
            <ul>
              {(selected.updates || []).map((u) => (
                <li key={u.id}>{u.body} <small>({u.first_name} {u.last_name})</small></li>
              ))}
            </ul>
          )}
          <form onSubmit={postUpdate}>
            <input
              placeholder="Weekly update: done / next / risks…"
              value={updateDraft}
              onChange={(e) => setUpdateDraft(e.target.value)}
              style={{ width: '30em' }}
            />{' '}
            <button type="submit">Post update</button>
          </form>
          <h4>Activity</h4>
          {activity === null ? (
            <p><button onClick={loadActivity}>Show what happened</button></p>
          ) : activity.length === 0 ? <p>No activity.</p> : (
            <ul>
              {activity.map((a) => (
                <li key={a.id}>
                  <small>{a.action}{a.first_name ? ` by ${a.first_name} ${a.last_name}` : ''} — {new Date(a.created_at).toLocaleString()}</small>
                </li>
              ))}
            </ul>
          )}
        </article>
      )}
      {profileId && <Profile id={profileId} onClose={() => setProfileId(null)} />}
    </section>
  );
}
