import { useState } from 'react';
import { api } from './adminApi.js';
import { useAuth } from './AuthContext.jsx';

// Forced on first login (must_change_password) and available as self-service.
export default function ChangePassword({ forced }) {
  const { passwordChanged, setMustChange } = useAuth();
  const [oldPassword, setOldPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [msg, setMsg] = useState('');
  const [ok, setOk] = useState('');

  async function submit(e) {
    e.preventDefault();
    setMsg('');
    setOk('');
    try {
      const r = await api('/api/auth/change-password', {
        method: 'POST',
        body: { oldPassword, newPassword },
      });
      passwordChanged(r.token);
      setMustChange(false);
      setOk('Password updated.');
      setOldPassword('');
      setNewPassword('');
    } catch (err) {
      setMsg(err.message);
    }
  }

  return (
    <section>
      <h2>{forced ? 'Set a new password to continue' : 'Change password'}</h2>
      {forced && (
        <p>Your admin gave you a temporary password. Choose your own password (min 8 characters) to enter the portal.</p>
      )}
      <form onSubmit={submit}>
        <input
          placeholder="current / temporary password"
          type="password"
          value={oldPassword}
          onChange={(e) => setOldPassword(e.target.value)}
          autoComplete="current-password"
        />
        <input
          placeholder="new password (min 8 chars)"
          type="password"
          value={newPassword}
          onChange={(e) => setNewPassword(e.target.value)}
          autoComplete="new-password"
        />
        <button type="submit">Save new password</button>
      </form>
      {msg && <p style={{ color: 'darkred' }}>Error: {msg}</p>}
      {ok && <p style={{ color: 'darkgreen' }}>{ok}</p>}
    </section>
  );
}
