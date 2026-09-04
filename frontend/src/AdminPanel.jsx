import { useEffect, useState } from 'react';
import { api, setToken } from './adminApi.js';

const TABS = ['Overview', 'Employees', 'Domains', 'Access'];

function Err({ msg }) {
  if (!msg) return null;
  return <p style={{ color: 'darkred' }}>Error: {msg}</p>;
}

function Login({ onLogin }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [setupToken, setSetupToken] = useState('');
  const [msg, setMsg] = useState('');

  async function login(e) {
    e.preventDefault();
    setMsg('');
    try {
      const r = await api('/api/admin/login', { method: 'POST', body: { email, password } });
      onLogin(r.token);
    } catch (err) {
      setMsg(err.message);
    }
  }

  async function bootstrap() {
    setMsg('');
    try {
      await api('/api/admin/bootstrap', {
        method: 'POST',
        body: { email, password, setupToken },
      });
      const r = await api('/api/admin/login', { method: 'POST', body: { email, password } });
      onLogin(r.token);
    } catch (err) {
      setMsg(err.message);
    }
  }

  return (
    <section>
      <h2>Admin login</h2>
      <p>Owner (rank 6) or IT department, with a password set up.</p>
      <form onSubmit={login}>
        <input placeholder="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        <input
          placeholder="password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <button type="submit">Log in</button>
      </form>
      <h3>First-time setup</h3>
      <p>Paste the one-time setup token to create a password for the email above, then log in.</p>
      <input
        placeholder="setup token"
        value={setupToken}
        onChange={(e) => setSetupToken(e.target.value)}
      />
      <button onClick={bootstrap}>Create admin access</button>
      <Err msg={msg} />
    </section>
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
  const [creating, setCreating] = useState({ first_name: '', last_name: '', email: '', rank: 2, department_id: '' });

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
      await api('/api/admin/employees', { method: 'POST', body: { ...creating, rank: Number(creating.rank), department_id: Number(creating.department_id) } });
      setCreating({ first_name: '', last_name: '', email: '', rank: 2, department_id: '' });
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
      <form onSubmit={create}>
        <input placeholder="first" value={creating.first_name} onChange={(e) => setCreating({ ...creating, first_name: e.target.value })} />
        <input placeholder="last" value={creating.last_name} onChange={(e) => setCreating({ ...creating, last_name: e.target.value })} />
        <input placeholder="email" value={creating.email} onChange={(e) => setCreating({ ...creating, email: e.target.value })} />
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

  return (
    <section>
      <h2>Access</h2>
      <p>Deactivating removes access immediately (record kept). Rank decides who can delegate to whom.</p>
      <form onSubmit={(e) => { e.preventDefault(); load(); }}>
        <input placeholder="search email / last name" value={q} onChange={(e) => setQ(e.target.value)} />
        <button type="submit">Search</button>
      </form>
      <Err msg={err} />
      <table border="1" cellPadding="4">
        <thead><tr><th>Email</th><th>Name</th><th>Rank</th><th>Dept</th><th>Active</th></tr></thead>
        <tbody>
          {list.rows.map((r) => (
            <tr key={r.id}>
              <td>{r.email}</td>
              <td>{r.first_name} {r.last_name}</td>
              <td>{r.rank}</td>
              <td>{r.department}</td>
              <td><input type="checkbox" checked={r.is_active} onChange={() => toggle(r)} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

export default function AdminPanel() {
  const [authed, setAuthed] = useState(false);
  const [tab, setTab] = useState('Overview');

  function login(token) {
    setToken(token);
    setAuthed(true);
  }
  function logout() {
    api('/api/admin/logout', { method: 'POST' }).catch(() => {});
    setToken(null);
    setAuthed(false);
  }

  if (!authed) return <Login onLogin={login} />;
  return (
    <section>
      <h2>Admin panel</h2>
      {TABS.map((t) => (
        <button key={t} disabled={t === tab} onClick={() => setTab(t)}>{t}</button>
      ))}
      {' '}<button onClick={logout}>Log out</button>
      {tab === 'Overview' && <Overview />}
      {tab === 'Employees' && <Employees />}
      {tab === 'Domains' && <Domains />}
      {tab === 'Access' && <Access />}
    </section>
  );
}
