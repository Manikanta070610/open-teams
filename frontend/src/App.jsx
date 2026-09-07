import { useEffect, useState } from 'react';
import { api } from './adminApi.js';
import { AuthProvider, useAuth } from './AuthContext.jsx';
import Login from './Login.jsx';
import ChangePassword from './ChangePassword.jsx';
import AdminPanel from './AdminPanel.jsx';
import Dashboard from './Dashboard.jsx';
import Projects from './Projects.jsx';
import Workspaces from './Workspaces.jsx';

function Directory() {
  const [health, setHealth] = useState('checking...');
  const [employees, setEmployees] = useState([]);
  const { user, logout, sessionExpired, policyDays } = useAuth();

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
      <p>
        Signed in as <strong>{user.email}</strong> (rank {user.rank}, {user.dept_name})
        {user.isAdmin ? ' — admin' : ''}.{' '}
        <button onClick={() => logout(false)}>Log out</button>{' '}
        <button onClick={() => logout(true)} title="Revoke all devices">Log out everywhere</button>
      </p>
      <p>Backend: {health}</p>
      <h2>Employees</h2>
      {employees.length === 0 ? (
        <p>No data (backend not running or empty).</p>
      ) : (
        <ul>
          {employees.map((e) => (
            <li key={e.id}>
              {e.first_name} {e.last_name} — {e.email} (rank {e.rank})
            </li>
          ))}
        </ul>
      )}
      <h3>My account</h3>
      <ChangePassword forced={false} />
    </>
  );
}

function Shell() {
  const { status, user, mustChange, logout } = useAuth();
  const [view, setView] = useState('dashboard');

  if (status === 'checking') return <main style={{ fontFamily: 'system-ui', padding: 24 }}><p>Signing you back in…</p></main>;
  if (status === 'anon') {
    return (
      <main style={{ fontFamily: 'system-ui', padding: 24 }}>
        <h1>Office Management System</h1>
        <Login />
      </main>
    );
  }
  if (mustChange) {
    return (
      <main style={{ fontFamily: 'system-ui', padding: 24 }}>
        <h1>Office Management System</h1>
        <p>Signed in as <strong>{user.email}</strong>. <button onClick={() => logout(false)}>Log out</button></p>
        <ChangePassword forced />
      </main>
    );
  }
  return (
    <main style={{ fontFamily: 'system-ui', padding: 24 }}>
      <h1>Office Management System</h1>
      <p>
        <button disabled={view === 'dashboard'} onClick={() => setView('dashboard')}>My work</button>{' '}
        <button disabled={view === 'directory'} onClick={() => setView('directory')}>Directory</button>{' '}
        <button disabled={view === 'projects'} onClick={() => setView('projects')}>Projects</button>{' '}
        <button disabled={view === 'workspaces'} onClick={() => setView('workspaces')}>Workspaces</button>{' '}
        {user.isAdmin && (
          <button disabled={view === 'admin'} onClick={() => setView('admin')}>Admin</button>
        )}
      </p>
      {view === 'admin' && user.isAdmin ? (
        <AdminPanel />
      ) : view === 'projects' ? (
        <Projects />
      ) : view === 'workspaces' ? (
        <Workspaces />
      ) : view === 'directory' ? (
        <Directory />
      ) : (
        <Dashboard />
      )}
    </main>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <Shell />
    </AuthProvider>
  );
}
