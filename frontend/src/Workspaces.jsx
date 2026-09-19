import { useEffect, useState } from 'react';
import { api } from './adminApi.js';
import { useAuth } from './AuthContext.jsx';
import { Alert, Avatar, Badge, Card, Empty } from './ui.jsx';

// Workspaces tab: additive view reusing the same auth/fetch patterns as
// Directory (abortable fetch, 401 -> sessionExpired, inline error/empty states).
// No changes to login, session, or admin flows.
export default function Workspaces() {
  const { user, sessionExpired, policyDays } = useAuth();
  const [list, setList] = useState(null);
  const [err, setErr] = useState('');
  const [selected, setSelected] = useState(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [creating, setCreating] = useState(false);
  const [reqForm, setReqForm] = useState({ requirements: '', headcount: 1, priority: 'medium' });

  const canCreate = !!user && (Number(user.rank) >= 5 || user.isAdmin);
  const canStaff = !!user && (user.dept_name === 'HR' || Number(user.rank) >= 5 || user.isAdmin);

  function load() {
    const c = new AbortController();
    setErr('');
    api('/api/workspaces', { signal: c.signal })
      .then((rows) => setList(Array.isArray(rows) ? rows : []))
      .catch((e) => {
        if (e.name === 'AbortError') return;
        if (e.status === 401) sessionExpired(policyDays);
        else setErr(e.message);
      });
    return () => c.abort();
  }

  useEffect(load, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function open(id) {
    setErr('');
    try {
      setSelected(await api(`/api/workspaces/${id}`));
    } catch (e) {
      if (e.status === 401) sessionExpired(policyDays);
      else if (e.status === 404) setErr('Not a member of this workspace.');
      else setErr(e.message);
    }
  }

  async function create(e) {
    e.preventDefault();
    if (!name.trim()) {
      setErr('Workspace name is required.');
      return;
    }
    setCreating(true);
    setErr('');
    try {
      const ws = await api('/api/workspaces', {
        method: 'POST',
        body: { name: name.trim(), description: description.trim() || undefined },
      });
      setName('');
      setDescription('');
      setList((prev) => (prev ? [ws, ...prev] : [ws]));
      setSelected(ws);
    } catch (e2) {
      if (e2.status === 401) sessionExpired(policyDays);
      else setErr(e2.message);
    } finally {
      setCreating(false);
    }
  }

  async function staffRequest(e) {
    e.preventDefault();
    if (!selected) return;
    setErr('');
    try {
      const r = await api(`/api/workspaces/${selected.id}/staff-requests`, {
        method: 'POST',
        body: {
          requirements: reqForm.requirements || undefined,
          headcount: Number(reqForm.headcount) || 1,
          priority: reqForm.priority,
        },
      });
      setSelected((prev) => (prev ? { ...prev, staff_requests: [r, ...(prev.staff_requests || [])] } : prev));
      setReqForm({ requirements: '', headcount: 1, priority: 'medium' });
    } catch (e2) {
      if (e2.status === 401) sessionExpired(policyDays);
      else setErr(e2.message);
    }
  }

  async function promote(empId, role) {
    if (!selected) return;
    setErr('');
    try {
      setSelected(await api(`/api/workspaces/${selected.id}/members/${empId}`, { method: 'PATCH', body: { role } }));
    } catch (e2) {
      if (e2.status === 401) sessionExpired(policyDays);
      else setErr(e2.message);
    }
  }

  const myWsRole = selected?.members?.find((m) => Number(m.employee_id) === Number(user?.id))?.role;
  const canPromote = !!user && (myWsRole === 'owner' || Number(user.rank) >= 5 || user.isAdmin);

  return (
    <section>
      <div className="page-head">
        <h1>Workspaces</h1>
        <p className="page-sub">Team homes — staffing runs through requests.</p>
      </div>
      {err && <Alert>{err}</Alert>}
      {canCreate && (
        <Card title="New workspace">
          <p className="muted">Chiefs and admins only.</p>
          <form onSubmit={create}>
            <div className="form-inline">
              <div className="field">
                <span>Workspace name</span>
                <input value={name} onChange={(e) => setName(e.target.value)} />
              </div>
              <div className="field" style={{ flex: 1, minWidth: 200 }}>
                <span>Description (optional)</span>
                <input value={description} onChange={(e) => setDescription(e.target.value)} />
              </div>
              <button className="btn btn-primary" type="submit" disabled={creating}>{creating ? 'Creating…' : 'Create'}</button>
            </div>
          </form>
        </Card>
      )}
      <div className="grid cols-2">
        <Card title="My workspaces">
          {list === null ? (
            <p className="loading">Loading</p>
          ) : list.length === 0 ? (
            <Empty>No workspaces yet. Chiefs or admins can create one above.</Empty>
          ) : (
            <ul className="rows">
              {list.map((w) => (
                <li key={w.id} style={selected?.id === w.id ? { background: 'var(--brand-soft)', borderRadius: 8 } : undefined}>
                  <div className="grow">
                    <button className="link-btn" onClick={() => open(w.id)}>{w.name}</button>
                  </div>
                  <Badge kind={w.my_role}>{w.my_role}</Badge>
                  {w.my_allocation != null && w.my_allocation < 100 && (
                    <small className="muted">{w.my_allocation}%</small>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Card>
        <div>
          {!selected ? (
            <Card title="Details"><Empty>Pick a workspace to see members and requests.</Empty></Card>
          ) : (
            <Card
              title={selected.name}
              action={selected.status ? <Badge kind={selected.status}>{selected.status}</Badge> : null}
            >
              {selected.description && <p className="muted">{selected.description}</p>}
              <h4>Members</h4>
              {(selected.members || []).length === 0 ? (
                <Empty>No members.</Empty>
              ) : (
                <ul className="rows">
                  {(selected.members || []).map((m) => (
                    <li key={m.employee_id}>
                      <Avatar first={m.first_name} last={m.last_name} />
                      <div className="grow">
                        <strong>{m.first_name} {m.last_name}</strong>
                        <div>
                          <small className="muted">
                            {m.allocation_pct < 100 ? `${m.allocation_pct}%${m.is_primary ? '' : ', shared'}` : 'full-time'}
                          </small>
                        </div>
                      </div>
                      <Badge kind={m.role}>{m.role}</Badge>
                      {(m.role === 'owner' || m.role === 'lead') && <Badge kind="head">head</Badge>}
                      {canPromote && (
                        <select value={m.role} onChange={(e) => promote(m.employee_id, e.target.value)} title="Head = owner/lead (any rank)">
                          <option value="owner">owner</option>
                          <option value="lead">lead</option>
                          <option value="member">member</option>
                          <option value="viewer">viewer</option>
                        </select>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              <h4 className="section-gap">Staffing requests</h4>
              {(selected.staff_requests || []).length === 0 ? (
                <Empty>No staffing requests.</Empty>
              ) : (
                <ul className="rows">
                  {(selected.staff_requests || []).map((r) => (
                    <li key={r.id}>
                      <div className="grow">
                        <strong>{r.headcount} needed</strong>
                        {r.ranks_needed?.length ? ` (ranks ${r.ranks_needed.join(', ')})` : ''}
                        {r.requirements ? <div><small className="muted">{r.requirements}</small></div> : null}
                      </div>
                      <Badge kind={r.priority}>{r.priority}</Badge>
                      <Badge kind="member">{r.status}</Badge>
                    </li>
                  ))}
                </ul>
              )}
              <h4 className="section-gap">Request people</h4>
              {canStaff && <p className="muted">HR staffs via Admin → Employees, then adds here.</p>}
              <form onSubmit={staffRequest}>
                <div className="form-inline">
                  <div className="field" style={{ flex: 1, minWidth: 160 }}>
                    <span>Requirements (optional)</span>
                    <input
                      value={reqForm.requirements}
                      onChange={(e) => setReqForm((f) => ({ ...f, requirements: e.target.value }))}
                    />
                  </div>
                  <div className="field">
                    <span>Headcount</span>
                    <input
                      type="number"
                      min="1"
                      max="100"
                      value={reqForm.headcount}
                      onChange={(e) => setReqForm((f) => ({ ...f, headcount: e.target.value }))}
                      style={{ width: '5em' }}
                    />
                  </div>
                  <div className="field">
                    <span>Priority</span>
                    <select
                      value={reqForm.priority}
                      onChange={(e) => setReqForm((f) => ({ ...f, priority: e.target.value }))}
                    >
                      <option value="low">low</option>
                      <option value="medium">medium</option>
                      <option value="high">high</option>
                      <option value="urgent">urgent</option>
                    </select>
                  </div>
                  <button className="btn btn-primary" type="submit">Request</button>
                </div>
              </form>
            </Card>
          )}
        </div>
      </div>
    </section>
  );
}
