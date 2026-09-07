import { useEffect, useState } from 'react';
import { api } from './adminApi.js';
import { useAuth } from './AuthContext.jsx';

// Person profile: same workload shape as dashboard-home, for anyone the
// viewer may see (self, shared-project head/lead, HR/chief). 404 = hidden.
export default function Profile({ id, onClose }) {
  const { sessionExpired, policyDays } = useAuth();
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');

  useEffect(() => {
    const c = new AbortController();
    setErr('');
    api(`/api/dashboard/work/${id}`, { signal: c.signal })
      .then(setData)
      .catch((e) => {
        if (e.name === 'AbortError') return;
        if (e.status === 401) sessionExpired(policyDays);
        else if (e.status === 404) setErr('No shared work with this person.');
        else setErr(e.message);
      });
    return () => c.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  if (err) {
    return (
      <article style={{ border: '1px solid #ccc', padding: 8, marginTop: 8 }}>
        <p style={{ color: 'darkred' }}>Error: {err}</p>
        <button onClick={onClose}>Close</button>
      </article>
    );
  }
  if (!data) return <p>Loading profile…</p>;
  const p = data.person || {};
  return (
    <article style={{ border: '1px solid #ccc', padding: 8, marginTop: 8 }}>
      <h3>
        {p.first_name} {p.last_name} <small>(rank {p.rank}, {p.department})</small>
      </h3>
      <p>
        {p.email} — {data.open_tasks?.length ?? 0} open tasks ({data.overdue_count ?? 0} overdue),{' '}
        {data.projects?.length ?? 0} active projects
      </p>
      <h4>Open tasks</h4>
      {(data.open_tasks || []).length === 0 ? (
        <p>No open tasks.</p>
      ) : (
        <ul>
          {data.open_tasks.map((t) => (
            <li key={t.id}>
              {t.title} — {t.project_name} — {t.status}
              {t.due_date ? ` (due ${String(t.due_date).slice(0, 10)})` : ''}
            </li>
          ))}
        </ul>
      )}
      <h4>Projects</h4>
      <ul>
        {(data.projects || []).map((pr) => (
          <li key={pr.id}>
            {pr.name} — {pr.my_role} ({pr.status})
          </li>
        ))}
      </ul>
      <button onClick={onClose}>Close</button>
    </article>
  );
}
