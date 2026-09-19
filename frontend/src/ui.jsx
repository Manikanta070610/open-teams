// Shared presentational helpers (no auth, no admin/employee logic — safe to
// import from both the public bundle and the admin bundle).
export function initials(first, last) {
  const a = (first || '').trim().charAt(0);
  const b = (last || '').trim().charAt(0);
  return ((a + b) || '?').toUpperCase();
}

export function Avatar({ first, last, size }) {
  return <span className={size === 'lg' ? 'avatar lg' : 'avatar'}>{initials(first, last)}</span>;
}

export function Badge({ kind, children }) {
  const cls = kind ? `badge b-${String(kind).toLowerCase()}` : 'badge';
  return <span className={cls}>{children}</span>;
}

export function Alert({ kind, children }) {
  if (!children) return null;
  const cls = kind === 'ok' ? 'alert alert-ok' : kind === 'note' ? 'alert alert-note' : kind === 'warn' ? 'alert alert-warn' : 'alert alert-err';
  return <div className={cls}>{children}</div>;
}

export function Card({ title, action, children }) {
  return (
    <div className="card">
      {(title || action) && (
        <div className="toolbar">
          <h3 className="card-title" style={{ margin: 0 }}>{title}</h3>
          {action}
        </div>
      )}
      {children}
    </div>
  );
}

export function Stat({ num, label }) {
  return (
    <div className="stat">
      <div className="stat-num">{num}</div>
      <div className="stat-label">{label}</div>
    </div>
  );
}

export function Empty({ children }) {
  return <p className="muted">{children}</p>;
}
