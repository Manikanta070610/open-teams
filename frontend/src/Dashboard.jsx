import { useEffect, useState } from 'react';
import { api } from './adminApi.js';
import { useAuth } from './AuthContext.jsx';
import Profile from './Profile.jsx';
import { Alert, Badge, Card, Empty, Stat } from './ui.jsx';

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

  if (err) return <Alert>{err}</Alert>;
  if (!data) return <p className="loading">Loading your work</p>;
  const today = new Date().toISOString().slice(0, 10);
  const openCount = data.open_tasks?.length ?? 0;
  const overdue = data.overdue_count ?? 0;

  return (
    <section>
      <div className="page-head">
        <h1>My work</h1>
        <p className="page-sub">Everything assigned to you, at a glance.</p>
      </div>
      <div className="grid stats">
        <Stat num={openCount} label="Open tasks" />
        <Stat num={overdue} label="Overdue" />
        <Stat num={data.projects?.length ?? 0} label="Active projects" />
        <Stat num={data.watching?.length ?? 0} label="Watched" />
      </div>
      {overdue > 0 && <Alert>{overdue} task{overdue === 1 ? ' is' : 's are'} overdue — see Open tasks below.</Alert>}
      <div className="grid cols-2">
        <Card title="Open tasks">
          {(data.open_tasks || []).length === 0 ? (
            <Empty>Nothing assigned. Enjoy the quiet.</Empty>
          ) : (
            <ul className="rows">
              {data.open_tasks.map((t) => {
                const isOverdue = t.due_date && String(t.due_date).slice(0, 10) < today;
                return (
                  <li key={t.id}>
                    <div className="grow">
                      <strong>{t.title}</strong>
                      <div><small>{t.project_name}</small></div>
                    </div>
                    <Badge kind={t.status}>{t.status}</Badge>
                    {t.due_date && (
                      <small className={isOverdue ? 'overdue' : 'muted'}>
                        due {String(t.due_date).slice(0, 10)}{isOverdue ? ' — OVERDUE' : ''}
                      </small>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
        <Card title="My projects">
          {(data.projects || []).length === 0 ? (
            <Empty>No projects yet.</Empty>
          ) : (
            <ul className="rows">
              {data.projects.map((p) => (
                <li key={p.id}>
                  <div className="grow"><strong>{p.name}</strong></div>
                  <Badge kind={p.my_role}>{p.my_role}</Badge>
                  <Badge kind={p.status}>{p.status}</Badge>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
      <div className="grid cols-2">
        <Card title="Watched">
          {(data.watching || []).length === 0 ? (
            <Empty>Nothing watched.</Empty>
          ) : (
            <ul className="rows">
              {data.watching.map((t) => (
                <li key={t.id}>
                  <div className="grow">
                    <strong>{t.title}</strong>
                    <div><small>{t.project_name}</small></div>
                  </div>
                  <Badge kind={t.status}>{t.status}</Badge>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card title="Recent updates">
          {(data.recent_updates || []).length === 0 ? (
            <Empty>No updates this week.</Empty>
          ) : (
            <ul className="rows">
              {data.recent_updates.map((u) => (
                <li key={u.id}>
                  <div className="grow">
                    <strong>{u.project_name}</strong> — {u.body}
                    <div><small>{u.first_name} {u.last_name}</small></div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
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
