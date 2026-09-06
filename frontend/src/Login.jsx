import { useState } from 'react';
import { api } from './adminApi.js';
import { useAuth } from './AuthContext.jsx';

function Err({ msg }) {
  if (!msg) return null;
  return <p style={{ color: 'darkred' }}>Error: {msg}</p>;
}

// Company-portal login: company email + password. Also hosts first-time admin
// setup (SETUP_TOKEN bootstrap) with the optional IP-restriction opt-in.
export default function Login() {
  const { login, policyDays, notice } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [remember, setRemember] = useState(true);
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);

  // First-time setup (admin only, guarded by SETUP_TOKEN server-side).
  const [setupToken, setSetupToken] = useState('');
  const [restrictIp, setRestrictIp] = useState(false);
  const [ips, setIps] = useState('');
  const [myIp, setMyIp] = useState('');

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
      <h2>Company portal login</h2>
      {notice && <p style={{ color: 'darkred' }}>{notice}</p>}
      <p>Use your <strong>company email address</strong> (the one issued when you joined) and your password.</p>
      <form onSubmit={onLogin}>
        <input placeholder="you@company.com" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" />
        <input
          placeholder="password"
          type={show ? 'text' : 'password'}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="current-password"
        />
        <button type="button" onClick={() => setShow((s) => !s)}>{show ? 'Hide' : 'Show'}</button>{' '}
        <button type="submit" disabled={busy}>Log in</button>
      </form>
      <p>
        <label>
          <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />{' '}
          Stay signed in on this device
        </label>
      </p>
      <p style={{ color: '#555' }}>
        You stay signed in automatically — you’ll only need your password again after {policyDays} days
        of inactivity (your admin can change this period).
      </p>
      <p style={{ color: '#555' }}>Forgot your password? Ask your admin or HR to reset it — you’ll get a temporary password and set a new one on next login.</p>
      <Err msg={msg} />

      <h3>First-time setup (admins)</h3>
      <p>Paste the one-time setup token to create a password for the email above, then log in.</p>
      <input
        placeholder="setup token"
        value={setupToken}
        onChange={(e) => setSetupToken(e.target.value)}
      />{' '}
      <button onClick={detectIp} type="button">Detect my IP</button>
      {myIp && <span> Your IP appears to be <code>{myIp}</code>.</span>}
      <p style={{ border: '1px solid #ccc', padding: 8, marginTop: 8 }}>
        <label>
          <input type="checkbox" checked={restrictIp} onChange={(e) => setRestrictIp(e.target.checked)} />{' '}
          <strong>Restrict admin logins to specific IP addresses?</strong>
        </label>
        <br />
        Employees can always log in from anywhere. If you turn this <strong>ON</strong>, admin
        accounts only work from the IPs below — even with the right password, any other network
        gets blocked. Leave it <strong>OFF</strong> if admins should be able to log in from any
        network (e.g. home office, travel). You can change this later in Admin → Security.
      </p>
      {restrictIp && (
        <p>
          <input
            placeholder="203.0.113.8, 203.0.113.0/24"
            value={ips}
            onChange={(e) => setIps(e.target.value)}
            style={{ width: '24em' }}
          />
          <br />
          <small>Comma- or space-separated IPs or CIDR ranges. Include your current IP ({myIp || 'use Detect my IP'}) or you will lock yourself out.</small>
        </p>
      )}
      <button onClick={bootstrap} disabled={busy}>Create admin access</button>
    </section>
  );
}
