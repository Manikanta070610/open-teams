import { useEffect, useState } from 'react';
import { api } from './adminApi.js';
import { useAuth } from './AuthContext.jsx';

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
      <h2>Workspaces</h2>
      {err && <p style={{ color: 'darkred' }}>Error: {err}</p>}
      {canCreate && (
        <form onSubmit={create}>
          <h3>New workspace (chiefs & admins)</h3>
          <input placeholder="Workspace name" value={name} onChange={(e) => setName(e.target.value)} />{' '}
          <input
            placeholder="Description (optional)"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            style={{ width: '24em' }}
          />{' '}
          <button type="submit" disabled={creating}>Create</button>
        </form>
      )}
      {list === null ? (
        <p>Loading…</p>
      ) : list.length === 0 ? (
        <p>No workspaces yet. Chiefs or admins can create one above.</p>
      ) : (
        <ul>
          {list.map((w) => (
            <li key={w.id}>
              <button onClick={() => open(w.id)}>{w.name}</button>{' '}
              <small>({w.my_role}{w.my_allocation != null && w.my_allocation < 100 ? `, ${w.my_allocation}%` : ''})</small>
            </li>
          ))}
        </ul>
      )}
      {selected && (
        <article style={{ border: '1px solid #ccc', padding: 8, marginTop: 8 }}>
          <h3>{selected.name}</h3>
          {selected.description && <p>{selected.description}</p>}
          <h4>Members</h4>
          {(selected.members || []).length === 0 ? (
            <p>No members.</p>
          ) : (
            <ul>
              {(selected.members || []).map((m) => (
                <li key={m.employee_id}>
                  {m.first_name} {m.last_name} — {m.role}
                  {(m.role === 'owner' || m.role === 'lead') && <strong> [HEAD]</strong>}
                  {m.allocation_pct < 100 ? ` (${m.allocation_pct}%${m.is_primary ? '' : ', shared'})` : ' (full-time)'}
                  {canPromote && (
                    <>
                      {' '}
                      <select value={m.role} onChange={(e) => promote(m.employee_id, e.target.value)} title="Head = owner/lead (any rank)">
                        <option value="owner">owner</option>
                        <option value="lead">lead</option>
                        <option value="member">member</option>
                        <option value="viewer">viewer</option>
                      </select>
                    </>
                  )}
                </li>
              ))}
            </ul>
          )}
          <h4>Staffing requests</h4>
          {(selected.staff_requests || []).length === 0 ? (
            <p>No staffing requests.</p>
          ) : (
            <ul>
              {(selected.staff_requests || []).map((r) => (
                <li key={r.id}>
                  {r.headcount} needed{r.ranks_needed?.length ? ` (ranks ${r.ranks_needed.join(',')})` : ''} —{' '}
                  {r.priority} — {r.status}
                  {r.requirements ? `: ${r.requirements}` : ''}
                </li>
              ))}
            </ul>
          )}
          <form onSubmit={staffRequest}>
            <h4>Request people {canStaff ? '(HR staffs via Admin → Employees, then adds here)' : ''}</h4>
            <input
              placeholder="Requirements (optional)"
              value={reqForm.requirements}
              onChange={(e) => setReqForm((f) => ({ ...f, requirements: e.target.value }))}
              style={{ width: '24em' }}
            />{' '}
            <input
              type="number"
              min="1"
              max="100"
              value={reqForm.headcount}
              onChange={(e) => setReqForm((f) => ({ ...f, headcount: e.target.value }))}
              style={{ width: '5em' }}
            />{' '}
            <select
              value={reqForm.priority}
              onChange={(e) => setReqForm((f) => ({ ...f, priority: e.target.value }))}
            >
              <option value="low">low</option>
              <option value="medium">medium</option>
              <option value="high">high</option>
              <option value="urgent">urgent</option>
            </select>{' '}
            <button type="submit">Request</button>
          </form>
        </article>
      )}
    </section>
  );
}
