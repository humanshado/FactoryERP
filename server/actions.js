// One-click workflow (the NEXT STEP buttons), ported from the workbook's ERP_Actions, plus the
// stock ledger: every receipt, shipment, production, issue, adjustment and count is a stock move.
//   Quote:          Make Invoice / Make Work Orders / Cancel
//   Invoice:        Ship (all or part of each line); ships by itself when its work orders are done;
//                   Record Payment; Cancel (before anything shipped or was paid)
//   Work Order:     Schedule > Release > Start > Complete (finished goods in, materials out, hours logged); Cancel
//   Purchase Order: Receive (all or part of each line); Record Payment; Cancel (the rest)
//   Stock:          Adjust (with a reason), Count (differences posted)
// Orders are deleted only while they are drafts; after that they are cancelled, and payments are voided.
import { addDays, addWorkdays, isDate, nextWorkday, workday } from '../shared/dates.js';
import {
  FIRST_STATUS, PREFIX, STATUSES, ceil, invoiceOfWO, invoiceWorkOrders, isLocked, isShipped, n, openQty, orderTotals, payStatus, r2,
  recalc, wcHours,
} from '../shared/engine.js';
import { ActionError, currentUser } from './db.js';

export { ActionError };
/** Ask the user first: the client shows the question and repeats the call with force: true */
const confirm = (message) => new ActionError(message, 409, { confirm: true });
const money = (x) => `$${r2(x).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const qtyTxt = (x) => String(Math.round(x * 1e4) / 1e4);
const byName = (D, name) => D.items.find((i) => String(i.name).trim().toLowerCase() === String(name || '').trim().toLowerCase());

/** Recalculate, and store what the engine decided by itself (open quotes past Valid Until become Expired) */
export async function compute(store, today) {
  let C = recalc(await store.snapshot(), today);
  if (C.expiredQuotes.length) {
    await store.tx(async () => {
      for (const id of C.expiredQuotes) await store.update('orders', id, { status: 'Expired' });
    });
    C = recalc(await store.snapshot(), today);
  }
  return C;
}

async function orderOf(store, id, type, action) {
  const o = await store.get('orders', id);
  if (!o) throw new ActionError('That order no longer exists.', 404);
  if (type && o.type !== type) throw new ActionError(`${action} works on a ${type.toLowerCase()}. ${o.orderNo} is a ${o.type.toLowerCase()}.`);
  if (o.status === 'Cancelled' && action !== 'Cancel') throw new ActionError(`${o.orderNo} is cancelled.`);
  return o;
}

export async function nextNo(store, prefix, table = 'orders', field = 'orderNo') {
  let best = 0;
  let width = 4;
  for (const o of await store.all(table)) {
    const s = String(o[field] || '');
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

async function addOrder(store, type, fields) {
  const S = await store.getSettings();
  return store.insert('orders', { orderNo: await nextNo(store, PREFIX[type]), type, ...taxStamp(S), ...fields });
}

const move = (store, m) => store.insert('stockMoves', m, { audit: false });

/** A blank order of a type: next number, today, its first status */
export async function newOrder(store, today, { type = 'Quote', party = null } = {}) {
  if (!PREFIX[type]) throw new ActionError(`Unknown order type: ${type}`);
  const S = await store.getSettings();
  const due = {
    Quote: addDays(today, 30),
    Invoice: workday(today, n(S.dueDays) || 15),
    'Work Order': workday(today, n(S.dueDays) || 15),
    'Purchase Order': nextWorkday(addDays(today, 7)),
  }[type];
  const o = await store.tx(() => addOrder(store, type, {
    party, orderDate: type === 'Work Order' ? addWorkdays(today, 1) : today, dueDate: due, status: FIRST_STATUS[type],
    priority: type === 'Work Order' ? 'Normal' : null,
  }));
  return { order: o, orderId: o.id, message: `${o.orderNo} created` };
}

/** Operations from the product's routing, one after another from start. Returns how many. */
export async function makeOps(store, woId, itemName, qty, start) {
  return store.tx(async () => {
    const D = await store.snapshot();
    const prod = byName(D, itemName);
    if (!prod) return 0;
    let s = nextWorkday(start);
    let made = 0;
    for (const r of D.routingSteps.filter((x) => x.itemId === prod.id)) {
      const h = Math.round(n(r.hoursPerUnit) * qty * 100) / 100;
      const dur = Math.max(1, Math.ceil(h / wcHours(D.settings, r.workCenter) - 1e-6));
      await store.insert('operations', { orderId: woId, workCenter: r.workCenter, opStart: s, days: dur, hours: h, done: false });
      s = addWorkdays(s, dur);
      made++;
    }
    return made;
  });
}

/** A work order starts when its first operation starts */
export async function syncWOStart(store, woId) {
  const ops = (await store.all('operations')).filter((o) => o.orderId === woId && isDate(o.opStart));
  if (!ops.length) return;
  const first = ops.map((o) => o.opStart).sort()[0];
  await store.update('orders', woId, { orderDate: first });
}

// ---------------------------------------------------------------- SHIPPING (invoices)
/** Wanted quantities per line: [{ lineId, qty }] -> Map, or every open quantity when none are given */
function wantedOf(lines, wanted) {
  const out = new Map();
  if (Array.isArray(wanted) && wanted.length) {
    for (const w of wanted) if (n(w.qty) > 0) out.set(Number(w.lineId), n(w.qty));
  } else {
    for (const l of lines) if (openQty(l) > 0) out.set(l.id, openQty(l));
  }
  return out;
}

/** Shipped in full: dated today, payment due in 30 days, its status from the payments */
async function finishInvoice(store, today, inv) {
  await store.update('orders', inv.id, { orderDate: today, closedDate: today, dueDate: addDays(today, 30) });
  const D = await store.snapshot();
  const cur = D.orders.find((o) => o.id === inv.id);
  const st = payStatus(D, cur);
  await store.update('orders', inv.id, { status: st, ...(st === 'Paid' && !isDate(cur.paidDate) ? { paidDate: today } : {}) });
  return st;
}

async function shipLines(store, today, inv, wanted, { force, date } = {}) {
  return store.tx(async () => {
    const now = await store.get('orders', inv.id);
    if (isShipped(now.status) || now.status === 'Cancelled') throw new ActionError(`${inv.orderNo} is ${now.status.toLowerCase()}.`);
    const C = await compute(store, today);
    const D = await store.snapshot();
    const lines = D.orderLines.filter((l) => l.orderId === inv.id);
    const want = wantedOf(lines, wanted);
    if (!want.size) throw new ActionError(`Nothing left to ship on ${inv.orderNo}.`);
    const short = [];
    for (const l of lines) {
      const q = want.get(l.id);
      if (!q) continue;
      if (q > openQty(l) + 1e-9) throw new ActionError(`${l.item}: ${qtyTxt(q)} is more than the ${qtyTxt(openQty(l))} left to ship.`);
      const it = byName(D, l.item);
      const has = it ? C.byId.get(it.id).onHand : 0;
      if (it && has + 1e-9 < q) short.push(`${l.item} (${qtyTxt(has)} on hand)`);
    }
    if (short.length && !force) throw confirm(`Not enough stock to ship: ${short.join(', ')}. Ship anyway (stock goes below zero)?`);
    const d = isDate(date) ? date : today;
    for (const l of lines) {
      const q = want.get(l.id);
      if (!q) continue;
      const it = byName(D, l.item);
      if (it) await move(store, { moveDate: d, itemId: it.id, qty: -q, type: 'shipment', unitCost: C.byId.get(it.id).cost, orderId: inv.id, lineId: l.id, refNo: inv.orderNo });
      await store.update('orderLines', l.id, { delivered: n(l.delivered) + q }, { audit: false });
    }
    const after = (await store.snapshot()).orderLines.filter((l) => l.orderId === inv.id);
    if (after.every((l) => openQty(l) <= 1e-9)) {
      const st = await finishInvoice(store, today, inv);
      return `${inv.orderNo} shipped: ${st}`;
    }
    await store.update('orders', inv.id, { status: 'Part shipped' });
    return `${inv.orderNo}: part shipped (${after.filter((l) => openQty(l) > 1e-9).length} line(s) still to ship)`;
  });
}

export async function invoiceShip(store, today, id, { lines, date, force } = {}) {
  const inv = await orderOf(store, id, 'Invoice', 'Ship');
  if (isShipped(inv.status)) throw new ActionError(`${inv.orderNo} has shipped already (${inv.status}).`);
  const message = await shipLines(store, today, inv, lines, { force, date });
  return { orderId: inv.id, message };
}

/** A work order moved on: its invoice follows (In production; shipped when they are all done) */
async function invoiceFollowWO(store, today, wo) {
  const D = await store.snapshot();
  const inv = invoiceOfWO(D, wo);
  if (!inv || isShipped(inv.status) || inv.status === 'Cancelled') return null;
  const wos = invoiceWorkOrders(D, inv);
  if (wos.length && wos.every((w) => w.status === 'Done')) return shipLines(store, today, inv, null, { force: true });
  if (wos.some((w) => w.status !== 'Planned') && inv.status === 'Ordered') await store.update('orders', inv.id, { status: 'In production' });
  return null;
}

// ---------------------------------------------------------------- RECEIVING (purchase orders)
export async function poReceive(store, today, id, { lines, date, force } = {}) {
  const po = await orderOf(store, id, 'Purchase Order', 'Receive');
  if (po.status === 'Received') throw new ActionError(`${po.orderNo} was received in full on ${po.closedDate}.`);
  return store.tx(async () => {
    const now = await store.get('orders', po.id);
    if (now.status === 'Received' || now.status === 'Cancelled') throw new ActionError(`${po.orderNo} is ${now.status.toLowerCase()}.`);
    const D = await store.snapshot();
    const own = D.orderLines.filter((l) => l.orderId === po.id);
    const want = wantedOf(own, lines);
    if (!want.size) throw new ActionError(`Nothing left to receive on ${po.orderNo}.`);
    const over = own.filter((l) => want.get(l.id) > openQty(l) + 1e-9);
    if (over.length && !force) {
      throw confirm(`More than ordered: ${over.map((l) => `${l.item} (${qtyTxt(openQty(l))} left)`).join(', ')}. Receive it anyway?`);
    }
    const d = isDate(date) ? date : today;
    for (const l of own) {
      const q = want.get(l.id);
      if (!q) continue;
      const it = byName(D, l.item);
      if (it) await move(store, { moveDate: d, itemId: it.id, qty: q, type: 'receipt', unitCost: n(l.price), orderId: po.id, lineId: l.id, refNo: po.orderNo });
      await store.update('orderLines', l.id, { delivered: n(l.delivered) + q }, { audit: false });
    }
    const after = (await store.snapshot()).orderLines.filter((l) => l.orderId === po.id);
    const full = after.every((l) => openQty(l) <= 1e-9);
    await store.update('orders', po.id, full ? { status: 'Received', closedDate: d } : { status: 'Part received' });
    return { orderId: po.id, message: full ? `${po.orderNo} received: stock updated` : `${po.orderNo}: part received (${after.filter((l) => openQty(l) > 1e-9).length} line(s) still due)` };
  });
}

// ---------------------------------------------------------------- SAVE, CANCEL, DELETE
/** Save the order's fields. A status change goes through the step it stands for (ship, receive, complete, cancel). */
export async function saveOrder(store, today, id, patch, { force } = {}) {
  const before = await orderOf(store, id, null, 'Cancel');
  const p = { ...patch };
  const rev = p.rev;
  const target = p.status;
  for (const k of ['id', 'type', 'status', 'rev', 'createdAt', 'updatedAt', 'createdBy', 'updatedBy', 'closedDate', 'paidDate']) delete p[k];
  if ('orderNo' in p && !String(p.orderNo || '').trim()) throw new ActionError('Please enter an Order # before saving.');
  if ('party' in p && !String(p.party || '').trim()) {
    throw new ActionError(`Pick the ${before.type === 'Purchase Order' ? 'supplier' : before.type === 'Work Order' ? 'product' : 'customer'} first.`);
  }
  if ('orderDate' in p && !isDate(p.orderDate)) throw new ActionError('Please enter a date before saving.');
  if (target && !STATUSES[before.type].includes(target)) throw new ActionError(`A ${before.type.toLowerCase()} cannot be ${target}.`);
  if (before.status === 'Cancelled' && Object.keys(p).some((k) => !['notes'].includes(k) && p[k] !== before[k])) {
    throw new ActionError(`${before.orderNo} is cancelled: only its notes can change.`);
  }
  if (p.orderNo && p.orderNo !== before.orderNo && (await store.all('orders')).some((o) => o.orderNo === p.orderNo)) {
    throw new ActionError(`Order # ${p.orderNo} is already used.`);
  }
  return store.tx(async () => {
    if (p.orderNo && p.orderNo !== before.orderNo) {
      // keep the links: payments, child orders, logged hours and stock moves point at the number
      await store.rename('orders', 'fromNo', before.orderNo, p.orderNo);
      await store.rename('moneyEntries', 'reference', before.orderNo, p.orderNo);
      await store.rename('timeEntries', 'woNo', before.orderNo, p.orderNo);
      await store.rename('stockMoves', 'refNo', before.orderNo, p.orderNo);
    }
    let o = await store.update('orders', id, p, { rev });
    const msgs = [`${o.orderNo} saved`];
    if (o.type === 'Work Order' && 'qty' in p && n(p.qty) !== n(before.qty) && !['Done', 'Cancelled'].includes(o.status)) {
      // the operations follow the new quantity (hours and days from the routing)
      const start = o.orderDate || addWorkdays(today, 1);
      await store.removeWhere('operations', 'orderId', o.id);
      if (n(o.qty) > 0) await makeOps(store, o.id, o.party, n(o.qty), start);
      msgs.push('operations re-planned');
    }
    if (target && target !== before.status) msgs.push(await changeStatus(store, today, o, target, { force }));
    o = await store.get('orders', id);
    return { order: o, orderId: o.id, message: msgs.join(': ') };
  });
}

async function changeStatus(store, today, o, target, { force } = {}) {
  if (target === 'Cancelled') return (await cancelOrder(store, today, o.id, {})).message;
  const lines = (await store.all('orderLines')).filter((l) => l.orderId === o.id);
  const anyDelivered = lines.some((l) => n(l.delivered) > 0);
  const set = async (status, extra = {}) => {
    await store.update('orders', o.id, { status, ...extra });
    return `status ${status}`;
  };
  switch (o.type) {
    case 'Quote':
      return set(target);
    case 'Invoice':
      if (isShipped(target)) {
        if (isShipped(o.status)) throw new ActionError("An invoice's status follows its payments: record a payment, or void one on the Ledger.");
        return shipLines(store, today, o, null, { force });
      }
      if (target === 'Part shipped') throw new ActionError('Part shipped follows the shipments: use Ship.');
      if (anyDelivered || isShipped(o.status)) throw new ActionError(`${o.orderNo} has shipped goods: it cannot go back to ${target}.`);
      return set(target);
    case 'Work Order':
      if (o.status === 'Done') throw new ActionError(`${o.orderNo} is done and its stock is posted: it stays done (use a stock adjustment to correct).`);
      if (target === 'Done') return (await woComplete(store, today, o.id, { force })).message;
      await set(target);
      await invoiceFollowWO(store, today, await store.get('orders', o.id));
      return `status ${target}`;
    case 'Purchase Order':
      if (target === 'Received') return (await poReceive(store, today, o.id, { force })).message;
      if (target === 'Part received') throw new ActionError('Part received follows the receipts: use Receive.');
      if (anyDelivered) throw new ActionError(`${o.orderNo} has received goods: it cannot go back to ${target}.`);
      return set(target);
    default:
      return set(target);
  }
}

/** Cancel: the order stays on file, marked Cancelled, with who and why in its notes */
export async function cancelOrder(store, today, id, { reason } = {}) {
  const o = await orderOf(store, id, null, 'Cancel');
  if (o.status === 'Cancelled') throw new ActionError(`${o.orderNo} is cancelled already.`);
  return store.tx(async () => {
    if ((await store.get('orders', o.id)).status === 'Cancelled') throw new ActionError(`${o.orderNo} is cancelled already.`);
    const D = await store.snapshot();
    const lines = D.orderLines.filter((l) => l.orderId === o.id);
    const extra = [];
    if (o.type === 'Invoice') {
      if (lines.some((l) => n(l.delivered) > 0)) throw new ActionError(`${o.orderNo} has shipped goods, so it cannot be cancelled.`);
      if (orderTotals(D, o).paid > 0) throw new ActionError(`${o.orderNo} has payments. Void them on the Ledger first, then cancel.`);
      for (const w of invoiceWorkOrders(D, o).filter((x) => x.status === 'Planned' || x.status === 'Released')) {
        await store.update('orders', w.id, { status: 'Cancelled', notes: [w.notes, `Cancelled with ${o.orderNo}`].filter(Boolean).join('\n') });
        extra.push(w.orderNo);
      }
    }
    if (o.type === 'Work Order' && o.status === 'Done') throw new ActionError(`${o.orderNo} is done and its stock is posted, so it cannot be cancelled.`);
    if (o.type === 'Purchase Order' && o.status === 'Received') throw new ActionError(`${o.orderNo} was received in full, so it cannot be cancelled.`);
    const u = currentUser();
    const note = `Cancelled ${today}${u ? ` by ${u.name || u.username}` : ''}${reason ? `: ${reason}` : ''}`;
    await store.update('orders', o.id, { status: 'Cancelled', closedDate: today, notes: [o.notes, note].filter(Boolean).join('\n') });
    const part = o.type === 'Purchase Order' && o.status === 'Part received' ? ' (what was received stays in stock; the rest is cancelled)' : '';
    return { orderId: o.id, message: `${o.orderNo} cancelled${part}${extra.length ? `, with ${extra.join(', ')}` : ''}` };
  });
}

/** Delete: only a draft (first status, nothing posted, nothing made from it) */
export async function deleteOrder(store, today, id) {
  const o = await store.get('orders', id);
  if (!o) throw new ActionError('That order no longer exists.', 404);
  const D = await store.snapshot();
  const why = [];
  if (o.status !== FIRST_STATUS[o.type]) why.push(`it is ${o.status.toLowerCase()}`);
  if (D.stockMoves.some((m) => m.orderId === o.id)) why.push('it moved stock');
  if (D.moneyEntries.some((m) => m.reference === o.orderNo)) why.push('it has payments');
  if (D.orders.some((x) => x.fromNo === o.orderNo)) why.push('other orders were made from it');
  if (D.timeEntries.some((t) => t.woNo === o.orderNo)) why.push('it has logged hours');
  if (why.length) throw new ActionError(`${o.orderNo} cannot be deleted: ${why.join(', ')}. Cancel it instead.`);
  await store.tx(async () => {
    await store.removeWhere('orderLines', 'orderId', o.id);
    await store.removeWhere('operations', 'orderId', o.id);
    await store.remove('orders', o.id);
  });
  return { message: `${o.orderNo} deleted` };
}

export async function assertLinesEditable(store, orderId) {
  const o = await orderOf(store, orderId, null, 'Edit');
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

export async function quoteMakeInvoice(store, today, id) {
  const q = await orderOf(store, id, 'Quote', 'Make Invoice');
  quoteUsable(q, 'Make Invoice');
  const D = await store.snapshot();
  const existing = D.orders.find((o) => o.type === 'Invoice' && o.fromNo === q.orderNo && o.status !== 'Cancelled');
  if (existing) return { orderId: existing.id, message: `${q.orderNo} already has invoice ${existing.orderNo}` };
  const lines = D.orderLines.filter((l) => l.orderId === q.id);
  if (!lines.length) throw new ActionError("Add the quote's lines first.");
  return store.tx(async () => {
    const S = await store.getSettings();
    const inv = await addOrder(store, 'Invoice', {
      party: q.party, fromNo: q.orderNo, orderDate: today, dueDate: workday(today, n(S.dueDays) || 15), status: 'Ordered',
    });
    for (const l of lines) await store.insert('orderLines', { orderId: inv.id, item: l.item, description: l.description, qty: l.qty, price: l.price });
    await store.update('orders', q.id, { status: 'Accepted' });
    const wos = invoiceWorkOrders(await store.snapshot(), inv);
    if (wos.length && wos.every((w) => w.status === 'Done')) await shipLines(store, today, inv, null, { force: true });
    else if (wos.some((w) => w.status !== 'Planned')) await store.update('orders', inv.id, { status: 'In production' });
    return { orderId: inv.id, message: `Invoice ${inv.orderNo} made from ${q.orderNo}` };
  });
}

/** Make Work Orders: one per made product on the quote (or on an invoice made without a quote) */
export async function makeWorkOrders(store, today, id) {
  const src = await orderOf(store, id, null, 'Make Work Orders');
  if (src.type !== 'Quote' && src.type !== 'Invoice') throw new ActionError('Make Work Orders works on a quote or an invoice.');
  if (src.type === 'Quote') quoteUsable(src, 'Make Work Orders');
  if (src.type === 'Invoice' && isShipped(src.status)) throw new ActionError(`${src.orderNo} has shipped already.`);
  const D = await store.snapshot();
  const fromNo = src.type === 'Invoice' && src.fromNo ? src.fromNo : src.orderNo;
  if (D.orders.some((o) => o.type === 'Work Order' && o.status !== 'Cancelled' && (o.fromNo === src.orderNo || o.fromNo === fromNo))) {
    throw new ActionError(`${src.orderNo} already has work orders. See them under Work Orders or on the Floor.`);
  }
  const S = D.settings;
  let due = workday(today, n(S.dueDays) || 15);
  const inv = src.type === 'Invoice' ? src : D.orders.find((o) => o.type === 'Invoice' && o.status !== 'Cancelled' && o.fromNo === src.orderNo);
  if (inv && !isShipped(inv.status) && isDate(inv.dueDate)) due = inv.dueDate;
  const start = addWorkdays(today, 1);
  const made = await store.tx(async () => {
    const ids = [];
    for (const l of D.orderLines.filter((x) => x.orderId === src.id)) {
      const it = byName(D, l.item);
      if (!it || it.type !== 'Finished') continue;
      const qty = src.type === 'Invoice' ? openQty(l) : n(l.qty);
      if (qty <= 0) continue;
      const wo = await addOrder(store, 'Work Order', { party: it.name, fromNo, orderDate: start, dueDate: due, status: 'Planned', qty, priority: 'Normal' });
      await makeOps(store, wo.id, it.name, qty, start);
      ids.push(wo.id);
    }
    if (ids.length && src.type === 'Quote' && src.status === 'Open') await store.update('orders', src.id, { status: 'Accepted' });
    return ids;
  });
  if (!made.length) throw new ActionError('This order has no lines for products you make (Item Type Finished).');
  return { orderId: made[0], message: `${src.orderNo}: ${made.length} work order${made.length === 1 ? '' : 's'} made` };
}

// ---------------------------------------------------------------- WORK ORDERS
export async function woSchedule(store, today, id) {
  const wo = await orderOf(store, id, 'Work Order', 'Schedule');
  const has = (await store.all('operations')).some((o) => o.orderId === wo.id);
  if (!has) {
    const start = isDate(wo.orderDate) ? wo.orderDate : addWorkdays(today, 1);
    const made = await makeOps(store, wo.id, wo.party, n(wo.qty), start);
    if (!made) throw new ActionError('This product has no routing yet (Stock > Routing): add its work centers and hours per unit first.');
    await store.update('orders', wo.id, { orderDate: nextWorkday(start) });
  }
  const w = await store.get('orders', wo.id);
  return { orderId: wo.id, boardWeek: w.orderDate, message: has ? `${wo.orderNo} is on the Floor` : `${wo.orderNo} scheduled` };
}

export async function woRelease(store, today, id) {
  const wo = await orderOf(store, id, 'Work Order', 'Release');
  if (wo.status !== 'Planned') throw new ActionError(`Only a Planned work order can be released (this one is ${wo.status}).`);
  await store.tx(async () => {
    if ((await store.get('orders', wo.id)).status !== 'Planned') throw new ActionError(`${wo.orderNo} was released already.`);
    await store.update('orders', wo.id, { status: 'Released' });
    await invoiceFollowWO(store, today, await store.get('orders', wo.id));
  });
  const C = await compute(store, today);
  if (C.wait[wo.id]) {
    return {
      orderId: wo.id, warning: true,
      message: `${wo.orderNo} released, but it is waiting for material: ${C.wait[wo.id]}. Planning > Create Purchase Orders orders what is missing.`,
    };
  }
  return { orderId: wo.id, message: `${wo.orderNo} released: materials OK` };
}

export async function woStart(store, today, id, { force } = {}) {
  const wo = await orderOf(store, id, 'Work Order', 'Start');
  if (wo.status === 'In progress' || wo.status === 'Done') throw new ActionError(`This work order is already ${wo.status.toLowerCase()}.`);
  const C = await compute(store, today);
  if (C.wait[wo.id] && !force) throw confirm(`It is waiting for ${C.wait[wo.id]}. Start anyway?`);
  await store.tx(async () => {
    const now = await store.get('orders', wo.id);
    if (now.status === 'In progress' || now.status === 'Done' || now.status === 'Cancelled') throw new ActionError(`${wo.orderNo} is already ${now.status.toLowerCase()}.`);
    await store.update('orders', wo.id, { status: 'In progress' });
    await invoiceFollowWO(store, today, await store.get('orders', wo.id));
  });
  return { orderId: wo.id, message: `${wo.orderNo} started` };
}

/** Complete: done today, finished goods in, materials out (stock moves), operations done, hours logged */
export async function woComplete(store, today, id, { force } = {}) {
  const wo = await orderOf(store, id, 'Work Order', 'Complete');
  if (wo.status === 'Done') throw new ActionError(`${wo.orderNo} is already done.`);
  const C = await compute(store, today);
  if (C.wait[wo.id] && !force) {
    throw confirm(`There is not enough ${C.wait[wo.id]} on hand for ${wo.orderNo}. Complete anyway (stock goes below zero)?`);
  }
  return store.tx(async () => {
    const now = await store.get('orders', wo.id); // checked again inside the lock: two clicks complete it once
    if (now.status === 'Done' || now.status === 'Cancelled') throw new ActionError(`${wo.orderNo} is already ${now.status.toLowerCase()}.`);
    const D = await store.snapshot();
    const prod = byName(D, wo.party);
    const q = n(wo.qty);
    if (prod) {
      await move(store, { moveDate: today, itemId: prod.id, qty: q, type: 'production', unitCost: C.byId.get(prod.id).cost, orderId: wo.id, refNo: wo.orderNo });
      for (const b of C.bomOf.get(prod.id) || []) {
        await move(store, { moveDate: today, itemId: b.mat.id, qty: -b.qty * q, type: 'issue', unitCost: b.mat.cost, orderId: wo.id, refNo: wo.orderNo });
      }
    }
    await store.update('orders', wo.id, { status: 'Done', closedDate: today });
    const logged = new Set(D.timeEntries.filter((t) => t.woNo === wo.orderNo).map((t) => t.employeeId));
    let k = 0;
    for (const op of D.operations.filter((o) => o.orderId === wo.id)) {
      await store.update('operations', op.id, { done: true }, { audit: false });
      const people = D.employees.filter((e) => !e.archived && e.workCenter === op.workCenter && !logged.has(e.id));
      for (const e of people) {
        await store.insert('timeEntries', {
          employeeId: e.id, workDate: today, woNo: wo.orderNo, hours: Math.round((n(op.hours) / people.length) * 100) / 100, notes: 'Logged by Complete',
        });
        k++;
      }
    }
    const shipped = await invoiceFollowWO(store, today, await store.get('orders', wo.id));
    return { orderId: wo.id, message: `${wo.orderNo} done: ${q} made${k ? ', hours logged' : ''}${shipped ? `, ${shipped}` : ''}` };
  });
}

// ---------------------------------------------------------------- MONEY
/** Record Payment: a Money In (invoice) / Money Out (purchase order) row with the order number */
export async function recordPayment(store, today, id, { amount, date, method, force } = {}) {
  const o = await orderOf(store, id, null, 'Record Payment');
  if (o.type !== 'Invoice' && o.type !== 'Purchase Order') throw new ActionError('Record Payment works on an invoice or a purchase order.');
  const amt = r2(n(amount));
  if (amt <= 0) throw new ActionError(`Type the amount ${o.type === 'Invoice' ? 'received' : 'paid'}, then Record Payment.`);
  const d = isDate(date) ? date : today;
  const { balance } = orderTotals(await store.snapshot(), o);
  if (amt > balance + 0.004 && !force) throw confirm(`That is more than the balance (${money(balance)}). Record it anyway?`);
  return store.tx(async () => {
    await store.insert('moneyEntries', {
      entryDate: d, direction: o.type === 'Invoice' ? 'In' : 'Out', category: o.type === 'Invoice' ? 'Customer payment' : 'Supplier payment',
      party: o.party, reference: o.orderNo, amount: amt, method: method || 'Bank transfer',
    });
    const D = await store.snapshot();
    const after = orderTotals(D, o);
    let note;
    if (o.type === 'Invoice') {
      if (isShipped(o.status)) {
        const st = payStatus(D, o);
        await store.update('orders', o.id, { status: st, ...(st === 'Paid' ? { paidDate: d } : {}) });
        note = st === 'Paid' ? ' (paid in full)' : ` (balance ${money(after.balance)})`;
      } else note = ' (a deposit: it ships later)';
    } else if (after.balance <= 0.004) {
      await store.update('orders', o.id, { paidDate: d });
      note = ' (paid in full)';
    } else note = ` (balance ${money(after.balance)})`;
    return { orderId: o.id, message: `Payment recorded: ${money(amt)}${note}` };
  });
}

/** After a payment changed (edited, voided): the order it pays follows */
export async function refreshPayStatus(store, reference) {
  if (!reference) return;
  const D = await store.snapshot();
  const o = D.orders.find((x) => x.orderNo === reference && (x.type === 'Invoice' || x.type === 'Purchase Order'));
  if (!o) return;
  const t = orderTotals(D, o);
  if (o.type === 'Invoice' && isShipped(o.status)) {
    const st = payStatus(D, o);
    if (st !== o.status || (st !== 'Paid' && o.paidDate)) await store.update('orders', o.id, { status: st, paidDate: st === 'Paid' ? o.paidDate : null });
  } else if (o.type === 'Purchase Order' && t.balance > 0.004 && o.paidDate) {
    await store.update('orders', o.id, { paidDate: null });
  }
}

/** Void: the entry stays on the Ledger, struck out, out of every total */
export async function voidMoney(store, today, id, { reason } = {}) {
  const m = await store.get('moneyEntries', id);
  if (!m) throw new ActionError('That entry no longer exists.', 404);
  if (m.void) throw new ActionError('That entry is void already.');
  if (!String(reason || '').trim()) throw new ActionError('Say why it is void (the reason stays with the entry).');
  return store.tx(async () => {
    await store.update('moneyEntries', id, { void: true, voidReason: `${String(reason).trim()} (${today})` });
    await refreshPayStatus(store, m.reference);
    return { message: `Entry voided: ${money(m.amount)}${m.reference ? ` (${m.reference})` : ''}` };
  });
}

// ---------------------------------------------------------------- STOCK
export async function stockAdjust(store, today, { itemId, qty, date, reason, note } = {}) {
  const C = await compute(store, today);
  const it = C.byId.get(Number(itemId));
  if (!it) throw new ActionError('Pick an item.');
  const q = n(qty);
  if (!q) throw new ActionError('Type the quantity to add (+) or take away (−).');
  if (!String(reason || '').trim()) throw new ActionError('Pick a reason for the adjustment.');
  return store.tx(async () => {
    await move(store, { moveDate: isDate(date) ? date : today, itemId: it.id, qty: q, type: 'adjustment', unitCost: it.cost, note: [reason, note].filter(Boolean).join(': ') });
    await store.audit({ action: 'adjust', table: 'items', recordId: it.id, summary: `${it.name}: stock ${q > 0 ? '+' : ''}${qtyTxt(q)} (${reason})`, changes: { onHand: [it.onHand, it.onHand + q] } });
    return { message: `${it.name}: ${q > 0 ? '+' : ''}${qtyTxt(q)} ${it.unit} · on hand now ${qtyTxt(it.onHand + q)}` };
  });
}

/** A stock count: what was counted against what the system says; each difference is posted */
export async function stockCount(store, today, { date, note, lines } = {}) {
  const C = await compute(store, today);
  const rows = (lines || []).filter((l) => l.counted !== null && l.counted !== undefined && l.counted !== '');
  if (!rows.length) throw new ActionError('Type at least one counted quantity.');
  return store.tx(async () => {
    const countNo = await nextNo(store, 'CNT-', 'stockCounts', 'countNo');
    const d = isDate(date) ? date : today;
    const out = [];
    for (const l of rows) {
      const it = C.byId.get(Number(l.itemId));
      if (!it) continue;
      const expected = Math.round(it.onHand * 1e4) / 1e4;
      const counted = n(l.counted);
      out.push({ itemId: it.id, item: it.name, unit: it.unit, expected, counted, diff: Math.round((counted - expected) * 1e4) / 1e4, unitCost: it.cost });
    }
    const rec = await store.insert('stockCounts', { countNo, countDate: d, note, lines: out });
    let k = 0;
    for (const l of out) {
      if (Math.abs(l.diff) < 1e-9) continue;
      await move(store, { moveDate: d, itemId: l.itemId, qty: l.diff, type: 'count', unitCost: l.unitCost, countId: rec.id, refNo: countNo, note: note || null });
      k++;
    }
    const value = out.reduce((s, l) => s + l.diff * l.unitCost, 0);
    return { countId: rec.id, message: `${countNo} posted: ${out.length} counted, ${k} adjusted (${value >= 0 ? '+' : '−'}${money(Math.abs(value))})` };
  });
}

// ---------------------------------------------------------------- PLANNING
export async function createPurchaseOrders(store, today) {
  const C = await compute(store, today);
  const short = C.items.filter((i) => i.toOrder > 0);
  if (!short.length) throw new ActionError('Nothing to order: the open work orders are covered.');
  const noSup = short.find((i) => !i.supplier);
  if (noSup) throw new ActionError(`${noSup.name} has no supplier. Set one on Stock, then try again.`);
  const bySup = new Map();
  for (const it of short) {
    if (!bySup.has(it.supplier)) bySup.set(it.supplier, []);
    bySup.get(it.supplier).push(it);
  }
  const D = await store.snapshot();
  const made = await store.tx(async () => {
    const nos = [];
    for (const [sup, list] of bySup) {
      const s = D.suppliers.find((x) => x.name === sup);
      const po = await addOrder(store, 'Purchase Order', {
        party: sup, orderDate: today, dueDate: nextWorkday(addDays(today, n(s?.leadDays))), status: 'On order',
        fromNo: 'Planning', notes: 'Created by Planning',
      });
      for (const it of list) await store.insert('orderLines', { orderId: po.id, item: it.name, qty: ceil(it.toOrder), price: it.unitCost });
      nos.push(po.orderNo);
    }
    return nos;
  });
  return { message: `${made.length} purchase order${made.length === 1 ? '' : 's'} created: ${made.join(', ')}` };
}

// ---------------------------------------------------------------- FLOOR
export async function moveOperation(store, today, opId, { opStart, workCenter } = {}) {
  const op = await store.get('operations', opId);
  if (!op) throw new ActionError('That operation no longer exists.', 404);
  if (op.done) throw new ActionError('That operation is done: it stays where it is.');
  if (!isDate(opStart)) throw new ActionError('Pick a day to move it to.');
  return store.tx(async () => {
    await store.update('operations', op.id, { opStart: nextWorkday(opStart), ...(workCenter ? { workCenter } : {}) });
    await syncWOStart(store, op.orderId);
    const wo = await store.get('orders', op.orderId);
    const [y, m, d] = nextWorkday(opStart).split('-').map(Number);
    const day = new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
    return { orderId: wo?.id, message: `${wo?.orderNo || 'Operation'}: ${op.workCenter} moved to ${day}` };
  });
}
