import { useEffect, useState } from 'react';
import { api } from './adminApi.js';
import { useAuth } from './AuthContext.jsx';
import { Alert, Avatar, Badge, Card, Empty, Stat } from './ui.jsx';

const TABS = ['Overview', 'Employees', 'Domains', 'Access', 'Security'];

function InviteCard({ invite, onClose }) {
  if (!invite) return null;
  return (
    <div className="invite-box">
      <strong>Login created — share once, then it’s unrecoverable:</strong>
      <br />Company email: <code>{invite.email}</code>
      <br />Temporary password: <code>{invite.tempPassword}</code>
      <br />
      <small className="muted">Send these to the employee’s personal email. They must set a new password on first login.</small>{' '}
      <button className="btn btn-sm" onClick={onClose}>Dismiss</button>
    </div>
  );
}

function Overview() {
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    const c = new AbortController();
    api('/api/admin/overview', { signal: c.signal })
      .then(setData)
      .catch((e) => {
        if (e.name !== 'AbortError') setErr(e.message);
      });
    return () => c.abort();
  }, []);
  if (!data) return <section>{err && <Alert>{err}</Alert>}<p className="loading">Loading</p></section>;
  return (
    <section>
      <div className="grid stats">
        <Stat num={`${data.totals.active} / ${data.totals.employees}`} label="Active / total staff" />
        <Stat num={data.totals.domains} label="Email domains" />
        <Stat num={data.totals.open_tickets} label="Open HR tickets" />
        <Stat num={data.totals.active_projects} label="Active projects" />
      </div>
      <Card title="Headcount by department">
        <div className="table-wrap">
          <table className="grid-table">
            <thead><tr><th>Department</th><th>Active</th></tr></thead>
            <tbody>
              {data.byDepartment.map((d) => (
                <tr key={d.department}><td><strong>{d.department}</strong></td><td>{d.headcount}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
      {err && <Alert>{err}</Alert>}
    </section>
  );
}

function useDepartments() {
  const [depts, setDepts] = useState([]);
  useEffect(() => {
    const c = new AbortController();
    api('/api/admin/departments', { signal: c.signal }).then(setDepts).catch(() => {});
    return () => c.abort();
  }, []);
  return depts;
}

function Employees() {
  const depts = useDepartments();
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [list, setList] = useState({ rows: [], total: 0 });
  const [err, setErr] = useState('');
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState({});
  const [creating, setCreating] = useState({ first_name: '', last_name: '', email: '', contact_email: '', password: '', rank: 2, department_id: '' });
  const [invite, setInvite] = useState(null);

  async function load(p = page, query = q, signal) {
    try {
      const r = await api(`/api/admin/employees?q=${encodeURIComponent(query)}&page=${p}&limit=25`, { signal });
      setList(r);
      setErr('');
    } catch (e) {
      if (e.name !== 'AbortError') setErr(e.message);
    }
  }

  useEffect(() => {
    const c = new AbortController();
    load(page, q, c.signal);
    return () => c.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page]);

  function search(e) {
    e.preventDefault();
    setPage(1);
    load(1, q);
  }

  async function create(e) {
    e.preventDefault();
    try {
      const r = await api('/api/admin/employees', { method: 'POST', body: { ...creating, rank: Number(creating.rank), department_id: Number(creating.department_id), password: creating.password || undefined, contact_email: creating.contact_email || undefined } });
      setCreating({ first_name: '', last_name: '', email: '', contact_email: '', password: '', rank: 2, department_id: '' });
      if (r.tempPassword) setInvite({ email: r.email, tempPassword: r.tempPassword });
      load(1, '');
    } catch (e2) {
      setErr(e2.message);
    }
  }

  async function save(id) {
    try {
      await api(`/api/admin/employees/${id}`, { method: 'PATCH', body: form });
      setEditing(null);
      load();
    } catch (e) {
      setErr(e.message);
    }
  }

  return (
    <section>
      <Card title="Employees">
        <form onSubmit={search}>
          <div className="form-inline">
            <div className="field" style={{ flex: 1, minWidth: 200 }}>
              <span>Search email / last name</span>
              <input value={q} onChange={(e) => setQ(e.target.value)} />
            </div>
            <button className="btn btn-primary" type="submit">Search</button>
          </div>
        </form>
        {err && <Alert>{err}</Alert>}
        <div className="table-wrap" style={{ marginTop: 12 }}>
          <table className="grid-table">
            <thead><tr><th>ID</th><th>Name</th><th>Email</th><th>Rank</th><th>Dept</th><th>Active</th><th></th></tr></thead>
            <tbody>
              {list.rows.map((r) => (
                <tr key={r.id}>
                  <td className="muted">{r.id}</td>
                  <td>{editing === r.id ? (
                    <span style={{ display: 'inline-flex', gap: 6 }}>
                      <input size="8" defaultValue={r.first_name} onChange={(e) => setForm((f) => ({ ...f, first_name: e.target.value }))} />
                      <input size="8" defaultValue={r.last_name} onChange={(e) => setForm((f) => ({ ...f, last_name: e.target.value }))} />
                    </span>
                  ) : (
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                      <Avatar first={r.first_name} last={r.last_name} />
                      <strong>{r.first_name} {r.last_name}</strong>
                    </span>
                  )}</td>
                  <td className="muted">{r.email}</td>
                  <td>{editing === r.id ? (
                    <select defaultValue={r.rank} onChange={(e) => setForm((f) => ({ ...f, rank: Number(e.target.value) }))}>
                      {[1, 2, 3, 4, 5, 6].map((n) => <option key={n} value={n}>{n}</option>)}
                    </select>
                  ) : <Badge kind="rank">R{r.rank}</Badge>}</td>
                  <td>{editing === r.id ? (
                    <select defaultValue={r.department_id} onChange={(e) => setForm((f) => ({ ...f, department_id: Number(e.target.value) }))}>
                      {depts.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                    </select>
                  ) : r.department}</td>
                  <td>{r.is_active ? <Badge kind="done">yes</Badge> : <Badge kind="blocked">no</Badge>}</td>
                  <td>{editing === r.id ? (
                    <span className="btn-row">
                      <button className="btn btn-sm btn-primary" onClick={() => save(r.id)}>Save</button>
                      <button className="btn btn-sm" onClick={() => setEditing(null)}>Cancel</button>
                    </span>
                  ) : <button className="btn btn-sm" onClick={() => { setEditing(r.id); setForm({}); }}>Edit</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="muted" style={{ marginTop: 10 }}>
          Total {list.total} · Page {page}{' '}
          <button className="btn btn-sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>Prev</button>{' '}
          <button className="btn btn-sm" onClick={() => setPage(page + 1)}>Next</button>
        </p>
      </Card>
      <Card title="Add employee">
        <p className="muted">Company email is the login. The initial password is shown once below — send it to their personal email; they must change it on first login.</p>
        <InviteCard invite={invite} onClose={() => setInvite(null)} />
        <form onSubmit={create}>
          <div className="form-inline">
            <div className="field"><span>First</span><input value={creating.first_name} onChange={(e) => setCreating({ ...creating, first_name: e.target.value })} /></div>
            <div className="field"><span>Last</span><input value={creating.last_name} onChange={(e) => setCreating({ ...creating, last_name: e.target.value })} /></div>
            <div className="field"><span>Company email</span><input value={creating.email} onChange={(e) => setCreating({ ...creating, email: e.target.value })} /></div>
            <div className="field"><span>Personal email (invite)</span><input value={creating.contact_email} onChange={(e) => setCreating({ ...creating, contact_email: e.target.value })} /></div>
            <div className="field"><span>Initial password (min 8)</span><input type="password" value={creating.password} onChange={(e) => setCreating({ ...creating, password: e.target.value })} /></div>
            <div className="field"><span>Rank</span>
              <select value={creating.rank} onChange={(e) => setCreating({ ...creating, rank: e.target.value })}>
                {[1, 2, 3, 4, 5, 6].map((n) => <option key={n} value={n}>rank {n}</option>)}
              </select>
            </div>
            <div className="field"><span>Department</span>
              <select value={creating.department_id} onChange={(e) => setCreating({ ...creating, department_id: e.target.value })}>
                <option value="">department…</option>
                {depts.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
              </select>
            </div>
            <button className="btn btn-primary" type="submit">Add</button>
          </div>
        </form>
      </Card>
    </section>
  );
}

function Domains() {
  const [rows, setRows] = useState([]);
  const [domain, setDomain] = useState('');
  const [err, setErr] = useState('');

  async function load(signal) {
    try {
      setRows(await api('/api/admin/email-domains', { signal }));
      setErr('');
    } catch (e) {
      if (e.name !== 'AbortError') setErr(e.message);
    }
  }
  useEffect(() => {
    const c = new AbortController();
    load(c.signal);
    return () => c.abort();
  }, []);

  async function add(e) {
    e.preventDefault();
    try {
      await api('/api/admin/email-domains', { method: 'POST', body: { domain } });
      setDomain('');
      load();
    } catch (e2) {
      setErr(e2.message);
    }
  }

  async function remove(d) {
    if (!window.confirm(`Stop allowing @${d}? Existing employees keep their emails.`)) return;
    try {
      await api(`/api/admin/email-domains/${encodeURIComponent(d)}`, { method: 'DELETE' });
      load();
    } catch (e) {
      setErr(e.message);
    }
  }

  return (
    <Card title="Allowed email domains">
      <p className="muted">Only these exact domains can be used for employee emails (enforced by the database).</p>
      {rows.length === 0 ? <Empty>No domains allowed yet.</Empty> : (
        <ul className="rows">
          {rows.map((r) => (
            <li key={r.id}>
              <div className="grow"><code>@{r.domain}</code></div>
              <button className="btn btn-sm btn-danger" onClick={() => remove(r.domain)}>Remove</button>
            </li>
          ))}
        </ul>
      )}
      <form onSubmit={add} style={{ marginTop: 12 }}>
        <div className="form-inline">
          <div className="field"><span>Domain</span><input placeholder="company.com" value={domain} onChange={(e) => setDomain(e.target.value)} /></div>
          <button className="btn btn-primary" type="submit">Allow domain</button>
        </div>
      </form>
      {err && <Alert>{err}</Alert>}
    </Card>
  );
}

function Access() {
  const [q, setQ] = useState('');
  const [list, setList] = useState({ rows: [], total: 0 });
  const [err, setErr] = useState('');
  const [invite, setInvite] = useState(null);

  async function load(signal) {
    try {
      const r = await api(`/api/admin/employees?q=${encodeURIComponent(q)}&page=1&limit=50`, { signal });
      setList(r);
      setErr('');
    } catch (e) {
      if (e.name !== 'AbortError') setErr(e.message);
    }
  }
  useEffect(() => {
    const c = new AbortController();
    load(c.signal);
    return () => c.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function toggle(r) {
    if (!r.is_active || window.confirm(`Deactivate ${r.email}? They lose access immediately.`)) {
      try {
        await api(`/api/admin/employees/${r.id}`, { method: 'PATCH', body: { is_active: !r.is_active } });
        load();
      } catch (e) {
        setErr(e.message);
      }
    }
  }

  async function resetPassword(r) {
    if (!window.confirm(`Reset password for ${r.email}? They get a temporary password and must change it on next login. All their sessions are revoked.`)) return;
    try {
      const res = await api(`/api/admin/employees/${r.id}/reset-password`, { method: 'POST' });
      setInvite({ email: r.email, tempPassword: res.tempPassword });
      setErr('');
    } catch (e) {
      setErr(e.message);
    }
  }

  return (
    <Card title="Access">
      <p className="muted">Deactivating removes access immediately (record kept). Rank decides who can delegate to whom.</p>
      <InviteCard invite={invite} onClose={() => setInvite(null)} />
      <form onSubmit={(e) => { e.preventDefault(); load(); }}>
        <div className="form-inline">
          <div className="field" style={{ flex: 1, minWidth: 200 }}>
            <span>Search email / last name</span>
            <input value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <button className="btn btn-primary" type="submit">Search</button>
        </div>
      </form>
      {err && <Alert>{err}</Alert>}
      <div className="table-wrap" style={{ marginTop: 12 }}>
        <table className="grid-table">
          <thead><tr><th>Email</th><th>Name</th><th>Rank</th><th>Dept</th><th>Active</th><th></th></tr></thead>
          <tbody>
            {list.rows.map((r) => (
              <tr key={r.id}>
                <td className="muted">{r.email}</td>
                <td><strong>{r.first_name} {r.last_name}</strong></td>
                <td><Badge kind="rank">R{r.rank}</Badge></td>
                <td>{r.department}</td>
                <td><input type="checkbox" checked={r.is_active} onChange={() => toggle(r)} title={r.is_active ? 'Deactivate' : 'Reactivate'} /></td>
                <td><button className="btn btn-sm" onClick={() => resetPassword(r)}>Reset password</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function Security() {
  const [policy, setPolicy] = useState(null);
  const [days, setDays] = useState(7);
  const [restrict, setRestrict] = useState(false);
  const [ips, setIps] = useState([]);
  const [newIp, setNewIp] = useState('');
  const [label, setLabel] = useState('');
  const [auditRows, setAuditRows] = useState([]);
  const [err, setErr] = useState('');

  async function load(signal) {
    try {
      const p = await api('/api/admin/auth-policy', { signal });
      setPolicy(p);
      setDays(p.inactivityTimeoutDays);
      setRestrict(p.ipRestrictionEnabled);
      setIps(await api('/api/admin/allowed-ips', { signal }));
      setAuditRows(await api('/api/admin/audit?limit=30', { signal }));
      setErr('');
    } catch (e) {
      if (e.name !== 'AbortError') setErr(e.message);
    }
  }
  useEffect(() => {
    const c = new AbortController();
    load(c.signal);
    return () => c.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function savePolicy(e) {
    e.preventDefault();
    try {
      const p = await api('/api/admin/auth-policy', {
        method: 'PATCH',
        body: { inactivityTimeoutDays: Number(days), ipRestrictionEnabled: restrict },
      });
      setPolicy(p);
      setErr('');
    } catch (e2) {
      setErr(e2.message);
    }
  }

  async function addIp(e) {
    e.preventDefault();
    try {
      await api('/api/admin/allowed-ips', { method: 'POST', body: { cidr: newIp, label } });
      setNewIp('');
      setLabel('');
      load();
    } catch (e2) {
      setErr(e2.message);
    }
  }

  async function removeIp(id, cidr) {
    if (!window.confirm(`Remove ${cidr} from admin access? Admins on that network lose access immediately.`)) return;
    try {
      await api(`/api/admin/allowed-ips/${id}`, { method: 'DELETE' });
      load();
    } catch (e) {
      setErr(e.message);
    }
  }

  return (
    <section>
      {err && <Alert>{err}</Alert>}
      <Card title="Session policy">
        <form onSubmit={savePolicy}>
          <div className="form-inline">
            <div className="field">
              <span>Ask for password again after (days of inactivity)</span>
              <input type="number" min="1" max="90" value={days} onChange={(e) => setDays(e.target.value)} style={{ width: '6em' }} />
            </div>
            <button className="btn btn-primary" type="submit">Save</button>
          </div>
        </form>
        <p className="muted">Employees stay signed in automatically until they’re inactive this long (default 7 days). Applies to future sessions; already-idle sessions beyond the new limit are revoked.</p>
      </Card>
      <Card
        title={<>Admin IP restriction: {policy ? (policy.ipRestrictionEnabled ? <Badge kind="blocked">ON</Badge> : <Badge kind="done">OFF</Badge>) : '…'}</>}
      >
        <form onSubmit={savePolicy}>
          <label className="check">
            <input type="checkbox" checked={restrict} onChange={(e) => setRestrict(e.target.checked)} />{' '}
            Restrict admin logins to the IPs below
          </label>{' '}
          <button className="btn btn-primary btn-sm" type="submit">Save</button>
        </form>
        <Alert kind="note">
          Employees can always log in from anywhere. When this is <strong>ON</strong>, admin accounts
          only work from the listed IPs — any other network is blocked even with the right password.
          When <strong>OFF</strong>, admins can log in from any network. {ips.length === 0 && restrict && (
            <strong> Warning: the list is empty, so NO admin can log in until you add an IP.</strong>
          )}
        </Alert>
        {ips.length === 0 ? <Empty>No allowed IPs.</Empty> : (
          <ul className="rows">
            {ips.map((r) => (
              <li key={r.id}>
                <div className="grow"><code>{r.cidr}</code> {r.label ? <small className="muted">({r.label})</small> : ''}</div>
                <button className="btn btn-sm btn-danger" onClick={() => removeIp(r.id, r.cidr)}>Remove</button>
              </li>
            ))}
          </ul>
        )}
        <form onSubmit={addIp} style={{ marginTop: 12 }}>
          <div className="form-inline">
            <div className="field" style={{ flex: 1, minWidth: 200 }}>
              <span>IP or range</span>
              <input placeholder="203.0.113.8 or 203.0.113.0/24" value={newIp} onChange={(e) => setNewIp(e.target.value)} />
            </div>
            <div className="field">
              <span>Label</span>
              <input placeholder="e.g. office" value={label} onChange={(e) => setLabel(e.target.value)} />
            </div>
            <button className="btn btn-primary" type="submit">Allow IP</button>
          </div>
        </form>
      </Card>
      <Card title="Recent auth activity">
        {auditRows.length === 0 ? <Empty>No recent activity.</Empty> : (
          <ul className="rows">
            {auditRows.map((r) => (
              <li key={r.id}>
                <div className="grow">
                  <Badge kind="member">{r.action}</Badge>{' '}
                  {r.ip ? <code>{r.ip}</code> : null}
                </div>
                <small className="muted">{r.created_at}</small>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </section>
  );
}

export default function AdminPanel() {
  const { logout } = useAuth();
  const [tab, setTab] = useState('Overview');

  return (
    <section>
      <div className="page-head">
        <h1>Admin panel</h1>
        <p className="page-sub">Back-office controls — people, access and security.</p>
      </div>
      <div className="tabs">
        {TABS.map((t) => (
          <button key={t} className={t === tab ? 'tab active' : 'tab'} onClick={() => setTab(t)}>{t}</button>
        ))}
        <span style={{ flex: 1 }} />
        <button className="tab" onClick={() => logout(false)}>Log out</button>
      </div>
      {tab === 'Overview' && <Overview />}
      {tab === 'Employees' && <Employees />}
      {tab === 'Domains' && <Domains />}
      {tab === 'Access' && <Access />}
      {tab === 'Security' && <Security />}
    </section>
  );
}
