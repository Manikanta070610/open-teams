import { useEffect, useState } from 'react';
import { api } from './adminApi.js';
import { useAuth } from './AuthContext.jsx';
import Profile from './Profile.jsx';

// Dashboard is the homepage: my open work, overdue count, my projects,
// watched tasks, and recent updates from projects I belong to.
// Any person row is clickable -> Profile (server gates visibility).
export default function Dashboard() {
  const { sessionExpired, policyDays } = useAuth();
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const [profileId, setProfileId] = useState(null);

  useEffect(() => {
    const c = new AbortController();
    setErr('');
    api('/api/dashboard/work', { signal: c.signal })
      .then(setData)
      .catch((e) => {
        if (e.name === 'AbortError') return;
        if (e.status === 401) sessionExpired(policyDays);
        else setErr(e.message);
      });
    return () => c.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (err) return <p style={{ color: 'darkred' }}>Error: {err}</p>;
  if (!data) return <p>Loading your work…</p>;
  const today = new Date().toISOString().slice(0, 10);

  return (
    <section>
      <h2>My work</h2>
      <p>
        {data.open_tasks?.length ?? 0} open tasks
        {(data.overdue_count ?? 0) > 0 && (
          <strong style={{ color: 'darkred' }}> — {data.overdue_count} overdue</strong>
        )}
        {' '}· {data.projects?.length ?? 0} active projects · {data.watching?.length ?? 0} watched
      </p>
      <h3>Open tasks</h3>
      {(data.open_tasks || []).length === 0 ? (
        <p>Nothing assigned. Enjoy the quiet.</p>
      ) : (
        <ul>
          {data.open_tasks.map((t) => {
            const overdue = t.due_date && String(t.due_date).slice(0, 10) < today;
            return (
              <li key={t.id} style={overdue ? { color: 'darkred' } : undefined}>
                {t.title} — {t.project_name} — {t.status}
                {t.due_date ? ` (due ${String(t.due_date).slice(0, 10)})` : ''}
                {overdue ? ' — OVERDUE' : ''}
              </li>
            );
          })}
        </ul>
      )}
      <h3>My projects</h3>
      {(data.projects || []).length === 0 ? (
        <p>No projects yet.</p>
      ) : (
        <ul>
          {data.projects.map((p) => (
            <li key={p.id}>
              {p.name} — {p.my_role} ({p.status})
            </li>
          ))}
        </ul>
      )}
      <h3>Watched</h3>
      {(data.watching || []).length === 0 ? (
        <p>Nothing watched.</p>
      ) : (
        <ul>
          {data.watching.map((t) => (
            <li key={t.id}>
              {t.title} — {t.project_name} — {t.status}
            </li>
          ))}
        </ul>
      )}
      <h3>Recent updates</h3>
      {(data.recent_updates || []).length === 0 ? (
        <p>No updates this week.</p>
      ) : (
        <ul>
          {data.recent_updates.map((u) => (
            <li key={u.id}>
              <strong>{u.project_name}</strong> — {u.body}{' '}
              <small>
                ({u.first_name} {u.last_name})
              </small>
            </li>
          ))}
        </ul>
      )}
      {profileId && <Profile id={profileId} onClose={() => setProfileId(null)} />}
      {/* Expose profile opener for sibling views via custom event */}
      <ProfileOpener onOpen={setProfileId} />
    </section>
  );
}

// Sibling views (Projects) dispatch `window.dispatchEvent(new CustomEvent('open-profile',{detail:id}))`
// to deep-link a person without prop drilling.
function ProfileOpener({ onOpen }) {
  useEffect(() => {
    const fn = (e) => onOpen(e.detail);
    window.addEventListener('open-profile', fn);
    return () => window.removeEventListener('open-profile', fn);
  }, [onOpen]);
  return null;
}

export function openProfile(id) {
  window.dispatchEvent(new CustomEvent('open-profile', { detail: id }));
}
