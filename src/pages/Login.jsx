// Sign in, first-run setup (the first administrator), and changing your password.
import { useState } from 'react';
import { api, run } from '../api.js';
import { Field, Modal } from '../ui.jsx';

function Frame({ title, sub, children }) {
  return (
    <div className="auth-page">
      <div className="auth-card">
        <div className="auth-brand">
          <svg viewBox="0 0 32 32" width="38" height="38" aria-hidden="true"><rect width="32" height="32" rx="7" fill="var(--accent)" /><path d="M6 25V13l6 4v-4l6 4v-4l6 4V7h3v18z" fill="#fff" /></svg>
          <span>FactoryERP</span>
        </div>
        <h1>{title}</h1>
        {sub && <p className="muted">{sub}</p>}
        {children}
      </div>
    </div>
  );
}

export function Login({ onDone }) {
  const [f, setF] = useState({ username: '', password: '' });
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setErr('');
    try {
      await api('POST', '/auth/login', f);
      onDone();
    } catch (x) {
      setErr(x.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Frame title="Sign in">
      <form onSubmit={submit} className="auth-form">
        <Field label="User name"><input autoFocus autoComplete="username" value={f.username} onChange={(e) => setF({ ...f, username: e.target.value })} /></Field>
        <Field label="Password"><input type="password" autoComplete="current-password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} /></Field>
        {err && <div className="auth-err" role="alert">{err}</div>}
        <button className="btn btn-primary block" disabled={busy || !f.username || !f.password}>{busy ? 'Signing in…' : 'Sign in'}</button>
      </form>
      <p className="muted small">Forgot your password? An administrator can set a new one on the Users screen.</p>
    </Frame>
  );
}

export function Setup({ onDone }) {
  const [f, setF] = useState({ username: 'admin', name: '', password: '', again: '' });
  const [err, setErr] = useState('');
  const submit = async (e) => {
    e.preventDefault();
    if (f.password !== f.again) return setErr('The two passwords are not the same.');
    try {
      await api('POST', '/auth/setup', f);
      onDone();
    } catch (x) {
      setErr(x.message);
    }
    return null;
  };
  return (
    <Frame title="Welcome" sub="Create the administrator account. The administrator then adds everyone else on the Users screen, each with their own roles.">
      <form onSubmit={submit} className="auth-form">
        <Field label="User name" required><input autoFocus value={f.username} onChange={(e) => setF({ ...f, username: e.target.value })} /></Field>
        <Field label="Your name"><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        <Field label="Password" required hint="At least 10 characters."><input type="password" autoComplete="new-password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} /></Field>
        <Field label="Password again" required><input type="password" autoComplete="new-password" value={f.again} onChange={(e) => setF({ ...f, again: e.target.value })} /></Field>
        {err && <div className="auth-err" role="alert">{err}</div>}
        <button className="btn btn-primary block" disabled={!f.username || !f.password}>Create the administrator</button>
      </form>
    </Frame>
  );
}

export function ChangePassword({ onClose }) {
  const [f, setF] = useState({ current: '', next: '', again: '' });
  const [err, setErr] = useState('');
  const submit = async (e) => {
    e.preventDefault();
    if (f.next !== f.again) return setErr('The two new passwords are not the same.');
    const out = await run('POST', '/auth/password', { current: f.current, next: f.next });
    if (out) onClose();
    return null;
  };
  return (
    <Modal title="Change your password" onClose={onClose}>
      <form onSubmit={submit} className="auth-form">
        <Field label="Current password"><input type="password" autoComplete="current-password" autoFocus value={f.current} onChange={(e) => setF({ ...f, current: e.target.value })} /></Field>
        <Field label="New password" hint="At least 10 characters. Other devices are signed out."><input type="password" autoComplete="new-password" value={f.next} onChange={(e) => setF({ ...f, next: e.target.value })} /></Field>
        <Field label="New password again"><input type="password" autoComplete="new-password" value={f.again} onChange={(e) => setF({ ...f, again: e.target.value })} /></Field>
        {err && <div className="auth-err" role="alert">{err}</div>}
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={!f.current || !f.next}>Change password</button>
        </div>
      </form>
    </Modal>
  );
}
