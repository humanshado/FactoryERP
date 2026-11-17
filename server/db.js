// FactoryERP storage. Two drivers behind one async Store:
//   SQLite      (default; Node's built-in node:sqlite, one file, nothing to install)
//   PostgreSQL  (set DATABASE_URL=postgres://...; for a server several people use)
//
// Every write runs inside store.tx(): one writer at a time (an in-process lock, plus a
// PostgreSQL advisory lock so several server processes stay in line), all or nothing.
// Every record carries rev / createdAt / updatedAt / createdBy / updatedBy, and every
// change is written to the audit log with who made it (from the request context).
import { AsyncLocalStorage } from 'node:async_hooks';
import fs from 'node:fs';
import path from 'node:path';

export const ctx = new AsyncLocalStorage();
export const currentUser = () => ctx.getStore()?.user || null;

export const SCHEMA = {
  items: {
    name: 'text', code: 'text', description: 'text', type: 'text', category: 'text', unit: 'text', unitCost: 'num',
    price: 'num', openingStock: 'num', reorderPoint: 'num', supplier: 'text', expiryDate: 'date', picture: 'text', notes: 'text',
    archived: 'bool',
  },
  bomLines: { itemId: 'int', material: 'text', qtyPerUnit: 'num' },
  routingSteps: { itemId: 'int', workCenter: 'text', hoursPerUnit: 'num' },
  customers: {
    name: 'text', contact: 'text', phone: 'text', email: 'text', street: 'text', city: 'text', state: 'text', zip: 'text', notes: 'text',
    archived: 'bool',
  },
  suppliers: { name: 'text', contact: 'text', phone: 'text', email: 'text', leadDays: 'num', notes: 'text', archived: 'bool' },
  orders: {
    orderNo: 'text', type: 'text', party: 'text', orderDate: 'date', dueDate: 'date', status: 'text', fromNo: 'text', qty: 'num',
    priority: 'text', closedDate: 'date', paidDate: 'date', notes: 'text', taxRate: 'num', taxName: 'text', useTax: 'text',
  },
  /** delivered = received (purchase order) or shipped (invoice) so far */
  orderLines: { orderId: 'int', item: 'text', description: 'text', qty: 'num', price: 'num', delivered: 'num' },
  operations: { orderId: 'int', workCenter: 'text', opStart: 'date', days: 'num', hours: 'num', done: 'bool' },
  moneyEntries: {
    entryDate: 'date', direction: 'text', category: 'text', party: 'text', reference: 'text', amount: 'num', method: 'text', notes: 'text',
    void: 'bool', voidReason: 'text',
  },
  employees: {
    name: 'text', role: 'text', workCenter: 'text', hourlyRate: 'num', startDate: 'date', phone: 'text', notes: 'text', archived: 'bool',
  },
  timeEntries: { employeeId: 'int', workDate: 'date', woNo: 'text', hours: 'num', notes: 'text' },
  /** The stock ledger: every movement in (+) or out (-). On hand = the sum. Never edited, never deleted. */
  stockMoves: {
    moveDate: 'date', itemId: 'int', qty: 'num', type: 'text', unitCost: 'num', orderId: 'int', lineId: 'int', refNo: 'text',
    countId: 'int', note: 'text',
  },
  stockCounts: { countNo: 'text', countDate: 'date', note: 'text', lines: 'json' },
  users: { username: 'text', name: 'text', roles: 'json', passwordHash: 'text', active: 'bool', lastLogin: 'text' },
};

export const SYSTEM = { rev: 'int', createdAt: 'text', updatedAt: 'text', createdBy: 'text', updatedBy: 'text' };
/** The tables the engine and the screens read (users stay out: they hold password hashes) */
export const TABLES = Object.keys(SCHEMA).filter((t) => t !== 'users');
const NOT_AUDITED = new Set(['stockMoves']);
const SECRET = new Set(['passwordHash']);

export class ActionError extends Error {
  constructor(message, status = 400, extra = {}) {
    super(message);
    this.status = status;
    Object.assign(this, extra);
  }
}

// ---------------------------------------------------------------- values
function toDb(kind, v) {
  if (kind === 'json') return v === undefined || v === null ? null : JSON.stringify(v);
  if (v === undefined || v === null || v === '') return kind === 'bool' ? 0 : null;
  switch (kind) {
    case 'num': {
      const x = typeof v === 'number' ? v : parseFloat(String(v).replace(/[$,]/g, ''));
      return Number.isFinite(x) ? x : null;
    }
    case 'int': {
      const x = parseInt(v, 10);
      return Number.isFinite(x) ? x : null;
    }
    case 'bool':
      return v === true || v === 1 || /^(yes|true|1)$/i.test(String(v)) ? 1 : 0;
    case 'date': {
      const s = String(v).slice(0, 10);
      return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
    }
    default:
      return String(v).trim() === '' ? null : String(v).trim();
  }
}

function fromDb(kind, v) {
  if (kind === 'bool') return !!Number(v);
  if (v === null || v === undefined) return null;
  if (kind === 'json') {
    try {
      return JSON.parse(v);
    } catch {
      return null;
    }
  }
  if (kind === 'num' || kind === 'int') return Number(v);
  return v;
}

const fieldsOf = (table) => ({ ...SCHEMA[table], ...SYSTEM });

function fromRow(table, row) {
  if (!row) return null;
  const out = { id: Number(row.id) };
  for (const [f, kind] of Object.entries(fieldsOf(table))) out[f] = fromDb(kind, row[f]);
  return out;
}

function label(table, r) {
  if (!r) return '';
  return r.orderNo || r.name || r.username || r.countNo || r.reference || r.item || r.material || r.workCenter || `#${r.id}`;
}

// ---------------------------------------------------------------- drivers
class SqliteDriver {
  constructor(file) {
    this.dialect = 'sqlite';
    this.file = file;
  }

  async open() {
    const { DatabaseSync } = await import('node:sqlite');
    if (this.file !== ':memory:') fs.mkdirSync(path.dirname(this.file), { recursive: true });
    this.w = new DatabaseSync(this.file);
    this.w.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
    // a separate reading connection sees only committed data
    this.r = this.file === ':memory:' ? this.w : new DatabaseSync(this.file);
    if (this.r !== this.w) this.r.exec('PRAGMA busy_timeout = 5000;');
  }

  get readConn() {
    return this.r;
  }

  async all(conn, sql, params = []) {
    return conn.prepare(sql).all(...params);
  }

  async run(conn, sql, params = []) {
    conn.prepare(sql).run(...params);
  }

  async exec(conn, sql) {
    conn.exec(sql);
  }

  async transaction(fn) {
    this.w.exec('BEGIN IMMEDIATE');
    try {
      const out = await fn(this.w);
      this.w.exec('COMMIT');
      return out;
    } catch (e) {
      this.w.exec('ROLLBACK');
      throw e;
    }
  }

  async columns(table) {
    return this.w.prepare(`PRAGMA table_info("${table}")`).all().map((c) => c.name);
  }

  type(kind) {
    return { text: 'TEXT', date: 'TEXT', json: 'TEXT', num: 'REAL', int: 'INTEGER', bool: 'INTEGER' }[kind];
  }

  async close() {
    if (this.r !== this.w) this.r.close();
    this.w.close();
  }
}

class PgDriver {
  constructor(url) {
    this.dialect = 'postgres';
    this.url = url;
  }

  async open() {
    const { default: pg } = await import('pg');
    this.pool = new pg.Pool({ connectionString: this.url, max: 10 });
    await this.pool.query('SELECT 1');
  }

  get readConn() {
    return this.pool;
  }

  static sql(sql) {
    let i = 0;
    return sql.replace(/\?/g, () => `$${++i}`);
  }

  async all(conn, sql, params = []) {
    return (await conn.query(PgDriver.sql(sql), params)).rows;
  }

  async run(conn, sql, params = []) {
    await conn.query(PgDriver.sql(sql), params);
  }

  async exec(conn, sql) {
    await conn.query(sql);
  }

  async transaction(fn) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(724100)'); // one writer at a time, across processes too
      const out = await fn(client);
      await client.query('COMMIT');
      return out;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }

  async columns(table) {
    return (await this.pool.query('SELECT column_name FROM information_schema.columns WHERE table_name = $1', [table])).rows.map((r) => r.column_name);
  }

  type(kind) {
    return { text: 'TEXT', date: 'TEXT', json: 'TEXT', num: 'DOUBLE PRECISION', int: 'INTEGER', bool: 'INTEGER' }[kind];
  }

  async close() {
    await this.pool.end();
  }
}

// ---------------------------------------------------------------- the store
export class Store {
  /** Store.open() uses DATABASE_URL (PostgreSQL) when set, else the SQLite file */
  static async open({ url = process.env.DATABASE_URL, file } = {}) {
    const driver = url && /^postgres(ql)?:/.test(url) ? new PgDriver(url) : new SqliteDriver(file || ':memory:');
    await driver.open();
    const s = new Store(driver);
    await s.init();
    return s;
  }

  constructor(driver) {
    this.driver = driver;
    this.cache = null;
    this.cacheVersion = null;
    this.chain = Promise.resolve();
  }

  get dialect() {
    return this.driver.dialect;
  }

  async init() {
    const d = this.driver;
    const w = d.dialect === 'sqlite' ? d.w : d.pool;
    for (const t of Object.keys(SCHEMA)) {
      const fields = fieldsOf(t);
      const cols = Object.entries(fields).map(([f, k]) => `"${f}" ${d.type(k)}`).join(', ');
      await d.exec(w, `CREATE TABLE IF NOT EXISTS "${t}" (id INTEGER PRIMARY KEY, ${cols})`);
      const have = new Set(await d.columns(t));
      for (const [f, k] of Object.entries(fields)) {
        if (!have.has(f)) await d.exec(w, `ALTER TABLE "${t}" ADD COLUMN "${f}" ${d.type(k)}`);
      }
    }
    await d.exec(w, 'CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)');
    await d.exec(w, `CREATE TABLE IF NOT EXISTS sessions ("tokenHash" TEXT PRIMARY KEY, "userId" INTEGER, "expiresAt" TEXT, "createdAt" TEXT, ip TEXT, "userAgent" TEXT)`);
    await d.exec(w, `CREATE TABLE IF NOT EXISTS "auditLog" (id INTEGER PRIMARY KEY, at TEXT, "userId" INTEGER, "userName" TEXT, action TEXT, tbl TEXT, "recordId" INTEGER, summary TEXT, changes TEXT)`);
    for (const [name, t, c] of [
      ['ix_moves_item', 'stockMoves', 'itemId'], ['ix_lines_order', 'orderLines', 'orderId'], ['ix_ops_order', 'operations', 'orderId'],
      ['ix_audit_rec', 'auditLog', 'tbl", "recordId'], ['ix_users_name', 'users', 'username'],
    ]) {
      await d.exec(w, `CREATE INDEX IF NOT EXISTS ${name} ON "${t}" ("${c}")`);
    }
  }

  // ------------------------------------------------------------ connections and transactions
  conn() {
    return ctx.getStore()?.tx?.conn || this.driver.readConn;
  }

  async q(sql, params) {
    return this.driver.all(this.conn(), sql, params);
  }

  inTx() {
    return !!ctx.getStore()?.tx;
  }

  lock(fn) {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => {});
    return run;
  }

  /** Run fn as one transaction (nested calls join the outer one) */
  async tx(fn) {
    const c = ctx.getStore() || {};
    if (c.tx) return fn();
    return this.lock(async () => {
      const t = { conn: null, wrote: false, cache: null };
      const out = await this.driver.transaction(async (conn) => {
        t.conn = conn;
        const r = await ctx.run({ ...c, tx: t }, fn);
        if (t.wrote) {
          await this.driver.run(conn, 'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
            ['__version', JSON.stringify(`${Date.now()}-${Math.random()}`)]);
        }
        return r;
      });
      if (t.wrote) this.cache = null;
      return out;
    });
  }

  /** A write: inside a transaction (one is opened when there is none) */
  async write(fn) {
    if (!this.inTx()) return this.tx(() => this.write(fn));
    const t = ctx.getStore().tx;
    t.wrote = true;
    t.cache = null;
    return fn(t.conn);
  }

  // ------------------------------------------------------------ reading
  async load() {
    const D = {};
    for (const t of TABLES) D[t] = (await this.q(`SELECT * FROM "${t}" ORDER BY id`)).map((r) => fromRow(t, r));
    D.settings = await this.getSettings();
    return D;
  }

  /** Every table at once, for the engine (cached until the next write, by any process) */
  async snapshot() {
    const t = ctx.getStore()?.tx;
    if (t) {
      if (!t.cache) t.cache = await this.load();
      return t.cache;
    }
    const v = (await this.q('SELECT value FROM settings WHERE key = ?', ['__version']))[0]?.value || '0';
    if (this.cache && this.cacheVersion === v) return this.cache;
    const D = await this.load();
    this.cache = D;
    this.cacheVersion = v;
    return D;
  }

  async all(table) {
    if (table === 'users') return (await this.q('SELECT * FROM users ORDER BY id')).map((r) => fromRow('users', r));
    return (await this.snapshot())[table];
  }

  async get(table, id) {
    return fromRow(table, (await this.q(`SELECT * FROM "${table}" WHERE id = ?`, [Number(id)]))[0]);
  }

  async isEmpty() {
    const r = await this.q("SELECT COUNT(*) AS c FROM settings WHERE key NOT LIKE '\\_\\_%' ESCAPE '\\'");
    return Number(r[0].c) === 0;
  }

  // ------------------------------------------------------------ writing
  stamp() {
    const u = currentUser();
    return { at: new Date().toISOString(), by: u ? u.name || u.username : 'system' };
  }

  async insert(table, rec, { audit = true } = {}) {
    return this.write(async (conn) => {
      const fields = SCHEMA[table];
      const row = {};
      for (const [f, kind] of Object.entries(fields)) row[f] = toDb(kind, rec[f]);
      let id = rec.id != null ? Number(rec.id) : null;
      if (!id) id = Number((await this.driver.all(conn, `SELECT COALESCE(MAX(id), 0) + 1 AS n FROM "${table}"`))[0].n);
      const s = this.stamp();
      Object.assign(row, { rev: 1, createdAt: rec.createdAt || s.at, updatedAt: rec.updatedAt || s.at, createdBy: rec.createdBy || s.by, updatedBy: rec.updatedBy || s.by });
      const names = ['id', ...Object.keys(row)];
      await this.driver.run(conn, `INSERT INTO "${table}" (${names.map((x) => `"${x}"`).join(', ')}) VALUES (${names.map(() => '?').join(', ')})`,
        [id, ...Object.keys(row).map((f) => row[f])]);
      const out = await this.get(table, id);
      if (audit && !NOT_AUDITED.has(table)) {
        const changes = {};
        for (const f of Object.keys(fields)) {
          if (row[f] === null || row[f] === 0) continue;
          const v = out[f];
          changes[f] = [null, SECRET.has(f) ? '(set)' : f === 'picture' ? '(picture)' : Array.isArray(v) ? `(${v.length} lines)` : v];
        }
        await this.audit({ action: 'create', table, recordId: id, summary: `${label(table, out)} created`, changes });
      }
      return out;
    });
  }

  /** Update; with rev, refuse when someone else changed the record since it was read */
  async update(table, id, patch, { rev, audit = true } = {}) {
    return this.write(async (conn) => {
      const before = await this.get(table, id);
      if (!before) throw new ActionError('That record no longer exists.', 404);
      if (rev !== undefined && rev !== null && Number(rev) !== before.rev) {
        throw new ActionError(`${label(table, before)} was changed by ${before.updatedBy || 'someone else'} since you opened it. Your view has been refreshed: make your change again.`, 409, { conflict: true });
      }
      const fields = SCHEMA[table];
      const keys = Object.keys(patch).filter((k) => k in fields && toDb(fields[k], patch[k]) !== toDb(fields[k], before[k]));
      if (!keys.length) return before;
      const s = this.stamp();
      await this.driver.run(conn, `UPDATE "${table}" SET ${keys.map((k) => `"${k}" = ?`).join(', ')}, rev = ?, "updatedAt" = ?, "updatedBy" = ? WHERE id = ?`,
        [...keys.map((k) => toDb(fields[k], patch[k])), (before.rev || 0) + 1, s.at, s.by, Number(id)]);
      const after = await this.get(table, id);
      if (audit && !NOT_AUDITED.has(table)) {
        const changes = {};
        for (const k of keys) changes[k] = SECRET.has(k) ? ['(hidden)', '(changed)'] : k === 'picture' ? ['(picture)', '(picture)'] : [before[k], after[k]];
        await this.audit({ action: 'update', table, recordId: id, summary: `${label(table, after)} changed`, changes });
      }
      return after;
    });
  }

  async remove(table, id) {
    return this.write(async (conn) => {
      const before = await this.get(table, id);
      if (!before) return;
      await this.driver.run(conn, `DELETE FROM "${table}" WHERE id = ?`, [Number(id)]);
      const changes = {};
      for (const f of Object.keys(SCHEMA[table])) if (before[f] !== null && before[f] !== false && !SECRET.has(f) && f !== 'picture') changes[f] = [before[f], null];
      await this.audit({ action: 'delete', table, recordId: Number(id), summary: `${label(table, before)} deleted`, changes });
    });
  }

  async removeWhere(table, field, value) {
    return this.write(async (conn) => {
      const n = Number((await this.driver.all(conn, `SELECT COUNT(*) AS c FROM "${table}" WHERE "${field}" = ?`, [value]))[0].c);
      if (!n) return 0;
      await this.driver.run(conn, `DELETE FROM "${table}" WHERE "${field}" = ?`, [value]);
      await this.audit({ action: 'delete', table, summary: `${n} ${table} with ${field} ${value} deleted` });
      return n;
    });
  }

  /** Rename a value everywhere a field holds it (names are links, as in the workbook) */
  async rename(table, field, from, to) {
    if (!from || from === to) return;
    return this.write(async (conn) => {
      await this.driver.run(conn, `UPDATE "${table}" SET "${field}" = ? WHERE "${field}" = ?`, [to, from]);
    });
  }

  // ------------------------------------------------------------ settings
  async getSettings() {
    const out = {};
    for (const r of await this.q('SELECT key, value FROM settings')) if (!r.key.startsWith('__')) out[r.key] = JSON.parse(r.value);
    return out;
  }

  async setSettings(patch, { audit = true } = {}) {
    return this.write(async (conn) => {
      const before = await this.getSettings();
      const changes = {};
      for (const [k, v] of Object.entries(patch)) {
        if (JSON.stringify(before[k] ?? null) === JSON.stringify(v ?? null)) continue;
        changes[k] = [before[k] ?? null, v ?? null];
        await this.driver.run(conn, 'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [k, JSON.stringify(v ?? null)]);
      }
      if (audit && Object.keys(changes).length) await this.audit({ action: 'update', table: 'settings', summary: 'Settings changed', changes });
    });
  }

  // ------------------------------------------------------------ audit log
  async audit({ action, table = null, recordId = null, summary = '', changes = null }) {
    return this.write(async (conn) => {
      const u = currentUser();
      const id = Number((await this.driver.all(conn, 'SELECT COALESCE(MAX(id), 0) + 1 AS n FROM "auditLog"'))[0].n);
      await this.driver.run(conn, 'INSERT INTO "auditLog" (id, at, "userId", "userName", action, tbl, "recordId", summary, changes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [id, new Date().toISOString(), u?.id ?? null, u ? u.name || u.username : 'system', action, table, recordId, summary,
          changes && Object.keys(changes).length ? JSON.stringify(changes) : null]);
    });
  }

  async auditLog({ table, recordId, userId, action, q, beforeId, limit = 100 } = {}) {
    const where = [];
    const p = [];
    if (table) { where.push('tbl = ?'); p.push(table); }
    if (recordId) { where.push('"recordId" = ?'); p.push(Number(recordId)); }
    if (userId) { where.push('"userId" = ?'); p.push(Number(userId)); }
    if (action) { where.push('action = ?'); p.push(action); }
    if (q) { where.push('(LOWER(summary) LIKE ? OR LOWER(changes) LIKE ?)'); p.push(`%${q.toLowerCase()}%`, `%${q.toLowerCase()}%`); }
    if (beforeId) { where.push('id < ?'); p.push(Number(beforeId)); }
    const rows = await this.q(`SELECT * FROM "auditLog" ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ${Math.min(500, Number(limit) || 100)}`, p);
    return rows.map((r) => ({ ...r, id: Number(r.id), recordId: r.recordId === null ? null : Number(r.recordId), changes: r.changes ? JSON.parse(r.changes) : null }));
  }

  // ------------------------------------------------------------ users and sessions
  async userByName(username) {
    return fromRow('users', (await this.q('SELECT * FROM users WHERE LOWER(username) = ?', [String(username || '').trim().toLowerCase()]))[0]);
  }

  async countUsers() {
    return Number((await this.q('SELECT COUNT(*) AS c FROM users'))[0].c);
  }

  async createSession(s) {
    return this.write((conn) => this.driver.run(conn, 'INSERT INTO sessions ("tokenHash", "userId", "expiresAt", "createdAt", ip, "userAgent") VALUES (?, ?, ?, ?, ?, ?)',
      [s.tokenHash, s.userId, s.expiresAt, new Date().toISOString(), s.ip || null, s.userAgent || null]));
  }

  async session(tokenHash) {
    const r = (await this.q('SELECT * FROM sessions WHERE "tokenHash" = ?', [tokenHash]))[0];
    return r ? { ...r, userId: Number(r.userId) } : null;
  }

  async extendSession(tokenHash, expiresAt) {
    return this.write((conn) => this.driver.run(conn, 'UPDATE sessions SET "expiresAt" = ? WHERE "tokenHash" = ?', [expiresAt, tokenHash]));
  }

  async deleteSessions(where, value) {
    return this.write((conn) => this.driver.run(conn, `DELETE FROM sessions WHERE "${where}" = ?`, [value]));
  }

  async purgeSessions() {
    return this.write((conn) => this.driver.run(conn, 'DELETE FROM sessions WHERE "expiresAt" < ?', [new Date().toISOString()]));
  }

  // ------------------------------------------------------------ bulk
  /** Delete every business record and the settings (users, sessions and the audit log stay) */
  async wipe() {
    return this.write(async (conn) => {
      for (const t of TABLES) await this.driver.run(conn, `DELETE FROM "${t}"`);
      await this.driver.run(conn, "DELETE FROM settings WHERE key NOT LIKE '\\_\\_%' ESCAPE '\\'");
    });
  }

  /** Add n days to every date field (sample mode) */
  async shiftDates(days) {
    return this.write(async (conn) => {
      for (const [t, fields] of Object.entries(SCHEMA)) {
        for (const [f, kind] of Object.entries(fields)) {
          if (kind !== 'date') continue;
          const expr = this.dialect === 'postgres'
            ? `to_char(("${f}")::date + ${Number(days)}, 'YYYY-MM-DD')`
            : `date("${f}", '+${Number(days)} days')`;
          await this.driver.run(conn, `UPDATE "${t}" SET "${f}" = ${expr} WHERE "${f}" IS NOT NULL`);
        }
      }
    });
  }

  async close() {
    await this.driver.close();
  }
}
