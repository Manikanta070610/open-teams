import { useEffect, useState } from 'react';
import { api } from './adminApi.js';
import { useAuth } from './AuthContext.jsx';

const TABS = ['Overview', 'Employees', 'Domains', 'Access', 'Security'];

function Err({ msg }) {
  if (!msg) return null;
  return <p style={{ color: 'darkred' }}>Error: {msg}</p>;
}

function InviteCard({ invite, onClose }) {
  if (!invite) return null;
  return (
    <div style={{ border: '2px solid green', padding: 8, margin: '8px 0' }}>
      <strong>Login created — share once, then it’s unrecoverable:</strong>
      <br />Company email: <code>{invite.email}</code>
      <br />Temporary password: <code>{invite.tempPassword}</code>
      <br />
      <small>Send these to the employee’s personal email. They must set a new password on first login.</small>{' '}
      <button onClick={onClose}>Dismiss</button>
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
  if (!data) return <section><Err msg={err} /><p>Loading…</p></section>;
  return (
    <section>
      <h2>Overview</h2>
      <ul>
        <li>Employees: {data.totals.active} active / {data.totals.employees} total</li>
        <li>Allowed email domains: {data.totals.domains}</li>
        <li>Open HR tickets: {data.totals.open_tickets}</li>
        <li>Active projects: {data.totals.active_projects}</li>
      </ul>
      <h3>Headcount by department</h3>
      <table border="1" cellPadding="4">
        <thead><tr><th>Department</th><th>Active</th></tr></thead>
        <tbody>
          {data.byDepartment.map((d) => (
            <tr key={d.department}><td>{d.department}</td><td>{d.headcount}</td></tr>
          ))}
        </tbody>
      </table>
      <Err msg={err} />
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
      <h2>Employees</h2>
      <form onSubmit={search}>
        <input placeholder="search email / last name" value={q} onChange={(e) => setQ(e.target.value)} />
        <button type="submit">Search</button>
      </form>
      <Err msg={err} />
      <table border="1" cellPadding="4">
        <thead><tr><th>ID</th><th>Name</th><th>Email</th><th>Rank</th><th>Dept</th><th>Active</th><th></th></tr></thead>
        <tbody>
          {list.rows.map((r) => (
            <tr key={r.id}>
              <td>{r.id}</td>
              <td>{editing === r.id ? (
                <>
                  <input size="8" defaultValue={r.first_name} onChange={(e) => setForm((f) => ({ ...f, first_name: e.target.value }))} />
                  <input size="8" defaultValue={r.last_name} onChange={(e) => setForm((f) => ({ ...f, last_name: e.target.value }))} />
                </>
              ) : `${r.first_name} ${r.last_name}`}</td>
              <td>{r.email}</td>
              <td>{editing === r.id ? (
                <select defaultValue={r.rank} onChange={(e) => setForm((f) => ({ ...f, rank: Number(e.target.value) }))}>
                  {[1, 2, 3, 4, 5, 6].map((n) => <option key={n} value={n}>{n}</option>)}
                </select>
              ) : r.rank}</td>
              <td>{editing === r.id ? (
                <select defaultValue={r.department_id} onChange={(e) => setForm((f) => ({ ...f, department_id: Number(e.target.value) }))}>
                  {depts.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                </select>
              ) : r.department}</td>
              <td>{r.is_active ? 'yes' : 'no'}</td>
              <td>{editing === r.id ? (
                <><button onClick={() => save(r.id)}>Save</button> <button onClick={() => setEditing(null)}>Cancel</button></>
              ) : <button onClick={() => { setEditing(r.id); setForm({}); }}>Edit</button>}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p>Total {list.total}. Page {page}. <button disabled={page <= 1} onClick={() => setPage(page - 1)}>Prev</button> <button onClick={() => setPage(page + 1)}>Next</button></p>
      <h3>Add employee</h3>
      <p style={{ color: '#555' }}>Company email is the login. The initial password is shown once below — send it to their personal email; they must change it on first login.</p>
      <InviteCard invite={invite} onClose={() => setInvite(null)} />
      <form onSubmit={create}>
        <input placeholder="first" value={creating.first_name} onChange={(e) => setCreating({ ...creating, first_name: e.target.value })} />
        <input placeholder="last" value={creating.last_name} onChange={(e) => setCreating({ ...creating, last_name: e.target.value })} />
        <input placeholder="company email" value={creating.email} onChange={(e) => setCreating({ ...creating, email: e.target.value })} />
        <input placeholder="personal email (invite goes here)" value={creating.contact_email} onChange={(e) => setCreating({ ...creating, contact_email: e.target.value })} />
        <input placeholder="initial password (min 8)" type="password" value={creating.password} onChange={(e) => setCreating({ ...creating, password: e.target.value })} />
        <select value={creating.rank} onChange={(e) => setCreating({ ...creating, rank: e.target.value })}>
          {[1, 2, 3, 4, 5, 6].map((n) => <option key={n} value={n}>rank {n}</option>)}
        </select>
        <select value={creating.department_id} onChange={(e) => setCreating({ ...creating, department_id: e.target.value })}>
          <option value="">department…</option>
          {depts.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
        </select>
        <button type="submit">Add</button>
      </form>
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
    <section>
      <h2>Allowed email domains</h2>
      <p>Only these exact domains can be used for employee emails (enforced by the database).</p>
      <ul>
        {rows.map((r) => (
          <li key={r.id}>@{r.domain} <button onClick={() => remove(r.domain)}>Remove</button></li>
        ))}
      </ul>
      <form onSubmit={add}>
        <input placeholder="company.com" value={domain} onChange={(e) => setDomain(e.target.value)} />
        <button type="submit">Allow domain</button>
      </form>
      <Err msg={err} />
    </section>
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
    <section>
      <h2>Access</h2>
      <p>Deactivating removes access immediately (record kept). Rank decides who can delegate to whom.</p>
      <InviteCard invite={invite} onClose={() => setInvite(null)} />
      <form onSubmit={(e) => { e.preventDefault(); load(); }}>
        <input placeholder="search email / last name" value={q} onChange={(e) => setQ(e.target.value)} />
        <button type="submit">Search</button>
      </form>
      <Err msg={err} />
      <table border="1" cellPadding="4">
        <thead><tr><th>Email</th><th>Name</th><th>Rank</th><th>Dept</th><th>Active</th><th></th></tr></thead>
        <tbody>
          {list.rows.map((r) => (
            <tr key={r.id}>
              <td>{r.email}</td>
              <td>{r.first_name} {r.last_name}</td>
              <td>{r.rank}</td>
              <td>{r.department}</td>
              <td><input type="checkbox" checked={r.is_active} onChange={() => toggle(r)} /></td>
              <td><button onClick={() => resetPassword(r)}>Reset password</button></td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
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
      <h2>Security</h2>
      <Err msg={err} />
      <h3>Session policy</h3>
      <form onSubmit={savePolicy}>
        <label>
          Ask for password again after{' '}
          <input type="number" min="1" max="90" value={days} onChange={(e) => setDays(e.target.value)} style={{ width: '4em' }} />{' '}
          days of inactivity
        </label>{' '}
        <button type="submit">Save</button>
      </form>
      <p style={{ color: '#555' }}>Employees stay signed in automatically until they’re inactive this long (default 7 days). Applies to future sessions; already-idle sessions beyond the new limit are revoked.</p>
      <h3>Admin IP restriction: {policy ? (policy.ipRestrictionEnabled ? 'ON' : 'OFF') : '…'}</h3>
      <form onSubmit={savePolicy}>
        <label>
          <input type="checkbox" checked={restrict} onChange={(e) => setRestrict(e.target.checked)} />{' '}
          Restrict admin logins to the IPs below
        </label>{' '}
        <button type="submit">Save</button>
      </form>
      <p style={{ border: '1px solid #ccc', padding: 8 }}>
        Employees can always log in from anywhere. When this is <strong>ON</strong>, admin accounts
        only work from the listed IPs — any other network is blocked even with the right password.
        When <strong>OFF</strong>, admins can log in from any network. {ips.length === 0 && restrict && (
          <strong style={{ color: 'darkred' }}> Warning: the list is empty, so NO admin can log in until you add an IP.</strong>
        )}
      </p>
      <ul>
        {ips.map((r) => (
          <li key={r.id}><code>{r.cidr}</code> {r.label ? `(${r.label})` : ''} <button onClick={() => removeIp(r.id, r.cidr)}>Remove</button></li>
        ))}
      </ul>
      <form onSubmit={addIp}>
        <input placeholder="203.0.113.8 or 203.0.113.0/24" value={newIp} onChange={(e) => setNewIp(e.target.value)} style={{ width: '20em' }} />
        <input placeholder="label (e.g. office)" value={label} onChange={(e) => setLabel(e.target.value)} />
        <button type="submit">Allow IP</button>
      </form>
      <h3>Recent auth activity</h3>
      <ul>
        {auditRows.map((r) => (
          <li key={r.id}>{r.created_at} — {r.action} {r.ip ? `(${r.ip})` : ''}</li>
        ))}
      </ul>
    </section>
  );
}

export default function AdminPanel() {
  const { logout } = useAuth();
  const [tab, setTab] = useState('Overview');

  return (
    <section>
      <h2>Admin panel</h2>
      {TABS.map((t) => (
        <button key={t} disabled={t === tab} onClick={() => setTab(t)}>{t}</button>
      ))}
      {' '}<button onClick={() => logout(false)}>Log out</button>
      {tab === 'Overview' && <Overview />}
      {tab === 'Employees' && <Employees />}
      {tab === 'Domains' && <Domains />}
      {tab === 'Access' && <Access />}
      {tab === 'Security' && <Security />}
    </section>
  );
}
