import { useEffect, useState } from 'react';
import { api } from './adminApi.js';
import { AuthProvider, useAuth } from './AuthContext.jsx';
import Login from './Login.jsx';
import ChangePassword from './ChangePassword.jsx';
import Dashboard from './Dashboard.jsx';
import Projects from './Projects.jsx';
import Workspaces from './Workspaces.jsx';
import Chat from './Chat.jsx';
import { Avatar, Badge, Card } from './ui.jsx';

// Public employee app: no admin imports. AdminPanel lives only in the
// admin bundle (AdminApp.jsx served on the admin port).

const NAV = [
  { id: 'dashboard', label: 'My work' },
  { id: 'projects', label: 'Projects' },
  { id: 'workspaces', label: 'Workspaces' },
  { id: 'chat', label: 'Chat' },
  { id: 'directory', label: 'Directory' },
];

function Directory() {
  const [health, setHealth] = useState('checking...');
  const [employees, setEmployees] = useState([]);
  const { sessionExpired, policyDays } = useAuth();

  useEffect(() => {
    const c = new AbortController();
    api('/api/employees', { signal: c.signal })
      .then((rows) => {
        setEmployees(Array.isArray(rows) ? rows : []);
        setHealth('ok');
      })
      .catch((e) => {
        if (e.name === 'AbortError') return;
        if (e.status === 401) sessionExpired(policyDays);
        else setHealth('backend unreachable (dev: start backend on :4000)');
      });
    return () => c.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <>
      <div className="page-head">
        <h1>Directory</h1>
        <p className="page-sub">
          Everyone in the company · backend: {health}
        </p>
      </div>
      <Card title={`Employees (${employees.length})`}>
        {employees.length === 0 ? (
          <p className="muted">No data (backend not running or empty).</p>
        ) : (
          <div className="table-wrap">
            <table className="grid-table">
              <thead><tr><th>Name</th><th>Email</th><th>Rank</th></tr></thead>
              <tbody>
                {employees.map((e) => (
                  <tr key={e.id}>
                    <td>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}>
                        <Avatar first={e.first_name} last={e.last_name} />
                        <strong>{e.first_name} {e.last_name}</strong>
                      </span>
                    </td>
                    <td className="muted">{e.email}</td>
                    <td><Badge kind="rank">R{e.rank}</Badge></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <Card title="My account">
        <ChangePassword forced={false} />
      </Card>
    </>
  );
}

function Shell() {
  const { status, user, mustChange, logout } = useAuth();
  const [view, setView] = useState('dashboard');

  if (status === 'checking') {
    return (
      <div className="auth-page">
        <div className="auth-card"><p className="loading">Signing you back in</p></div>
      </div>
    );
  }
  if (status === 'anon') {
    return (
      <div className="auth-page">
        <div>
          <div className="auth-card">
            <div className="auth-brand">Office HQ</div>
            <p className="auth-sub">Employee portal — sign in to get to work.</p>
            <Login />
          </div>
        </div>
      </div>
    );
  }
  if (mustChange) {
    return (
      <div className="auth-page">
        <div className="auth-card">
          <div className="auth-brand">Office HQ</div>
          <p className="auth-sub">
            Signed in as <strong>{user.email}</strong>.{' '}
            <button className="link-btn" onClick={() => logout(false)}>Log out</button>
          </p>
          <ChangePassword forced />
        </div>
      </div>
    );
  }
  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-name">Office HQ</div>
          <div className="brand-sub">Employee portal</div>
        </div>
        <nav className="nav">
          {NAV.map((n) => (
            <button
              key={n.id}
              className={view === n.id ? 'nav-btn active' : 'nav-btn'}
              onClick={() => setView(n.id)}
            >
              {n.label}
            </button>
          ))}
        </nav>
        <div className="sidebar-foot">
          <div className="user-chip">
            <Avatar first={user.email} last="" />
            <div className="user-meta">
              <div className="user-email">{user.email}</div>
              <div className="user-sub">Rank {user.rank} · {user.dept_name}</div>
            </div>
          </div>
          <div className="btn-row">
            <button className="btn btn-sm" style={{ color: '#fff', borderColor: 'rgba(255,255,255,.3)', background: 'transparent' }} onClick={() => logout(false)}>Log out</button>
            <button className="btn btn-sm" style={{ color: '#fff', borderColor: 'rgba(255,255,255,.3)', background: 'transparent' }} onClick={() => logout(true)} title="Revoke all devices">Everywhere</button>
          </div>
        </div>
      </aside>
      <main className="main">
        {view === 'projects' ? (
          <Projects />
        ) : view === 'workspaces' ? (
          <Workspaces />
        ) : view === 'chat' ? (
          <Chat />
        ) : view === 'directory' ? (
          <Directory />
        ) : (
          <Dashboard />
        )}
      </main>
    </div>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <Shell />
    </AuthProvider>
  );
}
