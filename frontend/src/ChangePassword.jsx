import { useState } from 'react';
import { api } from './adminApi.js';
import { useAuth } from './AuthContext.jsx';
import { Alert } from './ui.jsx';

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
        <Alert kind="note">Your admin gave you a temporary password. Choose your own password (min 8 characters) to enter the portal.</Alert>
      )}
      <form onSubmit={submit}>
        <div className="field">
          <span>Current / temporary password</span>
          <input
            type="password"
            value={oldPassword}
            onChange={(e) => setOldPassword(e.target.value)}
            autoComplete="current-password"
          />
        </div>
        <div className="field">
          <span>New password (min 8 chars)</span>
          <input
            type="password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            autoComplete="new-password"
          />
        </div>
        <button className="btn btn-primary" type="submit">Save new password</button>
      </form>
      {msg && <Alert>{msg}</Alert>}
      {ok && <Alert kind="ok">{ok}</Alert>}
    </section>
  );
}
