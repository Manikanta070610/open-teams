import { useEffect, useState } from 'react';
import { api } from './adminApi.js';
import { useAuth } from './AuthContext.jsx';
import Profile from './Profile.jsx';
import ProjectChat from './ProjectChat.jsx';
import { Alert, Avatar, Badge, Card, Empty } from './ui.jsx';

const TASK_STATUS = ['todo', 'in_progress', 'in_review', 'done', 'blocked', 'cancelled'];
const PRIORITIES = ['low', 'medium', 'high', 'urgent'];
const ESTIMATES = ['XS', 'S', 'M', 'L', 'XL'];

function personBtn(m, onProfile) {
  return (
    <button
      className="link-btn"
      onClick={() => onProfile(m.employee_id)}
      title={`${m.email} — rank ${m.rank}, ${m.department}`}
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

  // people menu (+ at the top) and panel mode
  const [peopleMenu, setPeopleMenu] = useState(false);
  const [peopleMode, setPeopleMode] = useState('add');

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
      loadActivity(id);
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
      loadActivity(d.id);
    } catch (e2) {
      fail(e2);
    }
  }

  function pickPeopleMode(mode) {
    if (!selected) {
      setErr('Select a project first, then use + to manage people.');
      return;
    }
    setErr('');
    setPeopleMode(mode);
    setPeopleMenu(false);
    setTimeout(() => document.getElementById('people-panel')?.scrollIntoView({ block: 'nearest' }), 0);
  }

  async function removeMember(empId, label) {
    if (!selected) return;
    if (!window.confirm(`Remove ${label} from ${selected.name}?`)) return;
    setErr('');
    try {
      const d = await api(`/api/projects/${selected.id}/members/${empId}`, { method: 'DELETE' });
      const stillMember = (d.members || []).some((m) => user && Number(m.employee_id) === Number(user.id));
      setSelected({ ...d, my_role: stillMember ? selected.my_role : null });
      setCands(null);
      loadActivity(d.id);
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
      loadActivity(selected.id);
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
      loadActivity(selected.id);
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
      loadActivity(selected.id);
    } catch (e2) {
      fail(e2);
    }
  }

  async function loadActivity(id) {
    const pid = id || selected?.id;
    if (!pid) return;
    setErr('');
    try {
      setActivity(await api(`/api/projects/${pid}/activity`));
    } catch (e2) {
      fail(e2);
    }
  }

  // Human-readable change history (backend stores raw action + detail JSON).
  function describeActivity(a) {
    const who = `${a.first_name || ''} ${a.last_name || ''}`.trim() || 'Someone';
    const d = a.detail || {};
    switch (a.action) {
      case 'project.created': return `${who} created the project${d.name ? ` (${d.name})` : ''}`;
      case 'project.status': {
        const bits = Object.entries(d).map(([k, v]) => `${k} → ${v}`);
        return `${who} updated project${bits.length ? `: ${bits.join(', ')}` : ''}`;
      }
      case 'member.add': return `${who} added member #${d.employee_id} as ${d.role || 'member'}`;
      case 'member.remove': return `${who} removed member #${d.employee_id}`;
      case 'task.created': return `${who} created task "${d.title || ''}" for #${d.assigned_to}`;
      case 'task.status': {
        const bits = Object.entries(d).map(([k, v]) => `${k} → ${v}`);
        return `${who} updated task${a.task_id ? ` #${a.task_id}` : ''}${bits.length ? `: ${bits.join(', ')}` : ''}`;
      }
      case 'comment': return `${who} commented on task #${a.task_id}`;
      case 'update.posted': return `${who} posted a status update`;
      default: return `${who} did ${a.action}`;
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
      loadActivity(selected.id);
    } catch (e2) {
      fail(e2);
    }
  }

  const myRole = selected?.my_role;
  const isHead = myRole === 'owner' || myRole === 'lead' || (user && (Number(user.rank) >= 5 || user.isAdmin));
  const canStaff = isHead || (myRole && user && Number(user.rank) >= 4);
  // Downward staffing in the UI too: no adding/removing higher ranks
  // (the API enforces this as well; disabled buttons explain why).
  const outranksMe = (rank) => user && Number(rank) > Number(user.rank);
  const heads = (selected?.members || []).filter((m) => m.role === 'owner' || m.role === 'lead');
  const rest = (selected?.members || []).filter((m) => m.role !== 'owner' && m.role !== 'lead');
  const topTasks = (selected?.tasks || []).filter((t) => !t.parent_task_id);
  const openCount = (selected?.tasks || []).filter((t) => !['done', 'cancelled'].includes(t.status)).length;
  const subsOf = (pid) => (selected?.tasks || []).filter((t) => Number(t.parent_task_id) === Number(pid));

  return (
    <section>
      <div className="page-head">
        <div className="page-title-row">
          <h1>Projects</h1>
          <button className="btn btn-sm btn-icon" onClick={() => setPeopleMenu((v) => !v)} title="Add or remove people" aria-label="People options" aria-expanded={peopleMenu}>+</button>
        </div>
        <p className="page-sub">Standalone work with charter, staffing, tasks and history.</p>
        {peopleMenu && (
          <div className="btn-row" style={{ marginTop: 8 }}>
            <button className="btn btn-sm" onClick={() => pickPeopleMode('add')}>Add people</button>
            <button className="btn btn-sm" onClick={() => pickPeopleMode('remove')}>Remove people</button>
          </div>
        )}
      </div>
      {err && <Alert>{err}</Alert>}

      <Card title="New project">
        <p className="muted">Managers in their own dept, workspace heads, or chiefs.</p>
        <form onSubmit={create}>
          <div className="form-inline">
            <div className="field">
              <span>Project name</span>
              <input value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="field">
              <span>Owning dept</span>
              <select value={deptId} onChange={(e) => setDeptId(e.target.value)}>
                <option value="">Owning dept…</option>
                {depts.map((d) => (
                  <option key={d.id} value={d.id}>{d.name}</option>
                ))}
              </select>
            </div>
            <div className="field" style={{ flex: 1, minWidth: 160 }}>
              <span>Description (optional)</span>
              <input value={description} onChange={(e) => setDescription(e.target.value)} />
            </div>
            <div className="field" style={{ flex: 1, minWidth: 160 }}>
              <span>Objective (optional)</span>
              <input value={objective} onChange={(e) => setObjective(e.target.value)} />
            </div>
            <button className="btn btn-primary" type="submit" disabled={creating}>{creating ? 'Creating…' : 'Create'}</button>
          </div>
        </form>
      </Card>

      <div className="grid cols-2">
        <Card title="My projects">
          {list === null ? (
            <p className="loading">Loading</p>
          ) : list.length === 0 ? (
            <Empty>No projects yet. Create one above.</Empty>
          ) : (
            <ul className="rows">
              {list.map((p) => (
                <li key={p.id} style={selected?.id === p.id ? { background: 'var(--brand-soft)', borderRadius: 8 } : undefined}>
                  <div className="grow">
                    <button className="link-btn" onClick={() => open(p.id)}>{p.name}</button>
                  </div>
                  <Badge kind={p.my_role}>{p.my_role}</Badge>
                  <Badge kind={p.status}>{p.status}</Badge>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <div>
          {!selected ? (
            <Card title="Details"><Empty>Pick a project to see charter, people, tasks and history.</Empty></Card>
          ) : (
            <Card
              title={selected.name}
              action={<span><Badge kind={selected.status}>{selected.status}</Badge>{selected.owning_department ? <> <Badge kind="member">{selected.owning_department}</Badge></> : null}</span>}
            >
              {selected.description && <p>{selected.description}</p>}
              {selected.objective && <p><em>Objective: {selected.objective}</em></p>}
              {isHead && selected.status !== 'completed' && selected.status !== 'cancelled' && (
                <div className="btn-row" style={{ margin: '10px 0' }}>
                  <button className="btn btn-sm btn-primary" onClick={() => closeProject('completed')}>Mark completed</button>
                  <button className="btn btn-sm" onClick={() => closeProject('cancelled')}>Cancel project</button>
                  <small className="muted">(needs 0 open tasks — currently {openCount}; finish or cancel them below first)</small>
                </div>
              )}

              <h4>Heads (full access)</h4>
              <ul className="rows">
                {heads.map((m) => (
                  <li key={m.employee_id}>
                    <Avatar first={m.first_name} last={m.last_name} />
                    <div className="grow">
                      {personBtn(m, setProfileId)}
                      <div><small className="muted">rank {m.rank} · {m.department}{m.allocation_pct < 100 ? ` · ${m.allocation_pct}%` : ''}</small></div>
                    </div>
                    <Badge kind={m.role}>{m.role}</Badge>
                  </li>
                ))}
              </ul>

              <h4 className="section-gap">Members</h4>
              {rest.length === 0 ? <Empty>No other members.</Empty> : (
                <ul className="rows">
                  {rest.map((m) => (
                    <li key={m.employee_id}>
                      <Avatar first={m.first_name} last={m.last_name} />
                      <div className="grow">
                        {personBtn(m, setProfileId)}
                        <div><small className="muted">rank {m.rank} · {m.department}{m.allocation_pct < 100 ? ` · ${m.allocation_pct}%${m.is_primary ? '' : ', shared'}` : ''}</small></div>
                      </div>
                      <Badge kind={m.role}>{m.role}</Badge>
                    </li>
                  ))}
                </ul>
              )}

              {canStaff && (
                <div id="people-panel" className="section-gap">
                  {peopleMode === 'remove' ? (
                    <>
                      <h4>Remove people</h4>
                      {(selected.members || []).length === 0 ? <Empty>No members.</Empty> : (
                        <ul className="rows">
                          {(selected.members || []).map((m) => (
                            <li key={m.employee_id}>
                              <Avatar first={m.first_name} last={m.last_name} />
                              <div className="grow">
                                <strong>{m.first_name} {m.last_name}</strong>{' '}
                                <Badge kind={m.role}>{m.role}</Badge>{' '}
                                <small className="muted">rank {m.rank}</small>
                              </div>
                              <button
                                className="btn btn-sm btn-danger"
                                onClick={() => removeMember(m.employee_id, `${m.first_name} ${m.last_name}`)}
                                disabled={outranksMe(m.rank)}
                                title={outranksMe(m.rank) ? 'Higher rank — ask a head or chief' : 'Remove from project'}
                              >Remove</button>
                            </li>
                          ))}
                        </ul>
                      )}
                    </>
                  ) : (
                    <form onSubmit={searchCands}>
                      <h4>Add people (workload shown to avoid overload)</h4>
                      <div className="form-inline">
                        <div className="field">
                          <span>Dept id (blank = all)</span>
                          <input value={candDept} onChange={(e) => setCandDept(e.target.value)} style={{ width: '8em' }} />
                        </div>
                        <div className="field" style={{ flex: 1, minWidth: 140 }}>
                          <span>Search name/email</span>
                          <input value={candQ} onChange={(e) => setCandQ(e.target.value)} />
                        </div>
                        <button className="btn btn-primary" type="submit">Search</button>
                      </div>
                      {cands && (
                        cands.length === 0 ? <Empty>No matching people (members are excluded).</Empty> : (
                          <ul className="rows">
                            {cands.map((c) => {
                              const overloaded = (c.total_alloc ?? 0) >= 100 || (c.open_tasks ?? 0) >= 5;
                              return (
                                <li key={c.id}>
                                  <Avatar first={c.first_name} last={c.last_name} />
                                  <div className="grow">
                                    <strong>{c.first_name} {c.last_name}</strong>{' '}
                                    <small className="muted">rank {c.rank} · {c.department}</small>
                                    <div>
                                      <small className={overloaded ? 'overdue' : 'muted'}>
                                        {c.active_projects} projects · {c.open_tasks} open tasks · {c.total_alloc}% alloc
                                        {overloaded ? ' — HEAVY LOAD' : ''}
                                      </small>
                                    </div>
                                  </div>
                                  <button
                                    className="btn btn-sm btn-primary"
                                    onClick={() => addMember(c.id)}
                                    disabled={outranksMe(c.rank)}
                                    title={outranksMe(c.rank) ? 'Higher rank — ask a head or chief' : 'Add to project'}
                                  >Add</button>
                                </li>
                              );
                            })}
                          </ul>
                        )
                      )}
                    </form>
                  )}
                </div>
              )}

              <h4 className="section-gap">Tasks</h4>
              {(topTasks || []).length === 0 ? <Empty>No tasks yet.</Empty> : (
                <ul className="rows">
                  {topTasks.map((t) => (
                    <li key={t.id} style={{ alignItems: 'flex-start' }}>
                      <div className="grow">
                        <strong>{t.title}</strong> — {t.assignee_first} {t.assignee_last}
                        <div>
                          <Badge kind={t.status}>{t.status}</Badge>{' '}
                          <Badge kind={t.priority}>{t.priority}</Badge>
                          {t.estimate ? <> <Badge kind="member">{t.estimate}</Badge></> : null}
                          {t.due_date ? <small className="muted"> due {String(t.due_date).slice(0, 10)}</small> : null}
                          {t.status === 'blocked' && t.blocked_reason ? <div><small className="overdue">blocked: {t.blocked_reason}</small></div> : null}
                          {t.comment_count ? <div><small className="muted">{t.comment_count} comments</small></div> : null}
                        </div>
                        <div className="btn-row" style={{ marginTop: 6 }}>
                          <select value={taskStatus[t.id] || t.status} onChange={(e) => setStatus(t.id, e.target.value)}>
                            {TASK_STATUS.map((s) => <option key={s} value={s}>{s}</option>)}
                          </select>
                          {(taskStatus[t.id] || t.status) === 'blocked' && (
                            <input
                              placeholder="blocked reason (required)"
                              value={blockedReason[t.id] || ''}
                              onChange={(e) => setBlockedReason((p) => ({ ...p, [t.id]: e.target.value }))}
                            />
                          )}
                          <button className="btn btn-sm" onClick={() => loadComments(t.id)}>Comments</button>
                        </div>
                        {comments[t.id] && (
                          <ul className="rows" style={{ marginTop: 6 }}>
                            {comments[t.id].map((c) => (
                              <li key={c.id}><small><strong>{c.first_name}:</strong> {c.body}</small></li>
                            ))}
                            <li>
                              <form onSubmit={(e) => postComment(e, t.id)} style={{ display: 'flex', gap: 6, width: '100%' }}>
                                <input
                                  placeholder="Add a comment…"
                                  value={commentDraft[t.id] || ''}
                                  onChange={(e) => setCommentDraft((p) => ({ ...p, [t.id]: e.target.value }))}
                                  style={{ flex: 1 }}
                                />
                                <button className="btn btn-sm" type="submit">Post</button>
                              </form>
                            </li>
                          </ul>
                        )}
                        {subsOf(t.id).length > 0 && (
                          <ul className="rows" style={{ marginTop: 6 }}>
                            {subsOf(t.id).map((s) => (
                              <li key={s.id}>
                                <div className="grow">↳ {s.title} — {s.assignee_first} {s.assignee_last}</div>
                                <Badge kind={s.status}>{s.status}</Badge>
                                <select value={taskStatus[s.id] || s.status} onChange={(e) => setStatus(s.id, e.target.value)}>
                                  {TASK_STATUS.map((x) => <option key={x} value={x}>{x}</option>)}
                                </select>
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              )}

              {isHead && (
                <form onSubmit={assignTask} className="section-gap">
                  <h4>Assign work (heads only)</h4>
                  <div className="form-inline">
                    <div className="field" style={{ flex: 1, minWidth: 140 }}>
                      <span>Task title</span>
                      <input value={taskForm.title} onChange={(e) => setTaskForm((f) => ({ ...f, title: e.target.value }))} />
                    </div>
                    <div className="field">
                      <span>Assignee</span>
                      <select value={taskForm.assigned_to} onChange={(e) => setTaskForm((f) => ({ ...f, assigned_to: e.target.value }))}>
                        <option value="">Assignee…</option>
                        {(selected.members || []).map((m) => (
                          <option key={m.employee_id} value={m.employee_id}>{m.first_name} {m.last_name} (rank {m.rank})</option>
                        ))}
                      </select>
                    </div>
                    <div className="field">
                      <span>Priority</span>
                      <select value={taskForm.priority} onChange={(e) => setTaskForm((f) => ({ ...f, priority: e.target.value }))}>
                        {PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
                      </select>
                    </div>
                    <div className="field">
                      <span>Size</span>
                      <select value={taskForm.estimate} onChange={(e) => setTaskForm((f) => ({ ...f, estimate: e.target.value }))}>
                        <option value="">Size…</option>
                        {ESTIMATES.map((x) => <option key={x} value={x}>{x}</option>)}
                      </select>
                    </div>
                    <div className="field">
                      <span>Due</span>
                      <input type="date" value={taskForm.due_date} onChange={(e) => setTaskForm((f) => ({ ...f, due_date: e.target.value }))} />
                    </div>
                    <button className="btn btn-primary" type="submit">Assign</button>
                  </div>
                </form>
              )}

              <h4 className="section-gap">Status updates</h4>
              {(selected.updates || []).length === 0 ? <Empty>No updates yet.</Empty> : (
                <ul className="rows">
                  {(selected.updates || []).map((u) => (
                    <li key={u.id}><div className="grow">{u.body} <small className="muted">({u.first_name} {u.last_name})</small></div></li>
                  ))}
                </ul>
              )}
              <form onSubmit={postUpdate} style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                <input
                  placeholder="Weekly update: done / next / risks…"
                  value={updateDraft}
                  onChange={(e) => setUpdateDraft(e.target.value)}
                  style={{ flex: 1 }}
                />
                <button className="btn" type="submit">Post update</button>
              </form>

              <ProjectChat key={selected.id} projectId={selected.id} members={selected.members || []} />

              <h4 className="section-gap">Activity <small>(every change, who made it, when)</small> <button className="btn btn-sm" onClick={() => loadActivity()}>Refresh</button></h4>
              {activity === null ? (
                <p className="loading">Loading history</p>
              ) : activity.length === 0 ? <Empty>No activity yet.</Empty> : (
                <ul className="rows">
                  {activity.map((a) => (
                    <li key={a.id}>
                      <small>{describeActivity(a)} — {new Date(a.created_at).toLocaleString()}</small>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          )}
        </div>
      </div>
      {profileId && <Profile id={profileId} onClose={() => setProfileId(null)} />}
    </section>
  );
}
