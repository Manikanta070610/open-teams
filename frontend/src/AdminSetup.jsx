import { useState } from 'react';
import { api } from './adminApi.js';
import { useAuth } from './AuthContext.jsx';
import { Alert } from './ui.jsx';

// First-time admin setup (SETUP_TOKEN bootstrap) with the optional
// IP-restriction opt-in. Imported ONLY by AdminApp.jsx — never by the public
// employee app — so users never learn this flow exists.
export default function AdminSetup() {
  const { login } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [setupToken, setSetupToken] = useState('');
  const [restrictIp, setRestrictIp] = useState(false);
  const [ips, setIps] = useState('');
  const [myIp, setMyIp] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);

  async function detectIp() {
    try {
      const r = await api('/api/auth/my-ip');
      setMyIp(r.ip);
      if (!ips) setIps(r.ip);
    } catch {
      /* backend unreachable */
    }
  }

  async function bootstrap() {
    setMsg('');
    setBusy(true);
    try {
      await api('/api/admin/bootstrap', {
        method: 'POST',
        body: {
          email,
          password,
          setupToken,
          restrictAdminByIp: restrictIp,
          adminAllowedIps: restrictIp
            ? ips.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean)
            : [],
        },
      });
      await login(email, password, true);
    } catch (err) {
      setMsg(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section>
      <h3>First-time setup (admins)</h3>
      <p className="muted">Paste the one-time setup token to create a password for the admin email below, then log in.</p>
      <div className="field">
        <span>Admin email</span>
        <input value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" />
      </div>
      <div className="field">
        <span>Password (min 8 chars)</span>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="new-password"
        />
      </div>
      <div className="field">
        <span>Setup token</span>
        <div style={{ display: 'flex', gap: 8 }}>
          <input style={{ flex: 1 }} value={setupToken} onChange={(e) => setSetupToken(e.target.value)} />
          <button className="btn btn-sm" onClick={detectIp} type="button">Detect my IP</button>
        </div>
      </div>
      {myIp && <p className="muted">Your IP appears to be <code>{myIp}</code>.</p>}
      <div className="card" style={{ background: 'var(--surface-2)' }}>
        <label className="check">
          <input type="checkbox" checked={restrictIp} onChange={(e) => setRestrictIp(e.target.checked)} />{' '}
          <strong>Restrict admin logins to specific IP addresses?</strong>
        </label>
        <p className="muted" style={{ margin: '8px 0 0' }}>
          Employees can always log in from anywhere. If you turn this <strong>ON</strong>, admin
          accounts only work from the IPs below — even with the right password, any other network
          gets blocked. Leave it <strong>OFF</strong> if admins should be able to log in from any
          network (e.g. home office, travel). You can change this later in Admin → Security.
        </p>
        {restrictIp && (
          <div className="field" style={{ marginTop: 10 }}>
            <span>Allowed IPs / ranges</span>
            <input
              placeholder="203.0.113.8, 203.0.113.0/24"
              value={ips}
              onChange={(e) => setIps(e.target.value)}
            />
            <small className="muted">Comma- or space-separated IPs or CIDR ranges. Include your current IP ({myIp || 'use Detect my IP'}) or you will lock yourself out.</small>
          </div>
        )}
      </div>
      <button className="btn btn-primary" onClick={bootstrap} disabled={busy}>{busy ? 'Creating…' : 'Create admin access'}</button>
      {msg && <Alert>{msg}</Alert>}
    </section>
  );
}
