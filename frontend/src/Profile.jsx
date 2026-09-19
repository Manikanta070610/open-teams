import { useEffect, useState } from 'react';
import { api } from './adminApi.js';
import { useAuth } from './AuthContext.jsx';
import { Alert, Avatar, Badge, Empty } from './ui.jsx';

// Person profile in a modal overlay: same workload shape as dashboard-home,
// for anyone the viewer may see (self, shared-project head/lead, HR/chief).
// 404 = hidden.
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

  useEffect(() => {
    const fn = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', fn);
    return () => window.removeEventListener('keydown', fn);
  }, [onClose]);

  const p = data?.person || {};
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        {err ? (
          <>
            <Alert>{err}</Alert>
            <button className="btn" onClick={onClose}>Close</button>
          </>
        ) : !data ? (
          <p className="loading">Loading profile</p>
        ) : (
          <>
            <div className="modal-head">
              <Avatar first={p.first_name} last={p.last_name} size="lg" />
              <div style={{ flex: 1 }}>
                <h2 style={{ margin: 0 }}>{p.first_name} {p.last_name}</h2>
                <p className="page-sub">{p.email}</p>
              </div>
              <button className="btn btn-sm" onClick={onClose}>Close</button>
            </div>
            <p>
              <Badge kind="rank">R{p.rank}</Badge>{' '}
              <Badge kind="member">{p.department}</Badge>{' '}
              <span className="muted">
                {data.open_tasks?.length ?? 0} open tasks ({data.overdue_count ?? 0} overdue) ·{' '}
                {data.projects?.length ?? 0} active projects
              </span>
            </p>
            <h4>Open tasks</h4>
            {(data.open_tasks || []).length === 0 ? (
              <Empty>No open tasks.</Empty>
            ) : (
              <ul className="rows">
                {data.open_tasks.map((t) => (
                  <li key={t.id}>
                    <div className="grow">
                      <strong>{t.title}</strong>
                      <div><small>{t.project_name}</small></div>
                    </div>
                    <Badge kind={t.status}>{t.status}</Badge>
                    {t.due_date && <small className="muted">due {String(t.due_date).slice(0, 10)}</small>}
                  </li>
                ))}
              </ul>
            )}
            <h4 className="section-gap">Projects</h4>
            <ul className="rows">
              {(data.projects || []).map((pr) => (
                <li key={pr.id}>
                  <div className="grow"><strong>{pr.name}</strong></div>
                  <Badge kind={pr.my_role}>{pr.my_role}</Badge>
                  <Badge kind={pr.status}>{pr.status}</Badge>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </div>
  );
}
