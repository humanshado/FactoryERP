// FactoryERP API + web server.  npm start  ->  http://localhost:3000
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TABLES } from './db.js';
import { DB_FILE, SEED_FILE, DEFAULT_SETTINGS, loadSeed, openStore, rollForward } from './seed.js';
import * as A from './actions.js';
import { todayIso } from '../shared/dates.js';
import {
  board, invoiceOfWO, invoiceWorkOrders, isLocked, isShipped, monthSummary, monthlyHours, n, orderTotals, pipeline, planning,
  profitAndLoss, stockRows,
} from '../shared/engine.js';

const here = path.dirname(fileURLToPath(import.meta.url));

export function createApp(store, { today: fixedToday } = {}) {
  const app = express();
  app.use(express.json({ limit: '8mb' }));
  const today = () => fixedToday || process.env.FACTORYERP_TODAY || todayIso();
  const calc = () => A.compute(store, today());
  const wrap = (fn) => (req, res) => {
    try {
      const out = fn(req, res);
      if (out !== undefined) res.json(out);
    } catch (e) {
      if (e instanceof A.ActionError) res.status(e.status).json({ error: e.message, confirm: !!e.confirm });
      else {
        console.error(e);
        res.status(500).json({ error: e.message || 'Something went wrong' });
      }
    }
  };
  const need = (cond, msg) => {
    if (!cond) throw new A.ActionError(msg);
  };

  // ------------------------------------------------------------ app-wide
  app.get('/api/bootstrap', wrap(() => {
    const C = calc();
    return { today: today(), settings: store.getSettings(), kpis: C.kpis };
  }));

  app.get('/api/settings', wrap(() => store.getSettings()));
  app.put('/api/settings', wrap((req) => {
    const { renames = {}, ...patch } = req.body || {};
    store.tx(() => {
      // a renamed work center keeps its routing steps, operations and people
      for (const [from, to] of Object.entries(renames.workCenters || {})) {
        if (!to || from === to) continue;
        store.rename('routingSteps', 'workCenter', from, to);
        store.rename('operations', 'workCenter', from, to);
        store.rename('employees', 'workCenter', from, to);
      }
      const allowed = Object.keys(DEFAULT_SETTINGS);
      store.setSettings(Object.fromEntries(Object.entries(patch).filter(([k]) => allowed.includes(k))));
    });
    return { settings: store.getSettings(), message: 'Settings saved' };
  }));

  // ------------------------------------------------------------ screens
  app.get('/api/stock', wrap(() => {
    const C = calc();
    const D = store.snapshot();
    return { items: D.items, stock: stockRows(C), bomLines: D.bomLines, routingSteps: D.routingSteps };
  }));

  app.get('/api/floor', wrap((req) => {
    const C = calc();
    return { kpis: C.kpis, board: board(store.snapshot(), C, req.query.week || today()) };
  }));
  app.post('/api/operations/:id/move', wrap((req) => A.moveOperation(store, today(), Number(req.params.id), req.body || {})));

  app.get('/api/pipeline', wrap(() => pipeline(store.snapshot(), calc())));
  app.get('/api/planning', wrap(() => planning(store.snapshot(), calc())));
  app.post('/api/planning/create-pos', wrap(() => A.createPurchaseOrders(store, today())));

  app.get('/api/reports', wrap((req) => {
    const D = store.snapshot();
    return { pnl: profitAndLoss(D, today()), hours: monthlyHours(D, req.query.month || today()) };
  }));

  app.get('/api/ledger/summary', wrap(() => monthSummary(store.snapshot(), today())));

  // ------------------------------------------------------------ orders
  app.get('/api/orders', wrap(() => {
    calc();
    const D = store.snapshot();
    return D.orders.map((o) => ({ ...o, total: o.type === 'Work Order' ? null : orderTotals(D, o).total }));
  }));

  app.get('/api/orders/:id', wrap((req) => {
    const C = calc();
    const D = store.snapshot();
    const o = D.orders.find((x) => x.id === Number(req.params.id));
    if (!o) throw new A.ActionError('That order no longer exists.', 404);
    const lines = D.orderLines.filter((l) => l.orderId === o.id);
    const ops = D.operations.filter((x) => x.orderId === o.id).sort((a, b) => (a.opStart || '').localeCompare(b.opStart || '') || a.id - b.id);
    const parent = o.fromNo ? D.orders.find((x) => x.orderNo === o.fromNo) : null;
    const children = D.orders.filter((x) => x.fromNo === o.orderNo || (o.type === 'Invoice' && o.fromNo && x.type === 'Work Order' && x.fromNo === o.fromNo && x.id !== o.id));
    const related = [];
    if (parent) related.push(parent);
    if (o.type === 'Work Order') {
      const inv = invoiceOfWO(D, o);
      if (inv && inv.id !== parent?.id) related.push(inv);
    }
    for (const c of children) if (!related.some((r) => r.id === c.id)) related.push(c);
    const payments = D.moneyEntries.filter((m) => m.reference === o.orderNo);
    const party = o.type === 'Purchase Order'
      ? D.suppliers.find((s) => s.name === o.party)
      : o.type === 'Work Order' ? D.items.find((i) => i.name === o.party) : D.customers.find((c) => c.name === o.party);
    const wos = o.type === 'Invoice' ? invoiceWorkOrders(D, o) : [];
    const hours = o.type === 'Work Order' ? D.timeEntries.filter((t) => t.woNo === o.orderNo).reduce((s, t) => s + n(t.hours), 0) : 0;
    return {
      order: o, lines, operations: ops, totals: orderTotals(D, o), payments, party: party || null, locked: isLocked(o),
      shipped: o.type === 'Invoice' && isShipped(o.status), waitingFor: C.wait[o.id] || '',
      related: related.map((r) => ({ id: r.id, orderNo: r.orderNo, type: r.type, status: r.status, party: r.party })),
      workOrders: wos.map((w) => ({ id: w.id, orderNo: w.orderNo, status: w.status })), loggedHours: hours,
    };
  }));

  app.post('/api/orders/new', wrap((req) => A.newOrder(store, today(), req.body || {})));
  app.put('/api/orders/:id', wrap((req) => A.saveOrder(store, today(), Number(req.params.id), req.body || {})));
  app.delete('/api/orders/:id', wrap((req) => {
    const id = Number(req.params.id);
    const o = store.get('orders', id);
    need(o, 'That order no longer exists.');
    store.tx(() => {
      store.removeWhere('orderLines', 'orderId', id);
      store.removeWhere('operations', 'orderId', id);
      store.remove('orders', id);
    });
    return { message: `${o.orderNo} deleted` };
  }));

  const ACTIONS = {
    'make-invoice': A.quoteMakeInvoice,
    'make-work-orders': A.makeWorkOrders,
    schedule: A.woSchedule,
    release: A.woRelease,
    start: A.woStart,
    complete: A.woComplete,
    ship: A.invoiceShip,
    receive: A.poReceive,
    payment: A.recordPayment,
  };
  app.post('/api/orders/:id/:action', wrap((req) => {
    const fn = ACTIONS[req.params.action];
    need(fn, `Unknown action ${req.params.action}`);
    return fn(store, today(), Number(req.params.id), req.body || {});
  }));

  app.post('/api/orderLines', wrap((req) => {
    const o = A.assertLinesEditable(store, Number(req.body.orderId));
    need(String(req.body.item || '').trim(), 'Pick an item first.');
    need(n(req.body.qty) > 0, 'Type a quantity.');
    return { record: store.insert('orderLines', { ...req.body, orderId: o.id }) };
  }));
  app.put('/api/orderLines/:id', wrap((req) => {
    const l = store.get('orderLines', req.params.id);
    need(l, 'That line no longer exists.');
    A.assertLinesEditable(store, l.orderId);
    return { record: store.update('orderLines', l.id, { ...req.body, orderId: l.orderId }) };
  }));
  app.delete('/api/orderLines/:id', wrap((req) => {
    const l = store.get('orderLines', req.params.id);
    need(l, 'That line no longer exists.');
    A.assertLinesEditable(store, l.orderId);
    store.remove('orderLines', l.id);
    return { message: 'Line removed' };
  }));

  app.put('/api/operations/:id', wrap((req) => {
    const op = store.get('operations', req.params.id);
    need(op, 'That operation no longer exists.');
    return store.tx(() => {
      const rec = store.update('operations', op.id, { ...req.body, orderId: op.orderId });
      A.syncWOStart(store, op.orderId);
      return { record: rec };
    });
  }));
  app.post('/api/operations', wrap((req) => {
    const wo = store.get('orders', req.body.orderId);
    need(wo && wo.type === 'Work Order', 'Operations belong to a work order.');
    return store.tx(() => {
      const rec = store.insert('operations', { days: 1, hours: 0, done: false, ...req.body });
      A.syncWOStart(store, wo.id);
      return { record: rec };
    });
  }));
  app.delete('/api/operations/:id', wrap((req) => {
    const op = store.get('operations', req.params.id);
    need(op, 'That operation no longer exists.');
    store.remove('operations', op.id);
    A.syncWOStart(store, op.orderId);
    return { message: 'Operation removed' };
  }));

  // ------------------------------------------------------------ master data (generic CRUD with the workbook's rules)
  const REQUIRED = {
    items: [['name', 'Item Name'], ['type', 'Item Type']],
    bomLines: [['itemId', 'Item'], ['material', 'Material'], ['qtyPerUnit', 'Qty Per Unit']],
    routingSteps: [['itemId', 'Item'], ['workCenter', 'Work Center'], ['hoursPerUnit', 'Hours Per Unit']],
    customers: [['name', 'Customer Name']],
    suppliers: [['name', 'Supplier Name']],
    moneyEntries: [['entryDate', 'Entry Date'], ['direction', 'Direction'], ['category', 'Category'], ['amount', 'Amount']],
    employees: [['name', 'Employee Name']],
    timeEntries: [['employeeId', 'Employee'], ['workDate', 'Work Date'], ['hours', 'Hours']],
  };
  const UNIQUE = { items: 'name', customers: 'name', suppliers: 'name', employees: 'name' };
  const GENERIC = Object.keys(REQUIRED);

  function validate(table, rec, id) {
    for (const [f, label] of REQUIRED[table]) {
      need(rec[f] !== undefined && rec[f] !== null && String(rec[f]).trim() !== '', `Please enter ${label} before saving.`);
    }
    const u = UNIQUE[table];
    if (u) {
      const v = String(rec[u]).trim().toLowerCase();
      need(!store.all(table).some((r) => r.id !== id && String(r[u] || '').trim().toLowerCase() === v), `"${rec[u]}" is already on the list.`);
    }
    if (table === 'bomLines') need(store.all('items').some((i) => i.name === rec.material), `${rec.material} is not an item on Stock.`);
  }

  app.get('/api/:table', wrap((req, res) => {
    if (!TABLES.includes(req.params.table)) return res.status(404).json({ error: 'Not found' });
    return store.all(req.params.table);
  }));

  app.post('/api/:table', wrap((req, res) => {
    const t = req.params.table;
    if (!GENERIC.includes(t)) return res.status(404).json({ error: 'Not found' });
    const rec = { ...req.body };
    delete rec.id;
    validate(t, rec, null);
    return { record: store.insert(t, rec), message: 'Saved' };
  }));

  app.put('/api/:table/:id', wrap((req, res) => {
    const t = req.params.table;
    if (!GENERIC.includes(t)) return res.status(404).json({ error: 'Not found' });
    const id = Number(req.params.id);
    const before = store.get(t, id);
    need(before, 'That record no longer exists.');
    const rec = { ...before, ...req.body, id };
    validate(t, rec, id);
    return store.tx(() => {
      const after = store.update(t, id, rec);
      // names are the links (as in the workbook): a rename follows everywhere
      if (before.name && after.name !== before.name) {
        if (t === 'items') {
          store.rename('bomLines', 'material', before.name, after.name);
          store.rename('orderLines', 'item', before.name, after.name);
          store.rename('orders', 'party', before.name, after.name);
        } else if (t === 'customers' || t === 'suppliers') {
          store.rename('orders', 'party', before.name, after.name);
          store.rename('moneyEntries', 'party', before.name, after.name);
          if (t === 'suppliers') store.rename('items', 'supplier', before.name, after.name);
        }
      }
      return { record: store.get(t, id), message: 'Saved' };
    });
  }));

  app.delete('/api/:table/:id', wrap((req, res) => {
    const t = req.params.table;
    if (!GENERIC.includes(t)) return res.status(404).json({ error: 'Not found' });
    const id = Number(req.params.id);
    const rec = store.get(t, id);
    need(rec, 'That record no longer exists.');
    const D = store.snapshot();
    if (t === 'items') {
      const used = D.orderLines.some((l) => l.item === rec.name) || D.orders.some((o) => o.type === 'Work Order' && o.party === rec.name)
        || D.bomLines.some((b) => b.material === rec.name);
      need(!used, `${rec.name} is used on orders or in a bill of materials, so it stays. Remove it there first.`);
    }
    if (t === 'customers' || t === 'suppliers') {
      need(!D.orders.some((o) => o.party === rec.name), `${rec.name} has orders, so it stays.`);
    }
    store.tx(() => {
      if (t === 'items') {
        store.removeWhere('bomLines', 'itemId', id);
        store.removeWhere('routingSteps', 'itemId', id);
      }
      if (t === 'employees') store.removeWhere('timeEntries', 'employeeId', id);
      store.remove(t, id);
    });
    return { message: 'Deleted' };
  }));

  // ------------------------------------------------------------ backup / restore / sample data
  app.get('/api/backup', wrap((req, res) => {
    const D = store.snapshot();
    res.setHeader('Content-Disposition', `attachment; filename="factoryerp-backup-${today()}.json"`);
    res.json(D);
  }));
  app.post('/api/restore', wrap((req) => {
    const D = req.body;
    need(D && D.settings && Array.isArray(D.items) && Array.isArray(D.orders), 'That is not a FactoryERP backup file.');
    loadSeed(store, D);
    return { message: 'Backup restored' };
  }));
  app.post('/api/reset', wrap((req) => {
    const mode = (req.body || {}).mode;
    if (mode === 'empty') {
      store.tx(() => {
        store.wipe();
        store.setSettings(DEFAULT_SETTINGS);
      });
      return { message: 'Started an empty company' };
    }
    loadSeed(store, JSON.parse(fs.readFileSync(SEED_FILE, 'utf8')));
    rollForward(store, today());
    return { message: 'Sample data loaded' };
  }));

  // ------------------------------------------------------------ the web app
  const dist = path.join(here, '..', 'dist');
  if (fs.existsSync(dist)) {
    app.use(express.static(dist));
    app.get(/^\/(?!api\/).*/, (req, res) => res.sendFile(path.join(dist, 'index.html')));
  }
  return app;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const store = openStore(DB_FILE);
  const shift = rollForward(store, process.env.FACTORYERP_TODAY || todayIso());
  const port = Number(process.env.PORT) || 3000;
  createApp(store).listen(port, () => {
    console.log(`FactoryERP running on http://localhost:${port}  (database: ${DB_FILE}${shift ? `, sample dates moved ${shift} days` : ''})`);
  });
}
