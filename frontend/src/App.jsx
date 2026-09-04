import { useEffect, useState } from 'react';
import AdminPanel from './AdminPanel.jsx';

export default function App() {
  const [health, setHealth] = useState('checking...');
  const [employees, setEmployees] = useState([]);
  const [view, setView] = useState('directory');

  useEffect(() => {
    fetch('/api/employees')
      .then((r) => (r.ok ? r.json() : []))
      .then(setEmployees)
      .catch(() => setEmployees([]));
    fetch('/health')
      .then((r) => r.json())
      .then((d) => setHealth(JSON.stringify(d)))
      .catch(() => setHealth('backend unreachable (dev: start backend on :4000)'));
  }, []);

  return (
    <main style={{ fontFamily: 'system-ui', padding: 24 }}>
      <h1>Office Management System</h1>
      <p>
        <button disabled={view === 'directory'} onClick={() => setView('directory')}>Directory</button>{' '}
        <button disabled={view === 'admin'} onClick={() => setView('admin')}>Admin</button>
      </p>
      {view === 'admin' ? <AdminPanel /> : (
      <>
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
      </>
      )}
    </main>
  );
}
