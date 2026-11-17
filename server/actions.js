// One-click workflow (the NEXT STEP buttons), ported from the workbook's ERP_Actions:
//   Quote:          Make Invoice (the invoice is the order; From = the quote) / Make Work Orders (one per made product)
//   Invoice:        follows its work orders (In production; shipped when all are done); Record Payment (Money In)
//   Work Order:     Schedule > Release > Start > Complete (finished goods in, materials out, hours logged)
//   Purchase Order: Receive (stock in); Record Payment (Money Out)
//   Planning:       Create Purchase Orders (one per supplier for every shortfall)
import { addDays, addWorkdays, isDate, nextWorkday, workday } from '../shared/dates.js';
import {
  PREFIX, STATUSES, ceil, invoiceOfWO, invoiceWorkOrders, isLocked, isShipped, n, orderTotals, payStatus, r2, recalc, wcHours,
} from '../shared/engine.js';

export class ActionError extends Error {
  constructor(message, status = 400, extra = {}) {
    super(message);
    this.status = status;
    Object.assign(this, extra);
  }
}
/** Ask the user first: the client shows the question and repeats the call with force: true */
const confirm = (message) => new ActionError(message, 409, { confirm: true });
const money = (x) => `$${r2(x).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Recalculate, and store what the engine decided by itself (open quotes past Valid Until become Expired) */
export function compute(store, today) {
  let C = recalc(store.snapshot(), today);
  if (C.expiredQuotes.length) {
    store.tx(() => C.expiredQuotes.forEach((id) => store.update('orders', id, { status: 'Expired' })));
    C = recalc(store.snapshot(), today);
  }
  return C;
}

function orderOf(store, id, type, action) {
  const o = store.get('orders', id);
  if (!o) throw new ActionError('That order no longer exists.', 404);
  if (type && o.type !== type) throw new ActionError(`${action} works on a ${type.toLowerCase()}. ${o.orderNo} is a ${o.type.toLowerCase()}.`);
  return o;
}

export function nextNo(store, prefix) {
  let best = 0;
  let width = 4;
  for (const o of store.all('orders')) {
    const s = String(o.orderNo || '');
    if (!s.startsWith(prefix)) continue;
    const num = s.slice(prefix.length);
    if (/^\d+$/.test(num) && Number(num) > best) {
      best = Number(num);
      width = num.length;
    }
  }
  if (best === 0) best = 1000;
  return prefix + String(best + 1).padStart(width, '0');
}

function taxStamp(settings) {
  return {
    useTax: String(settings.useSalesTax).toUpperCase() === 'YES' ? 'Yes' : 'No',
    taxRate: n(settings.taxRate),
    taxName: settings.salesTaxName || 'Sales Tax',
  };
}

function addOrder(store, type, fields) {
  const S = store.getSettings();
  return store.insert('orders', { orderNo: nextNo(store, PREFIX[type]), type, ...taxStamp(S), ...fields });
}

/** A blank order of a type: next number, today, its first status */
export function newOrder(store, today, { type = 'Quote', party = null } = {}) {
  if (!PREFIX[type]) throw new ActionError(`Unknown order type: ${type}`);
  const S = store.getSettings();
  const due = {
    Quote: addDays(today, 30),
    Invoice: workday(today, n(S.dueDays) || 15),
    'Work Order': workday(today, n(S.dueDays) || 15),
    'Purchase Order': nextWorkday(addDays(today, 7)),
  }[type];
  const o = addOrder(store, type, {
    party, orderDate: type === 'Work Order' ? addWorkdays(today, 1) : today, dueDate: due, status: STATUSES[type][0],
    priority: type === 'Work Order' ? 'Normal' : null,
  });
  return { order: o, message: `${o.orderNo} created` };
}

/** Operations from the product's routing, one after another from start. Returns how many. */
export function makeOps(store, woId, itemName, qty, start) {
  const D = store.snapshot();
  const prod = D.items.find((i) => String(i.name).toLowerCase() === String(itemName || '').toLowerCase());
  if (!prod) return 0;
  let s = nextWorkday(start);
  let made = 0;
  for (const r of D.routingSteps.filter((x) => x.itemId === prod.id)) {
    const h = Math.round(n(r.hoursPerUnit) * qty * 100) / 100;
    const dur = Math.max(1, Math.ceil(h / wcHours(D.settings, r.workCenter) - 1e-6));
    store.insert('operations', { orderId: woId, workCenter: r.workCenter, opStart: s, days: dur, hours: h, done: false });
    s = addWorkdays(s, dur);
    made++;
  }
  return made;
}

/** A work order starts when its first operation starts */
export function syncWOStart(store, woId) {
  const ops = store.all('operations').filter((o) => o.orderId === woId && isDate(o.opStart));
  if (!ops.length) return;
  const first = ops.map((o) => o.opStart).sort()[0];
  store.update('orders', woId, { orderDate: first });
}

// ---------------------------------------------------------------- invoices follow their work orders
function shipInvoice(store, today, inv, keepStatus = false) {
  const patch = { orderDate: today, closedDate: today, dueDate: addDays(today, 30) };
  store.update('orders', inv.id, patch);
  let cur = store.get('orders', inv.id);
  if (!keepStatus || !isShipped(cur.status)) {
    store.update('orders', inv.id, { status: payStatus(store.snapshot(), cur) });
    cur = store.get('orders', inv.id);
  }
  if (cur.status === 'Paid' && !isDate(cur.paidDate)) store.update('orders', inv.id, { paidDate: today });
}

function invoiceFollowWO(store, today, wo) {
  const inv = invoiceOfWO(store.snapshot(), wo);
  if (!inv || isShipped(inv.status)) return null;
  const wos = invoiceWorkOrders(store.snapshot(), inv);
  const done = wos.filter((w) => w.status === 'Done').length;
  const going = wos.filter((w) => w.status !== 'Planned').length;
  if (wos.length && done === wos.length) {
    shipInvoice(store, today, inv);
    return `${inv.orderNo} shipped`;
  }
  if (going > 0) store.update('orders', inv.id, { status: 'In production' });
  return null;
}

/** Save on Orders: an invoice saved as Unpaid / Part paid / Paid that has not shipped yet ships now */
export function saveOrder(store, today, id, patch) {
  const before = orderOf(store, id);
  const p = { ...patch };
  delete p.id;
  delete p.type;
  if ('orderNo' in p && !String(p.orderNo || '').trim()) throw new ActionError('Please enter an Order # before saving.');
  if ('party' in p && !String(p.party || '').trim()) {
    throw new ActionError(`Pick the ${before.type === 'Purchase Order' ? 'supplier' : before.type === 'Work Order' ? 'product' : 'customer'} first.`);
  }
  if ('orderDate' in p && !isDate(p.orderDate)) throw new ActionError('Please enter a date before saving.');
  if ('status' in p && !STATUSES[before.type].includes(p.status)) throw new ActionError(`A ${before.type.toLowerCase()} cannot be ${p.status}.`);
  if (p.orderNo && store.all('orders').some((o) => o.orderNo === p.orderNo && o.id !== before.id)) {
    throw new ActionError(`Order # ${p.orderNo} is already used.`);
  }
  return store.tx(() => {
    if (p.orderNo && p.orderNo !== before.orderNo) {
      // keep the links: payments, child orders and logged hours point at the number
      store.rename('orders', 'fromNo', before.orderNo, p.orderNo);
      store.rename('moneyEntries', 'reference', before.orderNo, p.orderNo);
      store.rename('timeEntries', 'woNo', before.orderNo, p.orderNo);
    }
    let o = store.update('orders', id, p);
    let msg = `${o.orderNo} saved`;
    if (o.type === 'Invoice' && isShipped(o.status) && !isDate(o.closedDate)) {
      shipInvoice(store, today, o, true);
      msg += ': shipped';
    }
    if (o.type === 'Purchase Order' && o.status === 'Received' && !isDate(o.closedDate)) store.update('orders', id, { closedDate: today });
    if (o.type === 'Work Order' && o.status === 'Done' && !isDate(o.closedDate)) store.update('orders', id, { closedDate: today });
    if (o.type === 'Work Order' && 'qty' in p && n(p.qty) !== n(before.qty) && o.status !== 'Done') {
      // the operations follow the new quantity (hours and days from the routing)
      const start = o.orderDate || addWorkdays(today, 1);
      store.removeWhere('operations', 'orderId', o.id);
      if (n(o.qty) > 0) makeOps(store, o.id, o.party, n(o.qty), start);
      msg += ': operations re-planned';
    }
    o = store.get('orders', id);
    return { order: o, message: msg };
  });
}

export function assertLinesEditable(store, orderId) {
  const o = orderOf(store, orderId);
  if (o.type === 'Work Order') throw new ActionError('A work order has no lines: its product and quantity are on the order.');
  if (isLocked(o)) throw new ActionError(`${o.orderNo} is ${o.status.toLowerCase()}: its lines are locked.`);
  return o;
}

// ---------------------------------------------------------------- QUOTES
function quoteUsable(o, action) {
  if (o.status === 'Lost') throw new ActionError(`${o.orderNo} is lost. Set its status back to Open first.`);
  if (o.status === 'Expired') {
    throw new ActionError(`${o.orderNo} expired on ${o.dueDate}. Give it a new Valid Until date and set its status back to Open first (${action}).`);
  }
}

export function quoteMakeInvoice(store, today, id) {
  const q = orderOf(store, id, 'Quote', 'Make Invoice');
  quoteUsable(q, 'Make Invoice');
  const D = store.snapshot();
  const existing = D.orders.find((o) => o.type === 'Invoice' && o.fromNo === q.orderNo);
  if (existing) return { orderId: existing.id, message: `${q.orderNo} already has invoice ${existing.orderNo}` };
  const lines = D.orderLines.filter((l) => l.orderId === q.id);
  if (!lines.length) throw new ActionError("Add the quote's lines first.");
  const S = store.getSettings();
  return store.tx(() => {
    const inv = addOrder(store, 'Invoice', {
      party: q.party, fromNo: q.orderNo, orderDate: today, dueDate: workday(today, n(S.dueDays) || 15), status: 'Ordered',
    });
    for (const l of lines) store.insert('orderLines', { orderId: inv.id, item: l.item, description: l.description, qty: l.qty, price: l.price });
    store.update('orders', q.id, { status: 'Accepted' });
    const wos = invoiceWorkOrders(store.snapshot(), inv);
    if (wos.length && wos.every((w) => w.status === 'Done')) shipInvoice(store, today, inv);
    else if (wos.some((w) => w.status !== 'Planned')) store.update('orders', inv.id, { status: 'In production' });
    return { orderId: inv.id, message: `Invoice ${inv.orderNo} made from ${q.orderNo}` };
  });
}

/** Make Work Orders: one per made product on the quote (or on an invoice made without a quote) */
export function makeWorkOrders(store, today, id) {
  const src = orderOf(store, id);
  if (src.type !== 'Quote' && src.type !== 'Invoice') throw new ActionError('Make Work Orders works on a quote or an invoice.');
  if (src.type === 'Quote') quoteUsable(src, 'Make Work Orders');
  if (src.type === 'Invoice' && isShipped(src.status)) throw new ActionError(`${src.orderNo} has shipped already.`);
  const D = store.snapshot();
  const fromNo = src.type === 'Invoice' && src.fromNo ? src.fromNo : src.orderNo;
  if (D.orders.some((o) => o.type === 'Work Order' && (o.fromNo === src.orderNo || o.fromNo === fromNo))) {
    throw new ActionError(`${src.orderNo} already has work orders. See them under Work Orders or on the Floor.`);
  }
  const S = store.getSettings();
  let due = workday(today, n(S.dueDays) || 15);
  const inv = src.type === 'Invoice' ? src : D.orders.find((o) => o.type === 'Invoice' && o.fromNo === src.orderNo);
  if (inv && !isShipped(inv.status) && isDate(inv.dueDate)) due = inv.dueDate;
  const start = addWorkdays(today, 1);
  const made = store.tx(() => {
    const ids = [];
    for (const l of D.orderLines.filter((x) => x.orderId === src.id)) {
      const it = D.items.find((i) => String(i.name).toLowerCase() === String(l.item || '').toLowerCase());
      if (!it || it.type !== 'Finished') continue;
      const wo = addOrder(store, 'Work Order', {
        party: it.name, fromNo, orderDate: start, dueDate: due, status: 'Planned', qty: n(l.qty), priority: 'Normal',
      });
      makeOps(store, wo.id, it.name, n(l.qty), start);
      ids.push(wo.id);
    }
    if (ids.length && src.type === 'Quote' && src.status === 'Open') store.update('orders', src.id, { status: 'Accepted' });
    return ids;
  });
  if (!made.length) throw new ActionError('This order has no lines for products you make (Item Type Finished).');
  return { orderId: made[0], message: `${src.orderNo}: ${made.length} work order${made.length === 1 ? '' : 's'} made` };
}

// ---------------------------------------------------------------- WORK ORDERS
export function woSchedule(store, today, id) {
  const wo = orderOf(store, id, 'Work Order', 'Schedule');
  const has = store.all('operations').some((o) => o.orderId === wo.id);
  if (!has) {
    const start = isDate(wo.orderDate) ? wo.orderDate : addWorkdays(today, 1);
    const made = store.tx(() => makeOps(store, wo.id, wo.party, n(wo.qty), start));
    if (!made) throw new ActionError('This product has no routing yet (Stock > Routing): add its work centers and hours per unit first.');
    store.update('orders', wo.id, { orderDate: nextWorkday(start) });
  }
  const w = store.get('orders', wo.id);
  return { orderId: wo.id, boardWeek: w.orderDate, message: has ? `${wo.orderNo} is on the Floor` : `${wo.orderNo} scheduled` };
}

export function woRelease(store, today, id) {
  const wo = orderOf(store, id, 'Work Order', 'Release');
  if (wo.status !== 'Planned') throw new ActionError(`Only a Planned work order can be released (this one is ${wo.status}).`);
  store.tx(() => {
    store.update('orders', wo.id, { status: 'Released' });
    invoiceFollowWO(store, today, store.get('orders', wo.id));
  });
  const C = compute(store, today);
  if (C.wait[wo.id]) {
    return {
      orderId: wo.id, warning: true,
      message: `${wo.orderNo} released, but it is waiting for material: ${C.wait[wo.id]}. Planning > Create Purchase Orders orders what is missing.`,
    };
  }
  return { orderId: wo.id, message: `${wo.orderNo} released: materials OK` };
}

export function woStart(store, today, id, { force } = {}) {
  const wo = orderOf(store, id, 'Work Order', 'Start');
  if (wo.status === 'In progress' || wo.status === 'Done') throw new ActionError(`This work order is already ${wo.status.toLowerCase()}.`);
  const C = compute(store, today);
  if (C.wait[wo.id] && !force) throw confirm(`It is waiting for ${C.wait[wo.id]}. Start anyway?`);
  store.tx(() => {
    store.update('orders', wo.id, { status: 'In progress' });
    invoiceFollowWO(store, today, store.get('orders', wo.id));
  });
  return { orderId: wo.id, message: `${wo.orderNo} started` };
}

/** Complete: done today, every operation done, hours logged for the people of each work center */
export function woComplete(store, today, id, { force } = {}) {
  const wo = orderOf(store, id, 'Work Order', 'Complete');
  if (wo.status === 'Done') throw new ActionError(`${wo.orderNo} is already done.`);
  const C = compute(store, today);
  if (C.wait[wo.id] && !force) {
    throw confirm(`There is not enough ${C.wait[wo.id]} on hand for ${wo.orderNo}. Complete anyway (stock goes below zero)?`);
  }
  return store.tx(() => {
    store.update('orders', wo.id, { status: 'Done', closedDate: today });
    const D = store.snapshot();
    const logged = new Set(D.timeEntries.filter((t) => t.woNo === wo.orderNo).map((t) => t.employeeId));
    let k = 0;
    for (const op of D.operations.filter((o) => o.orderId === wo.id)) {
      store.update('operations', op.id, { done: true });
      const people = D.employees.filter((e) => e.workCenter === op.workCenter && !logged.has(e.id));
      for (const e of people) {
        store.insert('timeEntries', {
          employeeId: e.id, workDate: today, woNo: wo.orderNo, hours: Math.round((n(op.hours) / people.length) * 100) / 100, notes: 'Logged by Complete',
        });
        k++;
      }
    }
    const shipped = invoiceFollowWO(store, today, store.get('orders', wo.id));
    return {
      orderId: wo.id,
      message: `${wo.orderNo} done: ${n(wo.qty)} made${k ? ', hours logged' : ''}${shipped ? `, ${shipped}` : ''}`,
    };
  });
}

// ---------------------------------------------------------------- INVOICES
export function invoiceShip(store, today, id) {
  const inv = orderOf(store, id, 'Invoice', 'Ship');
  if (isShipped(inv.status)) throw new ActionError(`${inv.orderNo} has shipped already (${inv.status}).`);
  store.tx(() => shipInvoice(store, today, inv));
  const o = store.get('orders', inv.id);
  return { orderId: inv.id, message: `${o.orderNo} shipped: ${o.status}` };
}

// ---------------------------------------------------------------- PURCHASE ORDERS
export function poReceive(store, today, id) {
  const po = orderOf(store, id, 'Purchase Order', 'Receive');
  if (po.status === 'Received') throw new ActionError(`${po.orderNo} was received on ${po.closedDate}.`);
  store.update('orders', po.id, { status: 'Received', closedDate: today });
  return { orderId: po.id, message: `${po.orderNo} received: stock updated` };
}

/** Record Payment: a Money In (invoice) / Money Out (purchase order) row with the order number */
export function recordPayment(store, today, id, { amount, date, method, force } = {}) {
  const o = orderOf(store, id);
  if (o.type !== 'Invoice' && o.type !== 'Purchase Order') throw new ActionError('Record Payment works on an invoice or a purchase order.');
  const amt = r2(n(amount));
  if (amt <= 0) throw new ActionError(`Type the amount ${o.type === 'Invoice' ? 'received' : 'paid'}, then Record Payment.`);
  const d = isDate(date) ? date : today;
  const { balance } = orderTotals(store.snapshot(), o);
  if (amt > balance + 0.004 && !force) throw confirm(`That is more than the balance (${money(balance)}). Record it anyway?`);
  return store.tx(() => {
    store.insert('moneyEntries', {
      entryDate: d, direction: o.type === 'Invoice' ? 'In' : 'Out', category: o.type === 'Invoice' ? 'Customer payment' : 'Supplier payment',
      party: o.party, reference: o.orderNo, amount: amt, method: method || 'Bank transfer',
    });
    const after = orderTotals(store.snapshot(), o);
    let note;
    if (o.type === 'Invoice') {
      if (isShipped(o.status)) {
        const st = payStatus(store.snapshot(), o);
        store.update('orders', o.id, { status: st, ...(st === 'Paid' ? { paidDate: d } : {}) });
        note = st === 'Paid' ? ' (paid in full)' : ` (balance ${money(after.balance)})`;
      } else note = ' (a deposit: it ships later)';
    } else if (after.balance <= 0.004) {
      store.update('orders', o.id, { paidDate: d });
      note = ' (paid in full)';
    } else note = ` (balance ${money(after.balance)})`;
    return { orderId: o.id, message: `Payment recorded: ${money(amt)}${note}` };
  });
}

// ---------------------------------------------------------------- PLANNING
export function createPurchaseOrders(store, today) {
  const C = compute(store, today);
  const short = C.items.filter((i) => i.toOrder > 0);
  if (!short.length) throw new ActionError('Nothing to order: the open work orders are covered.');
  const noSup = short.find((i) => !i.supplier);
  if (noSup) throw new ActionError(`${noSup.name} has no supplier. Set one on Stock, then try again.`);
  const bySup = new Map();
  for (const it of short) {
    if (!bySup.has(it.supplier)) bySup.set(it.supplier, []);
    bySup.get(it.supplier).push(it);
  }
  const D = store.snapshot();
  const made = store.tx(() => {
    const nos = [];
    for (const [sup, list] of bySup) {
      const s = D.suppliers.find((x) => x.name === sup);
      const po = addOrder(store, 'Purchase Order', {
        party: sup, orderDate: today, dueDate: nextWorkday(addDays(today, n(s?.leadDays))), status: 'On order',
        fromNo: 'Planning', notes: 'Created by Planning',
      });
      for (const it of list) store.insert('orderLines', { orderId: po.id, item: it.name, qty: ceil(it.toOrder), price: it.unitCost });
      nos.push(po.orderNo);
    }
    return nos;
  });
  return { message: `${made.length} purchase order${made.length === 1 ? '' : 's'} created: ${made.join(', ')}` };
}

// ---------------------------------------------------------------- FLOOR
export function moveOperation(store, today, opId, { opStart, workCenter }) {
  const op = store.get('operations', opId);
  if (!op) throw new ActionError('That operation no longer exists.', 404);
  if (op.done) throw new ActionError('That operation is done: it stays where it is.');
  if (!isDate(opStart)) throw new ActionError('Pick a day to move it to.');
  return store.tx(() => {
    store.update('operations', op.id, { opStart: nextWorkday(opStart), ...(workCenter ? { workCenter } : {}) });
    syncWOStart(store, op.orderId);
    const wo = store.get('orders', op.orderId);
    const [y, m, d] = nextWorkday(opStart).split('-').map(Number);
    const day = new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
    return { orderId: wo?.id, message: `${wo?.orderNo || 'Operation'}: ${op.workCenter} moved to ${day}` };
  });
}
