// FactoryERP API + web server.  npm start  ->  http://localhost:3000
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ActionError, TABLES } from './db.js';
import { DB_FILE, DEFAULT_SETTINGS, loadData, openStore, readSeed, rollForward, startEmpty } from './seed.js';
import * as A from './actions.js';
import {
  assertCan, authRoutes, authenticate, checkPassword, cleanUser, csrfGuard, hashPassword, requireUser,
} from './auth.js';
import { todayIso } from '../shared/dates.js';
import {
  board, invoiceOfWO, invoiceWorkOrders, isLocked, isShipped, monthSummary, monthlyHours, n, orderTotals, pipeline, planning,
  profitAndLoss, stockRows,
} from '../shared/engine.js';
import { ORDER_PERM } from '../shared/permissions.js';

const here = path.dirname(fileURLToPath(import.meta.url));

export function createApp(store, { today: fixedToday } = {}) {
  const app = express();
  app.disable('x-powered-by');
  if (process.env.FACTORYERP_TRUST_PROXY) app.set('trust proxy', process.env.FACTORYERP_TRUST_PROXY === 'true' ? true : process.env.FACTORYERP_TRUST_PROXY);
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
    next();
  });
  app.use(express.json({ limit: '25mb' }));
  app.use('/api', csrfGuard, authenticate(store));
  const today = () => fixedToday || process.env.FACTORYERP_TODAY || todayIso();
  const calc = () => A.compute(store, today());
  const wrap = (fn) => async (req, res) => {
    try {
      const out = await fn(req, res);
      if (out !== undefined && !res.headersSent) res.json(out);
    } catch (e) {
      if (e instanceof ActionError) res.status(e.status).json({ error: e.message, confirm: !!e.confirm, conflict: !!e.conflict });
      else {
        console.error(e);
        res.status(500).json({ error: 'Something went wrong on the server. The change was not saved.' });
      }
    }
  };
  const need = (cond, msg, status = 400) => {
    if (!cond) throw new ActionError(msg, status);
  };

  authRoutes(app, store, wrap);
  app.use('/api', (req, res, next) => (req.path.startsWith('/auth/') ? next() : requireUser(req, res, next)));

  // ------------------------------------------------------------ app-wide
  app.get('/api/bootstrap', wrap(async (req) => {
    const C = await calc();
    return { today: today(), settings: await store.getSettings(), kpis: C.kpis, user: req.user, database: store.dialect };
  }));

  app.get('/api/settings', wrap(() => store.getSettings()));
  app.put('/api/settings', wrap(async (req) => {
    assertCan(req, 'settings.edit');
    const { renames = {}, ...patch } = req.body || {};
    await store.tx(async () => {
      // a renamed work center keeps its routing steps, operations and people
      for (const [from, to] of Object.entries(renames.workCenters || {})) {
        if (!to || from === to) continue;
        await store.rename('routingSteps', 'workCenter', from, to);
        await store.rename('operations', 'workCenter', from, to);
        await store.rename('employees', 'workCenter', from, to);
      }
      const allowed = Object.keys(DEFAULT_SETTINGS).filter((k) => k !== 'sampleAnchor');
      await store.setSettings(Object.fromEntries(Object.entries(patch).filter(([k]) => allowed.includes(k))));
    });
    return { settings: await store.getSettings(), message: 'Settings saved' };
  }));

  // ------------------------------------------------------------ screens
  app.get('/api/stock', wrap(async () => {
    const C = await calc();
    const D = await store.snapshot();
    return { items: D.items, stock: stockRows(C), bomLines: D.bomLines, routingSteps: D.routingSteps };
  }));

  app.get('/api/stock/moves', wrap(async (req) => {
    const D = await store.snapshot();
    const id = Number(req.query.itemId);
    const ords = new Map(D.orders.map((o) => [o.id, o]));
    const moves = D.stockMoves.filter((m) => !id || m.itemId === id)
      .sort((a, b) => (a.moveDate || '').localeCompare(b.moveDate || '') || a.id - b.id);
    let bal = 0;
    const out = moves.map((m) => {
      bal += n(m.qty);
      return { ...m, balance: Math.round(bal * 1e4) / 1e4, orderType: m.orderId ? ords.get(m.orderId)?.type || null : null };
    });
    return out.reverse().slice(0, Number(req.query.limit) || 500);
  }));
  app.post('/api/stock/adjust', wrap(async (req) => {
    assertCan(req, 'stock.adjust');
    return A.stockAdjust(store, today(), req.body || {});
  }));
  app.post('/api/stock/count', wrap(async (req) => {
    assertCan(req, 'stock.adjust');
    return A.stockCount(store, today(), req.body || {});
  }));

  app.get('/api/floor', wrap(async (req) => {
    const C = await calc();
    return { kpis: C.kpis, board: board(await store.snapshot(), C, req.query.week || today()) };
  }));
  app.post('/api/operations/:id/move', wrap(async (req) => {
    assertCan(req, 'workorders.edit');
    return A.moveOperation(store, today(), Number(req.params.id), req.body || {});
  }));

  app.get('/api/pipeline', wrap(async () => pipeline(await store.snapshot(), await calc())));
  app.get('/api/planning', wrap(async () => planning(await store.snapshot(), await calc())));
  app.post('/api/planning/create-pos', wrap(async (req) => {
    assertCan(req, 'purchases.edit');
    return A.createPurchaseOrders(store, today());
  }));

  app.get('/api/reports', wrap(async (req) => {
    const D = await store.snapshot();
    return { pnl: profitAndLoss(D, today()), hours: monthlyHours(D, req.query.month || today()) };
  }));
  app.get('/api/ledger/summary', wrap(async () => monthSummary(await store.snapshot(), today())));

  app.get('/api/audit', wrap(async (req) => {
    assertCan(req, 'audit.view');
    return store.auditLog(req.query);
  }));

  // ------------------------------------------------------------ orders
  app.get('/api/orders', wrap(async () => {
    await calc();
    const D = await store.snapshot();
    return D.orders.map((o) => ({ ...o, total: o.type === 'Work Order' ? null : orderTotals(D, o).total }));
  }));

  app.get('/api/orders/:id', wrap(async (req) => {
    const C = await calc();
    const D = await store.snapshot();
    const o = D.orders.find((x) => x.id === Number(req.params.id));
    if (!o) throw new ActionError('That order no longer exists.', 404);
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
    const moves = D.stockMoves.filter((m) => m.orderId === o.id).map((m) => ({ ...m, item: D.items.find((i) => i.id === m.itemId)?.name }));
    const deletable = o.status === { Quote: 'Open', Invoice: 'Ordered', 'Work Order': 'Planned', 'Purchase Order': 'On order' }[o.type]
      && !moves.length && !payments.length && !children.length && !D.timeEntries.some((t) => t.woNo === o.orderNo);
    return {
      order: o, lines, operations: ops, totals: orderTotals(D, o), payments, party: party || null, locked: isLocked(o), deletable,
      shipped: o.type === 'Invoice' && isShipped(o.status), waitingFor: C.wait[o.id] || '', moves,
      related: related.map((r) => ({ id: r.id, orderNo: r.orderNo, type: r.type, status: r.status, party: r.party })),
      workOrders: wos.map((w) => ({ id: w.id, orderNo: w.orderNo, status: w.status })), loggedHours: hours,
    };
  }));

  const orderPerm = async (req, id) => {
    const o = await store.get('orders', id);
    need(o, 'That order no longer exists.', 404);
    assertCan(req, ORDER_PERM[o.type]);
    return o;
  };

  app.post('/api/orders/new', wrap(async (req) => {
    assertCan(req, ORDER_PERM[req.body?.type] || 'quotes.edit');
    return A.newOrder(store, today(), req.body || {});
  }));
  app.put('/api/orders/:id', wrap(async (req) => {
    await orderPerm(req, Number(req.params.id));
    const { force, ...patch } = req.body || {};
    return A.saveOrder(store, today(), Number(req.params.id), patch, { force });
  }));
  app.delete('/api/orders/:id', wrap(async (req) => {
    await orderPerm(req, Number(req.params.id));
    return A.deleteOrder(store, today(), Number(req.params.id));
  }));

  const ACTIONS = {
    'make-invoice': [A.quoteMakeInvoice, 'invoices.edit'],
    'make-work-orders': [A.makeWorkOrders, 'workorders.edit'],
    schedule: [A.woSchedule, 'workorders.edit'],
    release: [A.woRelease, 'workorders.edit'],
    start: [A.woStart, 'workorders.edit'],
    complete: [A.woComplete, 'workorders.edit'],
    ship: [A.invoiceShip, 'orders.ship'],
    receive: [A.poReceive, 'orders.receive'],
    payment: [A.recordPayment, 'payments.record'],
    cancel: [A.cancelOrder, null],
  };
  app.post('/api/orders/:id/:action', wrap(async (req) => {
    const def = ACTIONS[req.params.action];
    need(def, `Unknown action ${req.params.action}`, 404);
    const id = Number(req.params.id);
    if (def[1]) assertCan(req, def[1]);
    else await orderPerm(req, id);
    const out = await def[0](store, today(), id, req.body || {});
    await store.audit({ action: req.params.action, table: 'orders', recordId: id, summary: out.message });
    return out;
  }));

  const linePerm = async (req, orderId) => {
    const o = await orderPerm(req, orderId);
    await A.assertLinesEditable(store, o.id);
    return o;
  };
  app.post('/api/orderLines', wrap(async (req) => {
    const o = await linePerm(req, Number(req.body?.orderId));
    need(String(req.body.item || '').trim(), 'Pick an item first.');
    need(n(req.body.qty) > 0, 'Type a quantity.');
    const { id, delivered, ...rec } = req.body;
    return { record: await store.insert('orderLines', { ...rec, orderId: o.id, delivered: 0 }) };
  }));
  app.put('/api/orderLines/:id', wrap(async (req) => {
    const l = await store.get('orderLines', req.params.id);
    need(l, 'That line no longer exists.', 404);
    await linePerm(req, l.orderId);
    const { delivered, orderId, rev, ...patch } = req.body || {};
    return { record: await store.update('orderLines', l.id, patch, { rev }) };
  }));
  app.delete('/api/orderLines/:id', wrap(async (req) => {
    const l = await store.get('orderLines', req.params.id);
    need(l, 'That line no longer exists.', 404);
    await linePerm(req, l.orderId);
    await store.remove('orderLines', l.id);
    return { message: 'Line removed' };
  }));

  const opsGuard = async (req, orderId) => {
    assertCan(req, 'workorders.edit');
    const wo = await store.get('orders', orderId);
    need(wo && wo.type === 'Work Order', 'Operations belong to a work order.');
    need(!['Done', 'Cancelled'].includes(wo.status), `${wo.orderNo} is ${wo.status.toLowerCase()}: its operations are locked.`);
    return wo;
  };
  app.put('/api/operations/:id', wrap(async (req) => {
    const op = await store.get('operations', req.params.id);
    need(op, 'That operation no longer exists.', 404);
    await opsGuard(req, op.orderId);
    return store.tx(async () => {
      const { orderId, rev, ...patch } = req.body || {};
      const rec = await store.update('operations', op.id, patch, { rev });
      await A.syncWOStart(store, op.orderId);
      return { record: rec };
    });
  }));
  app.post('/api/operations', wrap(async (req) => {
    const wo = await opsGuard(req, Number(req.body?.orderId));
    return store.tx(async () => {
      const rec = await store.insert('operations', { days: 1, hours: 0, done: false, ...req.body, orderId: wo.id });
      await A.syncWOStart(store, wo.id);
      return { record: rec };
    });
  }));
  app.delete('/api/operations/:id', wrap(async (req) => {
    const op = await store.get('operations', req.params.id);
    need(op, 'That operation no longer exists.', 404);
    await opsGuard(req, op.orderId);
    await store.tx(async () => {
      await store.remove('operations', op.id);
      await A.syncWOStart(store, op.orderId);
    });
    return { message: 'Operation removed' };
  }));

  app.post('/api/moneyEntries/:id/void', wrap(async (req) => {
    assertCan(req, 'ledger.edit');
    return A.voidMoney(store, today(), Number(req.params.id), req.body || {});
  }));

  // ------------------------------------------------------------ backup / restore / sample data
  app.get('/api/backup', wrap(async (req, res) => {
    assertCan(req, 'data.manage');
    const D = await store.snapshot();
    await store.audit({ action: 'backup', summary: 'Backup downloaded' });
    res.setHeader('Content-Disposition', `attachment; filename="factoryerp-backup-${today()}.json"`);
    res.json({ format: 'factoryerp-backup', version: 2, at: new Date().toISOString(), ...D });
  }));
  app.post('/api/restore', wrap(async (req) => {
    assertCan(req, 'data.manage');
    const D = req.body;
    need(D && D.settings && Array.isArray(D.items) && Array.isArray(D.orders), 'That is not a FactoryERP backup file.');
    await loadData(store, D, 'Backup restored');
    return { message: 'Backup restored' };
  }));
  app.post('/api/reset', wrap(async (req) => {
    assertCan(req, 'data.manage');
    if ((req.body || {}).mode === 'empty') {
      await startEmpty(store);
      return { message: 'Started an empty company' };
    }
    await loadData(store, readSeed());
    await rollForward(store, today());
    return { message: 'Sample data loaded' };
  }));

  // ------------------------------------------------------------ master data (generic CRUD with the rules)
  const RULES = {
    items: { perm: 'items.edit', req: [['name', 'Item Name'], ['type', 'Item Type']], unique: 'name' },
    bomLines: { perm: 'items.edit', req: [['itemId', 'Item'], ['material', 'Material'], ['qtyPerUnit', 'Qty Per Unit']] },
    routingSteps: { perm: 'items.edit', req: [['itemId', 'Item'], ['workCenter', 'Work Center'], ['hoursPerUnit', 'Hours Per Unit']] },
    customers: { perm: 'customers.edit', req: [['name', 'Customer Name']], unique: 'name' },
    suppliers: { perm: 'suppliers.edit', req: [['name', 'Supplier Name']], unique: 'name' },
    moneyEntries: { perm: 'ledger.edit', req: [['entryDate', 'Entry Date'], ['direction', 'Direction'], ['category', 'Category'], ['amount', 'Amount']] },
    employees: { perm: 'people.edit', req: [['name', 'Employee Name']], unique: 'name' },
    timeEntries: { perm: 'time.edit', req: [['employeeId', 'Employee'], ['workDate', 'Work Date'], ['hours', 'Hours']] },
  };
  const SYS = ['id', 'rev', 'createdAt', 'updatedAt', 'createdBy', 'updatedBy'];

  async function validate(t, rec, id) {
    for (const [f, lbl] of RULES[t].req) {
      need(rec[f] !== undefined && rec[f] !== null && String(rec[f]).trim() !== '', `Please enter ${lbl} before saving.`);
    }
    const u = RULES[t].unique;
    if (u) {
      const v = String(rec[u]).trim().toLowerCase();
      need(!(await store.all(t)).some((r) => r.id !== id && String(r[u] || '').trim().toLowerCase() === v), `"${rec[u]}" is already on the list.`);
    }
    if (t === 'bomLines') need((await store.all('items')).some((i) => i.name === rec.material), `${rec.material} is not an item on Stock.`);
    if (t === 'moneyEntries') need(n(rec.amount) > 0, 'The amount must be more than zero (Direction says in or out).');
  }

  app.get('/api/:table', wrap(async (req, res) => {
    if (!TABLES.includes(req.params.table)) return res.status(404).json({ error: 'Not found' });
    return store.all(req.params.table);
  }));

  app.post('/api/:table', wrap(async (req, res) => {
    const t = req.params.table;
    if (!RULES[t]) return res.status(404).json({ error: 'Not found' });
    assertCan(req, RULES[t].perm);
    const rec = { ...req.body };
    for (const k of [...SYS, 'void', 'voidReason']) delete rec[k];
    await validate(t, rec, null);
    return store.tx(async () => {
      const record = await store.insert(t, rec);
      if (t === 'items' && n(rec.openingStock)) {
        const C = await A.compute(store, today());
        await store.insert('stockMoves', { moveDate: today(), itemId: record.id, qty: n(rec.openingStock), type: 'opening', unitCost: C.byId.get(record.id)?.cost ?? n(rec.unitCost), note: 'Opening stock' }, { audit: false });
      }
      if (t === 'moneyEntries') await A.refreshPayStatus(store, record.reference);
      return { record, message: 'Saved' };
    });
  }));

  app.put('/api/:table/:id', wrap(async (req, res) => {
    const t = req.params.table;
    if (!RULES[t]) return res.status(404).json({ error: 'Not found' });
    assertCan(req, RULES[t].perm);
    const id = Number(req.params.id);
    const before = await store.get(t, id);
    need(before, 'That record no longer exists.', 404);
    const { rev, ...body } = req.body || {};
    for (const k of [...SYS, 'void', 'voidReason', 'openingStock']) delete body[k];
    if (t === 'moneyEntries') need(!before.void, 'A void entry cannot change.');
    const rec = { ...before, ...body, id };
    await validate(t, rec, id);
    return store.tx(async () => {
      const after = await store.update(t, id, body, { rev });
      // names are the links (as in the workbook): a rename follows everywhere
      if (before.name && after.name !== before.name) {
        if (t === 'items') {
          await store.rename('bomLines', 'material', before.name, after.name);
          await store.rename('orderLines', 'item', before.name, after.name);
          await store.rename('orders', 'party', before.name, after.name);
        } else if (t === 'customers' || t === 'suppliers') {
          await store.rename('orders', 'party', before.name, after.name);
          await store.rename('moneyEntries', 'party', before.name, after.name);
          if (t === 'suppliers') await store.rename('items', 'supplier', before.name, after.name);
        }
      }
      if (t === 'moneyEntries') {
        await A.refreshPayStatus(store, before.reference);
        if (after.reference !== before.reference) await A.refreshPayStatus(store, after.reference);
      }
      return { record: await store.get(t, id), message: 'Saved' };
    });
  }));

  app.delete('/api/:table/:id', wrap(async (req, res) => {
    const t = req.params.table;
    if (!RULES[t]) return res.status(404).json({ error: 'Not found' });
    assertCan(req, RULES[t].perm);
    const id = Number(req.params.id);
    const rec = await store.get(t, id);
    need(rec, 'That record no longer exists.', 404);
    const D = await store.snapshot();
    need(t !== 'moneyEntries', 'Ledger entries are not deleted: void it instead (it stays on file, out of the totals).');
    if (t === 'items') {
      const used = D.orderLines.some((l) => l.item === rec.name) || D.orders.some((o) => o.type === 'Work Order' && o.party === rec.name)
        || D.bomLines.some((b) => b.material === rec.name) || D.stockMoves.some((m) => m.itemId === id && m.type !== 'opening');
      need(!used, `${rec.name} is used on orders, in a bill of materials or in the stock history. Archive it instead.`);
    }
    if (t === 'customers' || t === 'suppliers') need(!D.orders.some((o) => o.party === rec.name), `${rec.name} has orders. Archive it instead.`);
    if (t === 'employees') need(!D.timeEntries.some((x) => x.employeeId === id), `${rec.name} has time entries. Archive them instead.`);
    await store.tx(async () => {
      if (t === 'items') {
        await store.removeWhere('bomLines', 'itemId', id);
        await store.removeWhere('routingSteps', 'itemId', id);
        await store.removeWhere('stockMoves', 'itemId', id);
      }
      await store.remove(t, id);
    });
    return { message: 'Deleted' };
  }));

  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

  // ------------------------------------------------------------ the web app
  const dist = path.join(here, '..', 'dist');
  if (fs.existsSync(dist)) {
    app.use(express.static(dist, { index: false }));
    app.get(/^\/(?!api\/).*/, (req, res) => res.sendFile(path.join(dist, 'index.html')));
  }
  return app;
}

/** A first administrator from the environment, for installs without a browser at hand */
async function adminFromEnv(store) {
  const { FACTORYERP_ADMIN_USER: u, FACTORYERP_ADMIN_PASSWORD: pw } = process.env;
  if (!u || !pw || (await store.countUsers()) > 0) return false;
  checkPassword(pw);
  await store.insert('users', { username: u, name: u, roles: ['admin'], passwordHash: hashPassword(pw), active: true });
  return true;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const store = await openStore();
  const shift = await rollForward(store, process.env.FACTORYERP_TODAY || todayIso());
  const made = await adminFromEnv(store);
  const port = Number(process.env.PORT) || 3000;
  const where = store.dialect === 'postgres' ? 'PostgreSQL (DATABASE_URL)' : DB_FILE;
  createApp(store).listen(port, () => {
    console.log(`FactoryERP running on http://localhost:${port}  (database: ${where}${shift ? `, sample dates moved ${shift} days` : ''})`);
    if (made) console.log(`Administrator ${process.env.FACTORYERP_ADMIN_USER} created from the environment.`);
    else store.countUsers().then((c) => !c && console.log('No users yet: open the app in a browser to create the first administrator.'));
  });
}

export { cleanUser };
