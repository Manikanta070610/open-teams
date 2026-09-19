import { useState } from 'react';
import { useAuth } from './AuthContext.jsx';
import { Alert } from './ui.jsx';

// Employee login: company email + password only. Deliberately contains no
// admin setup/bootstrap UI — that lives in AdminSetup.jsx, which is bundled
// only with the admin service, so the public bundle never mentions it.
export default function Login() {
  const { login, policyDays, notice } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [remember, setRemember] = useState(true);
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);

  async function onLogin(e) {
    e.preventDefault();
    setMsg('');
    setBusy(true);
    try {
      await login(email, password, remember);
    } catch (err) {
      setMsg(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section>
      <h2>Company portal login</h2>
      {notice && <Alert kind="warn">{notice}</Alert>}
      <p className="muted">Use your <strong>company email address</strong> (the one issued when you joined) and your password.</p>
      <form onSubmit={onLogin}>
        <div className="field">
          <span>Company email</span>
          <input placeholder="you@company.com" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" />
        </div>
        <div className="field">
          <span>Password</span>
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              style={{ flex: 1 }}
              placeholder="password"
              type={show ? 'text' : 'password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
            />
            <button className="btn" type="button" onClick={() => setShow((s) => !s)}>{show ? 'Hide' : 'Show'}</button>
          </div>
        </div>
        <button className="btn btn-primary" type="submit" disabled={busy}>{busy ? 'Signing in…' : 'Log in'}</button>
      </form>
      <p style={{ marginTop: 12 }}>
        <label className="check">
          <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />{' '}
          Stay signed in on this device
        </label>
      </p>
      <p className="auth-meta">
        You stay signed in automatically — you’ll only need your password again after {policyDays} days
        of inactivity.
      </p>
      <p className="auth-meta">Forgot your password? Ask HR to reset it — you’ll get a temporary password and set a new one on next login.</p>
      {msg && <Alert>{msg}</Alert>}
    </section>
  );
}
