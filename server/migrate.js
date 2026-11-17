// Data upgrades that run on start (and after loading a sample or a backup).
import { addDays, isDate } from '../shared/dates.js';
import { isShipped, n, recalc } from '../shared/engine.js';

/**
 * The stock ledger from the order history, for data made before FactoryERP kept one:
 * opening stock, received purchase orders, done work orders (made in, materials out) and
 * shipped invoices, each on its own date. The result is the on hand the history gives.
 */
export async function backfillStockMoves(store) {
  const D = await store.snapshot();
  if (D.stockMoves.length || !D.items.length) return 0;
  return store.tx(async () => {
    const byName = new Map(D.items.map((i) => [String(i.name || '').trim().toLowerCase(), i]));
    const item = (nm) => byName.get(String(nm || '').trim().toLowerCase());
    const dates = D.orders.map((o) => o.orderDate).filter(isDate).sort();
    const first = dates.length ? addDays(dates[0], -1) : (D.settings.sampleAnchor || new Date().toISOString().slice(0, 10));
    const C = recalc({ ...D, stockMoves: [] }, first); // costs of made items
    const cost = (it) => C.byId.get(it.id)?.cost ?? n(it.unitCost);
    const moves = [];
    for (const it of D.items) {
      if (n(it.openingStock)) moves.push({ moveDate: first, itemId: it.id, qty: n(it.openingStock), type: 'opening', unitCost: cost(it), note: 'Opening stock' });
    }
    const lines = new Map();
    for (const l of D.orderLines) {
      if (!lines.has(l.orderId)) lines.set(l.orderId, []);
      lines.get(l.orderId).push(l);
    }
    const bom = new Map();
    for (const b of D.bomLines) {
      if (!bom.has(b.itemId)) bom.set(b.itemId, []);
      bom.get(b.itemId).push(b);
    }
    const delivered = [];
    for (const o of D.orders) {
      const day = o.closedDate || o.dueDate || o.orderDate || first;
      if (o.type === 'Purchase Order' && o.status === 'Received') {
        for (const l of lines.get(o.id) || []) {
          const it = item(l.item);
          if (!it) continue;
          moves.push({ moveDate: day, itemId: it.id, qty: n(l.qty), type: 'receipt', unitCost: n(l.price), orderId: o.id, lineId: l.id, refNo: o.orderNo });
          delivered.push([l.id, n(l.qty)]);
        }
      } else if (o.type === 'Invoice' && isShipped(o.status)) {
        for (const l of lines.get(o.id) || []) {
          const it = item(l.item);
          if (!it) continue;
          moves.push({ moveDate: o.closedDate || o.orderDate || first, itemId: it.id, qty: -n(l.qty), type: 'shipment', unitCost: cost(it), orderId: o.id, lineId: l.id, refNo: o.orderNo });
          delivered.push([l.id, n(l.qty)]);
        }
      } else if (o.type === 'Work Order' && o.status === 'Done') {
        const prod = item(o.party);
        if (!prod) continue;
        const q = n(o.qty);
        moves.push({ moveDate: day, itemId: prod.id, qty: q, type: 'production', unitCost: cost(prod), orderId: o.id, refNo: o.orderNo });
        for (const b of bom.get(prod.id) || []) {
          const mat = item(b.material);
          if (mat) moves.push({ moveDate: day, itemId: mat.id, qty: -n(b.qtyPerUnit) * q, type: 'issue', unitCost: cost(mat), orderId: o.id, refNo: o.orderNo });
        }
      }
    }
    for (const m of moves) await store.insert('stockMoves', m, { audit: false });
    for (const [id, q] of delivered) await store.update('orderLines', id, { delivered: q }, { audit: false });
    await store.audit({ action: 'migrate', table: 'stockMoves', summary: `Stock ledger built from the order history: ${moves.length} movements` });
    return moves.length;
  });
}

export async function migrate(store) {
  return backfillStockMoves(store);
}
