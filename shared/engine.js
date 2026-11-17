// FactoryERP engine: everything that is worked out, never typed.
// A pure port of the workbook's ERP_Recalc / Pipeline / Planning / Board / Hours logic.
//
//   on hand  = opening + received POs + made (WOs done) - used (WOs done x BOM) - shipped (shipped invoices)
//   cost     = unit cost (bought items) or materials + routing hours x labour rate x (1 + overhead %) (made items)
//   status   = Made / Short (to order) / Expiring (perishable, within 30 days) / Low (at or under reorder) / OK
//   waiting  = open work orders in start order (work in progress first) use up what is on hand; a Planned or
//              Released one that finds a material short is "waiting for material"
//   planning = requirements of open WOs by start week, open POs by expected week;
//              to order = what the planning weeks need - on hand - every open PO
import {
  addDays, addMonths, addWorkdays, diffDays, isDate, monday, monthStart, nextWorkday, planWeek, workdayIndex,
} from './dates.js';

export const ORDER_TYPES = ['Quote', 'Invoice', 'Work Order', 'Purchase Order'];
export const STATUSES = {
  Quote: ['Open', 'Accepted', 'Lost', 'Expired', 'Cancelled'],
  Invoice: ['Ordered', 'In production', 'Part shipped', 'Unpaid', 'Part paid', 'Paid', 'Cancelled'],
  'Work Order': ['Planned', 'Released', 'In progress', 'Done', 'Cancelled'],
  'Purchase Order': ['On order', 'Part received', 'Received', 'Cancelled'],
};
/** The first status of a new order: an order still in it, with nothing posted, can be deleted */
export const FIRST_STATUS = { Quote: 'Open', Invoice: 'Ordered', 'Work Order': 'Planned', 'Purchase Order': 'On order' };
export const PREFIX = { Quote: 'Q-', Invoice: 'INV-', 'Work Order': 'WO-', 'Purchase Order': 'PO-' };
export const LOCKED_STATUSES = ['Accepted', 'Lost', 'Unpaid', 'Part paid', 'Paid', 'Received', 'Part received', 'Part shipped', 'Cancelled'];
const EPS = 1e-9;

export const n = (v) => {
  const x = typeof v === 'number' ? v : parseFloat(v);
  return Number.isFinite(x) ? x : 0;
};

/** Money to the cent, half up */
export function r2(x) {
  return x >= 0 ? Math.floor(x * 100 + 0.5000001) / 100 : -Math.floor(-x * 100 + 0.5000001) / 100;
}

export const ceil = (q) => Math.ceil(q - EPS);

/** An invoice is shipped once it is Unpaid / Part paid / Paid (Ordered / In production = an open order) */
export const isShipped = (status) => status === 'Unpaid' || status === 'Part paid' || status === 'Paid';
/** An open customer order: not shipped in full, not cancelled */
export const isOpenInvoice = (o) => o.type === 'Invoice' && !isShipped(o.status) && o.status !== 'Cancelled';
/** An open work order: not done, not cancelled */
export const isOpenWO = (o) => o.type === 'Work Order' && o.status !== 'Done' && o.status !== 'Cancelled';
/** Quantity of a line still to receive (PO) or ship (invoice) */
export const openQty = (l) => Math.max(0, n(l.qty) - n(l.delivered));

export const isLocked = (order) => order && (order.type === 'Work Order' || LOCKED_STATUSES.includes(order.status));

export function wcHours(settings, wc) {
  const w = (settings.workCenters || []).find((x) => x.name === wc);
  const h = w ? n(w.hoursPerDay) : 8;
  return h > 0 ? h : 8;
}

// ---------------------------------------------------------------- tax and totals
export function taxOn(order, settings) {
  if (!order.useTax) return String(settings.useSalesTax).toUpperCase() === 'YES';
  return String(order.useTax).toUpperCase() === 'YES';
}
export function taxRateOf(order, settings) {
  return !order.useTax ? n(settings.taxRate) : n(order.taxRate);
}
export function taxLabelOf(order, settings) {
  if (!taxOn(order, settings)) return '';
  const name = !order.useTax ? settings.salesTaxName : order.taxName;
  return `${name || 'Tax'} ${(taxRateOf(order, settings) * 100).toFixed(1)}%`;
}

export function linesOf(D, orderId) {
  return D.orderLines.filter((l) => l.orderId === orderId);
}

export function orderTotals(D, order) {
  const sub = r2(linesOf(D, order.id).reduce((s, l) => s + n(l.qty) * n(l.price), 0));
  const hasTax = order.type !== 'Work Order' && taxOn(order, D.settings);
  const tax = hasTax ? r2(sub * taxRateOf(order, D.settings)) : 0;
  const total = r2(sub + tax);
  const paid = paidSoFar(D, order);
  return { subtotal: sub, tax, taxLabel: hasTax ? taxLabelOf(order, D.settings) : '', total, paid, balance: r2(total - paid) };
}

/** Money already paid on an order: Money In rows (invoice) / Money Out rows (purchase order) with its number */
export function paidSoFar(D, order) {
  if (order.type !== 'Invoice' && order.type !== 'Purchase Order') return 0;
  const dir = order.type === 'Purchase Order' ? 'Out' : 'In';
  return r2(D.moneyEntries.filter((m) => !m.void && m.direction === dir && m.reference === order.orderNo).reduce((s, m) => s + n(m.amount), 0));
}

export function payStatus(D, order) {
  const { paid, total } = orderTotals(D, order);
  if (paid > 0.004 && paid >= total - 0.004) return 'Paid';
  if (paid > 0.004) return 'Part paid';
  return 'Unpaid';
}

// ---------------------------------------------------------------- the recalculation
export function recalc(D, today) {
  const S = D.settings;
  let nw = Math.round(n(S.planningWeeks));
  if (nw < 1 || nw > 8) nw = 8;
  const w0 = monday(today);
  const rate = n(S.labourRate);
  const ohPct = n(S.overheadPct);

  const items = D.items.map((it) => ({
    id: it.id, name: String(it.name || '').trim(), type: it.type || '', unit: it.unit || '', supplier: it.supplier || '',
    expiryDate: it.expiryDate, unitCost: n(it.unitCost), reorder: n(it.reorderPoint), onHand: 0,
    cost: 0, status: '', toOrder: 0, avail: 0, openPO: 0, matCost: 0, labourHours: 0,
    req: new Array(nw + 1).fill(0), rec: new Array(nw + 1).fill(0),
  }));
  const byName = new Map();
  const byId = new Map();
  for (const it of items) {
    if (it.name && !byName.has(it.name.toLowerCase())) byName.set(it.name.toLowerCase(), it);
    byId.set(it.id, it);
  }
  const itemByName = (nm) => byName.get(String(nm || '').trim().toLowerCase());
  // on hand = the stock ledger
  for (const m of D.stockMoves || []) {
    const it = byId.get(m.itemId);
    if (it) it.onHand += n(m.qty);
  }

  // BOM by product, materials cost per unit
  const bomOf = new Map();
  for (const b of D.bomLines) {
    const mat = itemByName(b.material);
    const prod = byId.get(b.itemId);
    if (!mat || !prod) continue;
    if (!bomOf.has(prod.id)) bomOf.set(prod.id, []);
    bomOf.get(prod.id).push({ mat, qty: n(b.qtyPerUnit) });
    prod.matCost += n(b.qtyPerUnit) * mat.unitCost;
  }
  for (const r of D.routingSteps) {
    const prod = byId.get(r.itemId);
    if (prod) prod.labourHours += n(r.hoursPerUnit);
  }
  for (const it of items) {
    it.cost = it.type === 'Finished' ? r2(r2(it.matCost) + it.labourHours * rate * (1 + ohPct)) : it.unitCost;
  }

  // An open quote past its Valid Until (Due Date) is Expired
  const expiredQuotes = [];
  const ordById = new Map();
  for (const o of D.orders) {
    let status = o.status;
    if (o.type === 'Quote' && o.status === 'Open' && isDate(o.dueDate) && o.dueDate < today) {
      status = 'Expired';
      expiredQuotes.push(o.id);
    }
    ordById.set(o.id, { ...o, status });
  }

  // Order lines: what open POs still bring in (by expected week); every order's subtotal
  const subtotal = new Map();
  for (const l of D.orderLines) {
    subtotal.set(l.orderId, (subtotal.get(l.orderId) || 0) + n(l.qty) * n(l.price));
    const o = ordById.get(l.orderId);
    const it = itemByName(l.item);
    if (!o || !it || o.type !== 'Purchase Order' || o.status === 'Received' || o.status === 'Cancelled') continue;
    const q = openQty(l);
    if (!q) continue;
    it.openPO += q;
    if (isDate(o.dueDate)) {
      const k = planWeek(o.dueDate, w0);
      if (k <= nw) it.rec[k] += q;
    }
  }
  const wos = [...ordById.values()].filter((o) => o.type === 'Work Order');

  // Waiting for material + planning requirements (work in progress takes its materials first)
  for (const it of items) it.avail = it.onHand;
  const wait = {};
  const open = wos.filter((wo) => isOpenWO(wo) && itemByName(wo.party));
  open.sort((a, b) => {
    const ka = a.status === 'In progress' ? 0 : 1;
    const kb = b.status === 'In progress' ? 0 : 1;
    if (ka !== kb) return ka - kb;
    const da = isDate(a.orderDate) ? a.orderDate : '9999-12-31';
    const db = isDate(b.orderDate) ? b.orderDate : '9999-12-31';
    if (da !== db) return da < db ? -1 : 1;
    return a.id - b.id;
  });
  for (const wo of open) {
    const prod = itemByName(wo.party);
    const q = n(wo.qty);
    const k = isDate(wo.orderDate) ? planWeek(wo.orderDate, w0) : 1;
    const bom = bomOf.get(prod.id) || [];
    const short = [];
    for (const b of bom) if (b.qty * q > b.mat.avail + EPS && !short.includes(b.mat.name)) short.push(b.mat.name);
    if (short.length && (wo.status === 'Released' || wo.status === 'Planned')) wait[wo.id] = short.join(', ');
    for (const b of bom) {
      const need = b.qty * q;
      b.mat.avail -= need;
      if (k <= nw) b.mat.req[k] += need;
    }
  }

  // To order + status
  let nShort = 0;
  let stockRaw = 0;
  let stockFG = 0;
  for (const it of items) {
    if (it.type === 'Finished') it.status = 'Made';
    else {
      let q = 0;
      for (let k = 1; k <= nw; k++) q += it.req[k];
      q = q - it.onHand - it.openPO;
      it.toOrder = q > EPS ? q : 0;
      if (it.toOrder > 0) it.status = 'Short';
      else if (it.type === 'Perishable' && isDate(it.expiryDate) && it.expiryDate <= addDays(today, 30)) it.status = 'Expiring';
      else if (it.reorder > 0 && it.onHand <= it.reorder + 1e-6) it.status = 'Low';
      else it.status = 'OK';
    }
    if (it.status === 'Short') nShort++;
    if (it.type === 'Finished') stockFG += it.onHand * it.cost;
    else stockRaw += it.onHand * it.cost;
  }

  // KPIs
  let n30 = 0;
  let nOK = 0;
  let nInProd = 0;
  const since = addDays(today, -30);
  for (const wo of wos) {
    if (wo.status === 'In progress') nInProd++;
    if (wo.status === 'Done' && isDate(wo.closedDate) && wo.closedDate > since) {
      n30++;
      if (isDate(wo.dueDate) && wo.closedDate <= wo.dueDate) nOK++;
    }
  }
  const woStat = new Map(wos.map((w) => [w.id, w.status]));
  const busy = new Set();
  for (const op of D.operations) {
    if (woStat.get(op.orderId) !== 'In progress' || op.done || !isDate(op.opStart)) continue;
    const end = addWorkdays(op.opStart, Math.max(1, Math.round(n(op.days))) - 1);
    if (op.opStart <= today && today <= end) busy.add(op.workCenter);
  }
  const m1 = monthStart(today);
  let nOpenSO = 0;
  let openVal = 0;
  let sales = 0;
  let cogs = 0;
  const salesInv = new Set();
  for (const o of ordById.values()) {
    if (o.type !== 'Invoice' || o.status === 'Cancelled') continue;
    const sb = r2(subtotal.get(o.id) || 0);
    if (!isShipped(o.status)) {
      nOpenSO++;
      openVal += sb;
    } else if (isDate(o.orderDate) && o.orderDate >= m1) {
      sales += sb;
      salesInv.add(o.id);
    }
  }
  for (const l of D.orderLines) {
    const it = itemByName(l.item);
    if (salesInv.has(l.orderId) && it) cogs += n(l.qty) * it.cost;
  }
  const nWC = (S.workCenters || []).length;
  const nWait = Object.keys(wait).length;
  const kpis = {
    onTime: n30 > 0 ? nOK / n30 : null,
    onTimeSub: `${nOK} of ${n30} work orders on time`,
    open: nOpenSO,
    openValue: openVal,
    inProd: nInProd,
    inProdSub: `${busy.size} of ${nWC} work centers busy now`,
    short: nShort,
    shortSub: `${nWait} work order${nWait === 1 ? ' waits' : 's wait'} for material`,
    stock: r2(stockRaw + stockFG),
    stockRaw,
    stockFG,
    gm: sales > 0 ? (sales - cogs) / sales : null,
    sales,
  };

  return {
    today, w0, nw, items, byId, itemByName, bomOf, wait, subtotal, expiredQuotes, kpis, ordById,
  };
}

/** Stock rows for the screens (plain JSON) */
export function stockRows(C) {
  return C.items.map((it) => ({
    id: it.id, onHand: Math.round(it.onHand * 1e4) / 1e4, cost: it.cost, status: it.status,
    value: r2(it.onHand * it.cost), avail: Math.round(it.avail * 1e4) / 1e4, toOrder: it.toOrder, openPO: it.openPO,
    matCost: r2(it.matCost), labourHours: it.labourHours,
  }));
}

// ---------------------------------------------------------------- relations between orders
/** Work orders of an invoice: From = its number, or the quote it was made from */
export function invoiceWorkOrders(D, inv) {
  return D.orders.filter((o) => o.type === 'Work Order' && o.status !== 'Cancelled' && o.fromNo && (o.fromNo === inv.orderNo || (inv.fromNo && o.fromNo === inv.fromNo)));
}

/** The invoice a work order is for: its From is the invoice number, or the quote the invoice was made from */
export function invoiceOfWO(D, wo) {
  if (!wo.fromNo) return null;
  const direct = D.orders.find((o) => o.orderNo === wo.fromNo);
  if (direct && direct.type === 'Invoice') return direct;
  return D.orders.find((o) => o.type === 'Invoice' && o.status !== 'Cancelled' && o.fromNo === wo.fromNo) || null;
}

// ---------------------------------------------------------------- PIPELINE: order to cash
export const STAGES = ['Quoted', 'Ordered', 'Materials', 'In production', 'QC & Ship', 'Invoiced', 'Paid'];

export function pipeline(D, C) {
  const T = C.today;
  const paidDays = n(D.settings.pipelinePaidDays) >= 1 ? n(D.settings.pipelinePaidDays) : 30;
  const woByFrom = new Map();
  for (const o of D.orders) {
    if (o.type !== 'Work Order' || !o.fromNo || o.status === 'Cancelled') continue;
    if (!woByFrom.has(o.fromNo)) woByFrom.set(o.fromNo, []);
    woByFrom.get(o.fromNo).push(o);
  }
  const stages = STAGES.map((name) => ({ name, count: 0, amount: 0, orders: [] }));
  const rows = [];
  for (const raw of D.orders) {
    const o = C.ordById.get(raw.id) || raw;
    const tot = r2(C.subtotal.get(o.id) || 0);
    let k = -1;
    let next = '';
    if (o.type === 'Quote') {
      if (o.status === 'Open' && !(isDate(o.dueDate) && o.dueDate < T)) {
        k = 0;
        next = 'Make the invoice';
      }
    } else if (o.type === 'Invoice' && o.status !== 'Cancelled') {
      if (!isShipped(o.status)) {
        const list = [...(woByFrom.get(o.orderNo) || []), ...(o.fromNo ? woByFrom.get(o.fromNo) || [] : [])];
        const nAll = list.length;
        const nDone = list.filter((w) => w.status === 'Done').length;
        const nGo = list.filter((w) => w.status === 'In progress').length;
        const waits = [];
        for (const w of list) {
          if (!C.wait[w.id]) continue;
          for (const m of C.wait[w.id].split(', ')) if (!waits.includes(m)) waits.push(m);
        }
        if (nAll === 0) {
          k = o.status === 'Part shipped' ? 4 : 1;
          next = o.status === 'Part shipped' ? 'Ship the rest' : `Make the work orders (from ${o.fromNo || 'New'})`;
        } else if (waits.length) {
          k = 2;
          next = `Waiting for ${waits.join(', ')}`;
          if (next.length > 40) next = `Waiting for ${waits.length} materials (${waits[0]} +${waits.length - 1})`;
        } else if (nDone === nAll) {
          k = 4;
          next = o.status === 'Part shipped' ? 'Ship the rest' : 'Ship it (status Unpaid)';
        } else if (nGo > 0 || nDone > 0) {
          k = 3;
          next = `${nDone} of ${nAll} work order${nAll === 1 ? '' : 's'} done`;
        } else {
          k = 1;
          next = 'Release the work orders';
        }
      } else if (o.status === 'Unpaid' || o.status === 'Part paid') {
        k = 5;
        next = o.status === 'Part paid' ? 'Collect the balance' : 'Collect payment';
        if (isDate(o.dueDate) && o.dueDate < T) next = 'Collect payment (overdue)';
      } else if (o.status === 'Paid' && isDate(o.paidDate) && o.paidDate >= addDays(T, -paidDays)) {
        k = 6;
      }
    }
    if (k < 0) continue;
    const st = stages[k];
    st.count++;
    st.amount += tot;
    st.orders.push({ id: o.id, orderNo: o.orderNo, party: o.party, dueDate: o.dueDate });
    if (k < 6) rows.push({ id: o.id, orderNo: o.orderNo, party: o.party, dueDate: o.dueDate, value: tot, stage: STAGES[k], next });
  }
  rows.sort((a, b) => (a.dueDate || '9999') < (b.dueDate || '9999') ? -1 : (a.dueDate || '9999') > (b.dueDate || '9999') ? 1 : 0);
  return { stages, rows, paidDays };
}

// ---------------------------------------------------------------- PLANNING (MRP)
export function planning(D, C) {
  const { nw, w0, today: T } = C;
  const weeks = Array.from({ length: nw }, (_, i) => addDays(w0, 7 * i));
  const wcs = (D.settings.workCenters || []).map((w) => w.name);
  const load = new Map(wcs.map((w) => [w, new Array(nw + 1).fill(0)]));
  const woStat = new Map();
  const pq = new Map();
  for (const wo of D.orders) {
    if (wo.type !== 'Work Order') continue;
    woStat.set(wo.id, wo.status);
    const prod = C.itemByName(wo.party);
    if (!isOpenWO(wo) || !prod || !isDate(wo.orderDate)) continue;
    const k = planWeek(wo.orderDate, w0);
    if (k > nw) continue;
    if (!pq.has(prod.id)) pq.set(prod.id, new Array(nw + 1).fill(0));
    pq.get(prod.id)[k] += n(wo.qty);
  }
  for (const op of D.operations) {
    const st = woStat.get(op.orderId);
    if (!st || st === 'Done' || st === 'Cancelled' || op.done || !load.has(op.workCenter) || !isDate(op.opStart)) continue;
    const days = Math.max(1, Math.round(n(op.days)));
    for (let i = 0; i < days; i++) {
      const d = addWorkdays(op.opStart, i);
      if (d < w0) continue;
      const k = planWeek(d, w0);
      if (k <= nw) load.get(op.workCenter)[k] += n(op.hours) / days;
    }
  }
  const capacity = (wc, k) => {
    const h = wcHours(D.settings, wc) * 5;
    return h > 0 ? load.get(wc)[k] / h : 0;
  };
  const products = [];
  for (const it of C.items) {
    if (it.type !== 'Finished' || !pq.has(it.id)) continue;
    const q = pq.get(it.id);
    const uses = [...new Set(D.routingSteps.filter((r) => r.itemId === it.id && load.has(r.workCenter)).map((r) => r.workCenter))];
    const cells = [];
    for (let k = 1; k <= nw; k++) {
      const mx = Math.max(0, ...uses.map((wc) => capacity(wc, k)));
      cells.push({ qty: q[k], load: q[k] > 0 ? (mx > 1 ? 'over' : mx > 0.9 ? 'near' : 'ok') : null });
    }
    products.push({ id: it.id, name: it.name, cells });
  }
  const workCenters = wcs.map((wc) => ({
    name: wc,
    hoursPerWeek: wcHours(D.settings, wc) * 5,
    cells: Array.from({ length: nw }, (_, i) => ({ hours: Math.round(load.get(wc)[i + 1] * 100) / 100, pct: capacity(wc, i + 1) })),
  }));
  const materials = [];
  for (const pass of [1, 2]) {
    for (const it of C.items) {
      if (it.type === 'Finished') continue;
      let tot = 0;
      for (let k = 1; k <= nw; k++) tot += it.req[k] + it.rec[k];
      if (!((pass === 1 && it.toOrder > 0) || (pass === 2 && it.toOrder === 0 && tot > 0))) continue;
      let bal = it.onHand;
      const cells = [];
      for (let k = 1; k <= nw; k++) {
        bal += it.rec[k] - it.req[k];
        cells.push(Math.round(bal * 100) / 100);
      }
      materials.push({ id: it.id, name: it.name, unit: it.unit, short: it.toOrder > 0, cells });
    }
  }
  const lead = new Map(D.suppliers.map((s) => [s.name, n(s.leadDays)]));
  const toOrder = C.items.filter((it) => it.toOrder > 0).map((it) => {
    const qty = ceil(it.toOrder);
    return {
      id: it.id, name: it.name, supplier: it.supplier, qty, unit: it.unit, unitCost: it.unitCost,
      cost: qty * it.unitCost, arrives: nextWorkday(addDays(T, lead.get(it.supplier) || 0)),
    };
  });
  return {
    weeks, products, workCenters, materials, toOrder,
    poCount: new Set(toOrder.map((t) => t.supplier)).size,
    toOrderTotal: toOrder.reduce((s, t) => s + t.cost, 0),
  };
}

// ---------------------------------------------------------------- FLOOR: production board
export const BOARD_DAYS = 10;

export function board(D, C, weekStart) {
  const w0 = monday(weekStart || C.today);
  const days = Array.from({ length: BOARD_DAYS }, (_, i) => addWorkdays(w0, i));
  const wos = new Map(D.orders.filter((o) => o.type === 'Work Order' && o.status !== 'Cancelled').map((o) => [o.id, o]));
  const lanes = (D.settings.workCenters || []).map((wc) => ({ name: wc.name, hoursPerDay: n(wc.hoursPerDay), bars: [], load: new Array(BOARD_DAYS).fill(0) }));
  const laneOf = new Map(lanes.map((l) => [l.name, l]));
  for (const op of D.operations) {
    const wo = wos.get(op.orderId);
    const lane = laneOf.get(op.workCenter);
    if (!wo || !lane || !isDate(op.opStart)) continue;
    const dur = Math.max(1, Math.round(n(op.days)));
    const s = workdayIndex(op.opStart, w0);
    const e = s + dur - 1;
    if (e < 0 || s > BOARD_DAYS - 1) continue;
    const end = addWorkdays(op.opStart, dur - 1);
    let color = 'scheduled';
    if (op.done || wo.status === 'Done') color = 'done';
    else if (C.wait[wo.id]) color = 'waiting';
    else if (wo.priority === 'Rush' || (isDate(wo.dueDate) && end > wo.dueDate)) color = 'late';
    else if (wo.status === 'In progress') color = 'ontrack';
    if (!op.done) for (let d = Math.max(0, s); d <= Math.min(BOARD_DAYS - 1, e); d++) lane.load[d] += n(op.hours) / dur;
    lane.bars.push({
      opId: op.id, woId: wo.id, woNo: wo.orderNo, product: wo.party, qty: wo.qty, status: wo.status, priority: wo.priority,
      dueDate: wo.dueDate, opStart: op.opStart, end, days: dur, hours: n(op.hours), done: !!op.done,
      waitingFor: C.wait[wo.id] || '', start: s, span: dur, color,
    });
  }
  for (const lane of lanes) {
    // stack overlapping bars in sub-rows
    lane.bars.sort((a, b) => a.start - b.start || a.woId - b.woId);
    const ends = [];
    for (const b of lane.bars) {
      let row = ends.findIndex((e) => e < b.start);
      if (row < 0) {
        row = ends.length;
        ends.push(0);
      }
      ends[row] = b.start + b.span - 1;
      b.row = row;
    }
    lane.rows = Math.max(1, ends.length);
    lane.load = lane.load.map((h) => ({ hours: Math.round(h * 100) / 100, pct: lane.hoursPerDay > 0 ? h / lane.hoursPerDay : 0 }));
  }
  return { weekStart: w0, days, lanes, today: C.today };
}

// ---------------------------------------------------------------- REPORTS
export function profitAndLoss(D, today, months = 6) {
  const cols = Array.from({ length: months }, (_, i) => addMonths(today, i - (months - 1)));
  const cats = D.settings.moneyCategories || [];
  const live = D.moneyEntries.filter((e) => !e.void);
  const sum = (dir, cat, m) => live
    .filter((e) => e.direction === dir && e.category === cat && isDate(e.entryDate) && e.entryDate >= m && e.entryDate < addMonths(m, 1))
    .reduce((s, e) => s + n(e.amount), 0);
  const known = new Set(cats.map((c) => c.name));
  const other = (dir, m) => live
    .filter((e) => e.direction === dir && !known.has(e.category) && isDate(e.entryDate) && e.entryDate >= m && e.entryDate < addMonths(m, 1))
    .reduce((s, e) => s + n(e.amount), 0);
  const section = (dir) => {
    const rows = cats.filter((c) => c.direction === dir).map((c) => ({ name: c.name, values: cols.map((m) => r2(sum(dir, c.name, m))) }));
    const unc = cols.map((m) => r2(other(dir, m)));
    if (unc.some((v) => v)) rows.push({ name: 'Uncategorised', values: unc });
    return { rows, total: cols.map((_, i) => r2(rows.reduce((s, r) => s + r.values[i], 0))) };
  };
  const moneyIn = section('In');
  const moneyOut = section('Out');
  return { months: cols, moneyIn, moneyOut, net: cols.map((_, i) => r2(moneyIn.total[i] - moneyOut.total[i])) };
}

/** Monthly hours. Overtime = hours over 40 in a Monday-Sunday week (the days inside the month).
 *  Labour cost = hours x rate + overtime x rate x 0.5. */
export function monthlyHours(D, month) {
  const m0 = monthStart(month);
  const m1 = addMonths(m0, 1);
  const hrs = new Map();
  const wk = new Map();
  for (const t of D.timeEntries) {
    if (!isDate(t.workDate) || t.workDate < m0 || t.workDate >= m1) continue;
    hrs.set(t.employeeId, (hrs.get(t.employeeId) || 0) + n(t.hours));
    const key = `${t.employeeId}|${monday(t.workDate)}`;
    wk.set(key, (wk.get(key) || 0) + n(t.hours));
  }
  const ot = new Map();
  for (const [key, h] of wk) {
    const id = Number(key.split('|')[0]);
    if (h > 40) ot.set(id, (ot.get(id) || 0) + h - 40);
  }
  const wcNames = (D.settings.workCenters || []).map((w) => w.name);
  const byWc = new Map([...wcNames, 'Office / other'].map((w) => [w, { name: w, hours: 0, overtime: 0, cost: 0 }]));
  const employees = D.employees.map((e) => {
    const h = hrs.get(e.id) || 0;
    const o = ot.get(e.id) || 0;
    const rate = n(e.hourlyRate);
    const cost = r2(h * rate + o * rate * 0.5);
    const w = byWc.get(wcNames.includes(e.workCenter) ? e.workCenter : 'Office / other');
    w.hours += h;
    w.overtime += o;
    w.cost += cost;
    return { id: e.id, name: e.name, hours: h, overtime: o, rate, cost };
  });
  return {
    month: m0,
    employees,
    workCenters: [...byWc.values()].filter((w) => w.hours > 0),
    total: {
      hours: employees.reduce((s, e) => s + e.hours, 0),
      overtime: employees.reduce((s, e) => s + e.overtime, 0),
      cost: r2(employees.reduce((s, e) => s + e.cost, 0)),
    },
  };
}

export function monthSummary(D, today) {
  const m0 = monthStart(today);
  const m1 = addMonths(m0, 1);
  const inMonth = D.moneyEntries.filter((e) => !e.void && isDate(e.entryDate) && e.entryDate >= m0 && e.entryDate < m1);
  const moneyIn = inMonth.filter((e) => e.direction === 'In').reduce((s, e) => s + n(e.amount), 0);
  const moneyOut = inMonth.filter((e) => e.direction === 'Out').reduce((s, e) => s + n(e.amount), 0);
  return { month: m0, moneyIn: r2(moneyIn), moneyOut: r2(moneyOut), net: r2(moneyIn - moneyOut), entries: inMonth.length };
}

export { diffDays };
