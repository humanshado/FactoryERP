// Test helpers. Every suite runs on SQLite; set TEST_DATABASE_URL=postgres://... to run them on PostgreSQL too.
import { SCHEMA, Store } from '../server/db.js';
import { loadData, readSeed, rollForward } from '../server/seed.js';
import { createApp } from '../server/index.js';
import { hashPassword } from '../server/auth.js';

export const TODAY = '2026-11-17';
export const PG = process.env.TEST_DATABASE_URL || null;

/** A fresh, empty store */
export async function freshStore() {
  if (!PG) return Store.open({ file: ':memory:' });
  const { default: pg } = await import('pg');
  const c = new pg.Client({ connectionString: PG });
  await c.connect();
  for (const t of [...Object.keys(SCHEMA), 'settings', 'sessions', 'auditLog']) await c.query(`DROP TABLE IF EXISTS "${t}"`);
  await c.end();
  return Store.open({ url: PG });
}

/** A store with the sample company, rolled forward to TODAY */
export async function sampleStore() {
  const s = await freshStore();
  await loadData(s, readSeed());
  await rollForward(s, TODAY);
  return s;
}

/** The app on a free port, with a signed-in client per role */
export async function server(store) {
  const app = createApp(store, { today: TODAY });
  const srv = app.listen(0);
  const base = `http://127.0.0.1:${srv.address().port}/api`;
  const client = (cookie = '') => {
    const c = async (method, url, body, { header = true } = {}) => {
      const headers = { Cookie: c.cookie };
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      if (header) headers['X-FactoryERP'] = '1';
      const r = await fetch(base + url, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
      const set = r.headers.get('set-cookie');
      if (set) c.cookie = set.split(';')[0];
      let data = null;
      try {
        data = await r.json();
      } catch { /* no body */ }
      return { status: r.status, body: data };
    };
    c.cookie = cookie;
    return c;
  };
  const users = new Map();
  /** A client signed in with these roles (the user is made on first use) */
  const as = async (...roles) => {
    const name = `t-${roles.join('-') || 'none'}`;
    if (!users.has(name)) {
      if (!(await store.userByName(name))) {
        await store.insert('users', { username: name, name, roles, passwordHash: hashPassword('correct horse battery'), active: true });
      }
      const c = client();
      const r = await c('POST', '/auth/login', { username: name, password: 'correct horse battery' });
      if (r.status !== 200) throw new Error(`login ${name}: ${JSON.stringify(r.body)}`);
      users.set(name, c);
    }
    return users.get(name);
  };
  return { base, client, as, close: () => new Promise((res) => srv.close(res)) };
}
