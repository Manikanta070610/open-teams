import { AuthProvider, useAuth } from './AuthContext.jsx';
import Login from './Login.jsx';
import AdminSetup from './AdminSetup.jsx';
import ChangePassword from './ChangePassword.jsx';
import AdminPanel from './AdminPanel.jsx';
import { Alert, Avatar } from './ui.jsx';

// Back-office shell: admin service only. No product views (Dashboard,
// Projects, Workspaces, Directory) are imported here, and the public app
// no longer imports AdminPanel — the bundles are fully separated.
function AdminShell() {
  const { status, user, mustChange, logout } = useAuth();

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
        <div className="auth-card wide">
          <div className="auth-brand">Office HQ — Admin</div>
          <p className="auth-sub">Back-office access. <span className="private-chip">Private URL — do not share</span></p>
          <Login />
          <hr style={{ border: 0, borderTop: '1px solid var(--line)', margin: '20px 0' }} />
          <AdminSetup />
        </div>
      </div>
    );
  }
  if (mustChange) {
    return (
      <div className="auth-page">
        <div className="auth-card">
          <div className="auth-brand">Office HQ — Admin</div>
          <p className="auth-sub">
            Signed in as <strong>{user.email}</strong>.{' '}
            <button className="link-btn" onClick={() => logout(false)}>Log out</button>
          </p>
          <ChangePassword forced />
        </div>
      </div>
    );
  }
  if (!user.isAdmin) {
    return (
      <div className="auth-page">
        <div className="auth-card">
          <div className="auth-brand">Office HQ — Admin</div>
          <Alert>
            Signed in as <strong>{user.email}</strong> — this account is not eligible for admin
            access (Owner rank 6 or IT only).
          </Alert>
          <button className="btn" onClick={() => logout(false)}>Log out</button>
        </div>
      </div>
    );
  }
  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-name">Office HQ</div>
          <div className="brand-sub">Back office</div>
          <span className="private-chip">Private</span>
        </div>
        <div className="sidebar-foot" style={{ border: 0, marginTop: 0, paddingTop: 0 }}>
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
        <AdminPanel />
      </main>
    </div>
  );
}

export default function AdminApp() {
  return (
    <AuthProvider>
      <AdminShell />
    </AuthProvider>
  );
}
