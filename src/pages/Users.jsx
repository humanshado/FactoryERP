// USERS (administrators): who can sign in, and with which roles.
import { useEffect, useState } from 'react';
import { run } from '../api.js';
import { Badge, Card, DataList, Field, History, Loading, PageHead, fmtStamp, useData } from '../ui.jsx';
import { useApp } from '../App.jsx';
import { PERMISSIONS, ROLES, permsOf } from '../../shared/permissions.js';

const blank = () => ({ username: '', name: '', roles: ['viewer'], active: true, password: '' });

export default function Users() {
  const { can, user: me } = useApp();
  const [rows, reload, error] = useData('/users');
  const [sel, setSel] = useState(null);
  const [draft, setDraft] = useState(null);
  useEffect(() => {
    const u = rows?.find((r) => r.id === sel);
    if (u) setDraft({ ...u, password: '' });
  }, [rows, sel]);
  if (!can('users.manage')) return <div className="page"><PageHead title="Users" /><div className="placeholder">Only an administrator manages users.</div></div>;
  if (!rows) return <Loading error={error} />;
  const isNew = draft && !draft.id;
  const save = async () => {
    const body = { name: draft.name, roles: draft.roles, active: draft.active, rev: draft.rev, ...(draft.password ? { password: draft.password } : {}) };
    const out = isNew ? await run('POST', '/users', { ...body, username: draft.username, password: draft.password }) : await run('PUT', `/users/${draft.id}`, body);
    if (out?.record) {
      await reload();
      setSel(out.record.id);
    }
  };
  const toggle = (r) => setDraft({ ...draft, roles: draft.roles.includes(r) ? draft.roles.filter((x) => x !== r) : [...draft.roles, r] });
  const perms = draft ? permsOf(draft.roles) : new Set();
  const cols = [
    { key: 'username', label: 'User', render: (r) => <><b>{r.name}</b><div className="muted small">{r.username}{r.id === me.id ? ' · you' : ''}</div></> },
    { key: 'roles', label: 'Roles', render: (r) => (r.roles || []).map((x) => ROLES[x]?.label || x).join(', '), text: (r) => (r.roles || []).join(' ') },
    { key: 'lastLogin', label: 'Last sign-in', render: (r) => (r.lastLogin ? fmtStamp(r.lastLogin) : <span className="muted">never</span>) },
    { key: 'active', label: '', render: (r) => (r.active ? <Badge tone="green">Active</Badge> : <Badge tone="grey">Off</Badge>) },
  ];
  return (
    <div className="page">
      <PageHead title="Users" sub="Who can sign in, and what each one may change">
        <button className="btn btn-primary" onClick={() => { setSel(null); setDraft(blank()); }}>+ New user</button>
      </PageHead>
      <div className="split">
        <Card className="list-card" pad={false}>
          <DataList rows={rows} columns={cols} selectedId={sel} onSelect={(r) => setSel(r.id)} />
        </Card>
        <div className="detail">
          {!draft && <div className="placeholder">Select a user, or click <b>New user</b>.</div>}
          {draft && (
            <>
              <Card title={isNew ? 'New user' : draft.name} actions={(
                <>
                  {isNew && <button className="btn" onClick={() => setDraft(null)}>Cancel</button>}
                  <button className="btn btn-primary" onClick={save} disabled={!draft.roles.length || (isNew && (!draft.username || !draft.password))}>{isNew ? 'Add user' : 'Save'}</button>
                </>
              )}>
                <div className="form-grid">
                  <Field label="User name" required><input value={draft.username} disabled={!isNew} onChange={(e) => setDraft({ ...draft, username: e.target.value })} /></Field>
                  <Field label="Name"><input value={draft.name || ''} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></Field>
                  <Field label={isNew ? 'Password' : 'New password'} required={isNew} hint={isNew ? 'At least 10 characters; they can change it after signing in.' : 'Leave empty to keep it. A new one signs them out everywhere.'}>
                    <input type="password" autoComplete="new-password" value={draft.password} onChange={(e) => setDraft({ ...draft, password: e.target.value })} />
                  </Field>
                  <Field label="Can sign in">
                    <select value={draft.active ? 'yes' : 'no'} onChange={(e) => setDraft({ ...draft, active: e.target.value === 'yes' })}>
                      <option value="yes">Yes</option><option value="no">No (switched off)</option>
                    </select>
                  </Field>
                </div>
                <h3>Roles</h3>
                <div className="roles">
                  {Object.entries(ROLES).map(([k, r]) => (
                    <label key={k} className={`role ${draft.roles.includes(k) ? 'on' : ''}`}>
                      <input type="checkbox" checked={draft.roles.includes(k)} onChange={() => toggle(k)} />
                      <span><b>{r.label}</b><span className="muted small">{r.hint}</span></span>
                    </label>
                  ))}
                </div>
                <h3>So they may change</h3>
                <p className="small">
                  {perms.has('*') ? 'Everything.' : perms.size ? [...perms].map((p) => PERMISSIONS[p]).join(' · ') : 'Nothing: they can look at every screen.'}
                </p>
              </Card>
              {!isNew && can('audit.view') && <History table="users" id={draft.id} />}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
