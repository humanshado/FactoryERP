// FactoryERP storage: one SQLite file (Node's built-in node:sqlite, no native build).
// Every table is described once in SCHEMA; the store gives the rest of the server
// plain objects (dates as "YYYY-MM-DD", booleans as true/false).
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

export const SCHEMA = {
  items: {
    name: 'text', code: 'text', description: 'text', type: 'text', category: 'text', unit: 'text', unitCost: 'num',
    price: 'num', openingStock: 'num', reorderPoint: 'num', supplier: 'text', expiryDate: 'date', picture: 'text', notes: 'text',
  },
  bomLines: { itemId: 'int', material: 'text', qtyPerUnit: 'num' },
  routingSteps: { itemId: 'int', workCenter: 'text', hoursPerUnit: 'num' },
  customers: {
    name: 'text', contact: 'text', phone: 'text', email: 'text', street: 'text', city: 'text', state: 'text', zip: 'text', notes: 'text',
  },
  suppliers: { name: 'text', contact: 'text', phone: 'text', email: 'text', leadDays: 'num', notes: 'text' },
  orders: {
    orderNo: 'text', type: 'text', party: 'text', orderDate: 'date', dueDate: 'date', status: 'text', fromNo: 'text', qty: 'num',
    priority: 'text', closedDate: 'date', paidDate: 'date', notes: 'text', taxRate: 'num', taxName: 'text', useTax: 'text',
  },
  orderLines: { orderId: 'int', item: 'text', description: 'text', qty: 'num', price: 'num' },
  operations: { orderId: 'int', workCenter: 'text', opStart: 'date', days: 'num', hours: 'num', done: 'bool' },
  moneyEntries: {
    entryDate: 'date', direction: 'text', category: 'text', party: 'text', reference: 'text', amount: 'num', method: 'text', notes: 'text',
  },
  employees: {
    name: 'text', role: 'text', workCenter: 'text', hourlyRate: 'num', startDate: 'date', phone: 'text', notes: 'text',
  },
  timeEntries: { employeeId: 'int', workDate: 'date', woNo: 'text', hours: 'num', notes: 'text' },
};

export const TABLES = Object.keys(SCHEMA);

const SQL_TYPE = { text: 'TEXT', date: 'TEXT', num: 'REAL', int: 'INTEGER', bool: 'INTEGER' };

function clean(kind, v) {
  if (v === undefined || v === null || v === '') return null;
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

function fromRow(table, row) {
  if (!row) return null;
  const out = { id: row.id };
  for (const [f, kind] of Object.entries(SCHEMA[table])) {
    out[f] = kind === 'bool' ? !!row[f] : row[f] ?? null;
  }
  return out;
}

export class Store {
  constructor(file) {
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = OFF;');
    for (const [t, fields] of Object.entries(SCHEMA)) {
      const cols = Object.entries(fields).map(([f, k]) => `"${f}" ${SQL_TYPE[k]}`).join(', ');
      this.db.exec(`CREATE TABLE IF NOT EXISTS "${t}" (id INTEGER PRIMARY KEY, ${cols})`);
      // add any column a newer version introduced
      const have = new Set(this.db.prepare(`PRAGMA table_info("${t}")`).all().map((c) => c.name));
      for (const [f, k] of Object.entries(fields)) {
        if (!have.has(f)) this.db.exec(`ALTER TABLE "${t}" ADD COLUMN "${f}" ${SQL_TYPE[k]}`);
      }
    }
    this.db.exec('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)');
    this.cache = null;
    this.depth = 0;
  }

  isEmpty() {
    return this.db.prepare('SELECT COUNT(*) AS c FROM settings').get().c === 0;
  }

  invalidate() {
    this.cache = null;
  }

  all(table) {
    return this.snapshot()[table];
  }

  get(table, id) {
    return fromRow(table, this.db.prepare(`SELECT * FROM "${table}" WHERE id = ?`).get(Number(id)));
  }

  insert(table, rec) {
    const fields = SCHEMA[table];
    const row = {};
    for (const [f, kind] of Object.entries(fields)) row[f] = clean(kind, rec[f]);
    let id = rec.id != null ? Number(rec.id) : null;
    if (!id) id = (this.db.prepare(`SELECT COALESCE(MAX(id), 0) + 1 AS n FROM "${table}"`).get().n);
    const names = ['id', ...Object.keys(fields)];
    this.db.prepare(`INSERT INTO "${table}" (${names.map((x) => `"${x}"`).join(', ')}) VALUES (${names.map(() => '?').join(', ')})`)
      .run(id, ...Object.keys(fields).map((f) => row[f]));
    this.invalidate();
    return this.get(table, id);
  }

  update(table, id, patch) {
    const fields = SCHEMA[table];
    const keys = Object.keys(patch).filter((k) => k in fields);
    if (keys.length) {
      this.db.prepare(`UPDATE "${table}" SET ${keys.map((k) => `"${k}" = ?`).join(', ')} WHERE id = ?`)
        .run(...keys.map((k) => clean(fields[k], patch[k])), Number(id));
      this.invalidate();
    }
    return this.get(table, id);
  }

  remove(table, id) {
    this.db.prepare(`DELETE FROM "${table}" WHERE id = ?`).run(Number(id));
    this.invalidate();
  }

  removeWhere(table, field, value) {
    this.db.prepare(`DELETE FROM "${table}" WHERE "${field}" = ?`).run(value);
    this.invalidate();
  }

  /** Rename a value everywhere a field holds it (names are the links, as in the workbook) */
  rename(table, field, from, to) {
    if (!from || from === to) return;
    this.db.prepare(`UPDATE "${table}" SET "${field}" = ? WHERE "${field}" = ?`).run(to, from);
    this.invalidate();
  }

  getSettings() {
    const out = {};
    for (const r of this.db.prepare('SELECT key, value FROM settings').all()) out[r.key] = JSON.parse(r.value);
    return out;
  }

  setSettings(patch) {
    const st = this.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
    for (const [k, v] of Object.entries(patch)) st.run(k, JSON.stringify(v ?? null));
    this.invalidate();
  }

  /** Every table at once, for the engine (cached until the next write) */
  snapshot() {
    if (!this.cache) {
      const D = {};
      for (const t of TABLES) D[t] = this.db.prepare(`SELECT * FROM "${t}" ORDER BY id`).all().map((r) => fromRow(t, r));
      D.settings = this.getSettings();
      this.cache = D;
    }
    return this.cache;
  }

  /** Run fn in one transaction: all of it or none of it */
  tx(fn) {
    if (this.depth > 0) return fn();
    this.depth++;
    this.db.exec('BEGIN');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (e) {
      this.db.exec('ROLLBACK');
      this.invalidate();
      throw e;
    } finally {
      this.depth--;
    }
  }

  wipe() {
    for (const t of TABLES) this.db.exec(`DELETE FROM "${t}"`);
    this.db.exec('DELETE FROM settings');
    this.invalidate();
  }

  close() {
    this.db.close();
  }
}
