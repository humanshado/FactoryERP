// End to end on the sample data: quote -> invoice -> work orders -> floor -> ship -> paid, and purchasing.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as A from '../server/actions.js';
import { board, pipeline, planning, stockRows } from '../shared/engine.js';
import { TODAY, sampleStore } from './helpers.js';

const onHand = async (s, name) => (await A.compute(s, TODAY)).itemByName(name).onHand;
const order = async (s, id) => s.get('orders', id);

test('sample data loads, rolls forward, and its stock ledger gives the same stock as the order history', async () => {
  const s = await sampleStore();
  try {
    assert.equal((await s.all('items')).length, 26);
    assert.equal((await s.all('orders')).length, 233);
    assert.equal((await s.getSettings()).sampleAnchor, '2026-11-11'); // 2026-10-14 + 4 weeks
    const C = await A.compute(s, TODAY);
    const legacy = JSON.parse(fs.readFileSync(new URL('./fixtures/legacy-stock-2026-11-17.json', import.meta.url)));
    for (const r of stockRows(C)) {
      assert.ok(Math.abs(r.onHand - legacy.items[r.id].onHand) < 1e-6, `on hand of item ${r.id}`);
      assert.equal(r.status, legacy.items[r.id].status, `status of item ${r.id}`);
    }
    assert.deepEqual(C.wait, legacy.wait);
    const D = await s.snapshot();
    assert.ok(pipeline(D, C).rows.length > 0);
    assert.ok(planning(D, C).materials.length > 0);
    assert.ok(board(D, C, TODAY).lanes.some((l) => l.bars.length));
  } finally {
    await s.close();
  }
});

test('quote to cash', async () => {
  const s = await sampleStore();
  try {
    const office0 = await onHand(s, 'Office PC');
    const cpu0 = await onHand(s, '8-Core CPU');
    const { order: q } = await A.newOrder(s, TODAY, { type: 'Quote', party: 'Oakmont Realty' });
    assert.match(q.orderNo, /^Q-\d+$/);
    assert.equal(q.status, 'Open');
    await s.insert('orderLines', { orderId: q.id, item: 'Office PC', qty: 2, price: 1199 });

    const inv = await order(s, (await A.quoteMakeInvoice(s, TODAY, q.id)).orderId);
    assert.equal(inv.type, 'Invoice');
    assert.equal(inv.status, 'Ordered');
    assert.equal(inv.fromNo, q.orderNo);
    assert.equal((await order(s, q.id)).status, 'Accepted');

    const wo = await order(s, (await A.makeWorkOrders(s, TODAY, q.id)).orderId);
    assert.equal(wo.party, 'Office PC');
    assert.equal(wo.qty, 2);
    assert.equal(wo.dueDate, inv.dueDate);
    const ops = (await s.all('operations')).filter((o) => o.orderId === wo.id);
    assert.equal(ops.length, 6);
    await assert.rejects(A.makeWorkOrders(s, TODAY, q.id), /already has work orders/);

    await A.woRelease(s, TODAY, wo.id);
    assert.equal((await order(s, inv.id)).status, 'In production');
    await A.woStart(s, TODAY, wo.id, { force: true });
    const done = await A.woComplete(s, TODAY, wo.id, { force: true });
    assert.match(done.message, /shipped/);
    assert.ok((await s.all('operations')).filter((o) => o.orderId === wo.id).every((o) => o.done));
    assert.ok((await s.all('timeEntries')).some((t) => t.woNo === wo.orderNo));

    const shipped = await order(s, inv.id);
    assert.equal(shipped.status, 'Unpaid');
    assert.equal(shipped.closedDate, TODAY);
    assert.equal(await onHand(s, 'Office PC'), office0); // made 2, shipped 2
    assert.equal(await onHand(s, '8-Core CPU'), cpu0 - 2);
    const moves = (await s.all('stockMoves')).filter((m) => m.orderId === wo.id || m.orderId === inv.id);
    assert.deepEqual([...new Set(moves.map((m) => m.type))].sort(), ['issue', 'production', 'shipment']);

    const total = 2 * 1199 * 1.08;
    await assert.rejects(A.recordPayment(s, TODAY, inv.id, { amount: total + 100 }), (e) => e.status === 409);
    await A.recordPayment(s, TODAY, inv.id, { amount: 1000 });
    assert.equal((await order(s, inv.id)).status, 'Part paid');
    await A.recordPayment(s, TODAY, inv.id, { amount: total - 1000 });
    assert.equal((await order(s, inv.id)).status, 'Paid');

    // void a payment: the invoice follows, the entry stays on file
    const pay = (await s.all('moneyEntries')).find((m) => m.reference === inv.orderNo && m.amount === 1000);
    await assert.rejects(A.voidMoney(s, TODAY, pay.id, {}), /why/);
    await A.voidMoney(s, TODAY, pay.id, { reason: 'Bounced' });
    assert.equal((await order(s, inv.id)).status, 'Part paid');
    assert.equal((await order(s, inv.id)).paidDate, null);
    assert.ok((await s.get('moneyEntries', pay.id)).void);
  } finally {
    await s.close();
  }
});

test('partial receipts: Part received, then Received; over-receiving asks first', async () => {
  const s = await sampleStore();
  try {
    const { order: po } = await A.newOrder(s, TODAY, { type: 'Purchase Order', party: 'Northwind Components' });
    const a = await s.insert('orderLines', { orderId: po.id, item: '8-Core CPU', qty: 10, price: 189 });
    const b = await s.insert('orderLines', { orderId: po.id, item: '16GB RAM kit', qty: 5, price: 42 });
    const cpu0 = await onHand(s, '8-Core CPU');
    const C0 = await A.compute(s, TODAY);
    const open0 = C0.itemByName('8-Core CPU').openPO;

    await A.poReceive(s, TODAY, po.id, { lines: [{ lineId: a.id, qty: 4 }] });
    assert.equal((await order(s, po.id)).status, 'Part received');
    assert.equal(await onHand(s, '8-Core CPU'), cpu0 + 4);
    assert.equal((await A.compute(s, TODAY)).itemByName('8-Core CPU').openPO, open0 - 4);
    await assert.rejects(A.poReceive(s, TODAY, po.id, { lines: [{ lineId: a.id, qty: 7 }] }), (e) => e.status === 409);

    await A.poReceive(s, TODAY, po.id, {}); // the rest
    const done = await order(s, po.id);
    assert.equal(done.status, 'Received');
    assert.equal(done.closedDate, TODAY);
    assert.equal(await onHand(s, '8-Core CPU'), cpu0 + 10);
    assert.equal((await s.get('orderLines', b.id)).delivered, 5);
    await assert.rejects(A.poReceive(s, TODAY, po.id, {}), /received in full/);
  } finally {
    await s.close();
  }
});

test('partial shipments: Part shipped, then shipped and Unpaid; short stock asks first', async () => {
  const s = await sampleStore();
  try {
    const { order: inv } = await A.newOrder(s, TODAY, { type: 'Invoice', party: 'Oakmont Realty' });
    const l = await s.insert('orderLines', { orderId: inv.id, item: '1TB SSD', qty: 6, price: 73 });
    const ssd0 = await onHand(s, '1TB SSD');
    await A.invoiceShip(s, TODAY, inv.id, { lines: [{ lineId: l.id, qty: 2 }] });
    assert.equal((await order(s, inv.id)).status, 'Part shipped');
    assert.equal(await onHand(s, '1TB SSD'), ssd0 - 2);
    await assert.rejects(A.invoiceShip(s, TODAY, inv.id, { lines: [{ lineId: l.id, qty: 9 }] }), /more than/);
    await A.invoiceShip(s, TODAY, inv.id, {});
    assert.equal((await order(s, inv.id)).status, 'Unpaid');
    assert.equal(await onHand(s, '1TB SSD'), ssd0 - 6);

    const { order: big } = await A.newOrder(s, TODAY, { type: 'Invoice', party: 'Oakmont Realty' });
    await s.insert('orderLines', { orderId: big.id, item: 'Pro GPU', qty: 500, price: 1 });
    await assert.rejects(A.invoiceShip(s, TODAY, big.id, {}), (e) => e.status === 409 && /Not enough/.test(e.message));
  } finally {
    await s.close();
  }
});

test('cancel instead of delete', async () => {
  const s = await sampleStore();
  try {
    // a draft can be deleted
    const { order: draft } = await A.newOrder(s, TODAY, { type: 'Quote', party: 'Oakmont Realty' });
    await A.deleteOrder(s, TODAY, draft.id);
    assert.equal(await s.get('orders', draft.id), null);

    // anything with history cannot
    const paid = (await s.all('orders')).find((o) => o.type === 'Invoice' && o.status === 'Paid');
    await assert.rejects(A.deleteOrder(s, TODAY, paid.id), /Cancel it instead/);
    await assert.rejects(A.cancelOrder(s, TODAY, paid.id, {}), /shipped goods/);

    // an invoice with a deposit: void the payment first
    const { order: inv } = await A.newOrder(s, TODAY, { type: 'Invoice', party: 'Oakmont Realty' });
    await s.insert('orderLines', { orderId: inv.id, item: 'Office PC', qty: 1, price: 1199 });
    await A.recordPayment(s, TODAY, inv.id, { amount: 100 });
    await assert.rejects(A.cancelOrder(s, TODAY, inv.id, {}), /Void them/);
    const dep = (await s.all('moneyEntries')).find((m) => m.reference === inv.orderNo);
    await A.voidMoney(s, TODAY, dep.id, { reason: 'Refunded' });
    const out = await A.cancelOrder(s, TODAY, inv.id, { reason: 'Customer changed mind' });
    assert.match(out.message, /cancelled/);
    const c = await order(s, inv.id);
    assert.equal(c.status, 'Cancelled');
    assert.match(c.notes, /Customer changed mind/);
    await assert.rejects(A.invoiceShip(s, TODAY, inv.id, {}), /cancelled/);
    // a cancelled invoice is no open order
    const C = await A.compute(s, TODAY);
    assert.ok(!pipeline(await s.snapshot(), C).rows.some((r) => r.id === inv.id));

    // a part-received PO: the rest is cancelled, the stock stays; no longer "on order"
    const foamOpen0 = (await A.compute(s, TODAY)).itemByName('Foam insert set').openPO;
    const { order: po } = await A.newOrder(s, TODAY, { type: 'Purchase Order', party: 'Bluebox Packaging' });
    const l = await s.insert('orderLines', { orderId: po.id, item: 'Foam insert set', qty: 50, price: 2.4 });
    await A.poReceive(s, TODAY, po.id, { lines: [{ lineId: l.id, qty: 20 }] });
    const foam = await onHand(s, 'Foam insert set');
    await A.cancelOrder(s, TODAY, po.id, {});
    assert.equal(await onHand(s, 'Foam insert set'), foam);
    assert.equal((await A.compute(s, TODAY)).itemByName('Foam insert set').openPO, foamOpen0);

    // status changes go through their steps
    const wo = (await s.all('orders')).find((o) => o.type === 'Work Order' && o.status === 'Done');
    await assert.rejects(A.saveOrder(s, TODAY, wo.id, { status: 'Planned' }), /stays done/);
  } finally {
    await s.close();
  }
});

test('stock adjustments and counts post to the ledger', async () => {
  const s = await sampleStore();
  try {
    const it = (await s.all('items')).find((i) => i.name === 'CPU cooler');
    const before = await onHand(s, 'CPU cooler');
    await assert.rejects(A.stockAdjust(s, TODAY, { itemId: it.id, qty: -3 }), /reason/);
    await A.stockAdjust(s, TODAY, { itemId: it.id, qty: -3, reason: 'Damaged', note: 'dropped' });
    assert.equal(await onHand(s, 'CPU cooler'), before - 3);
    const out = await A.stockCount(s, TODAY, { lines: [{ itemId: it.id, counted: 50 }, { itemId: 1, counted: null }] });
    assert.match(out.message, /CNT-1001 posted: 1 counted, 1 adjusted/);
    assert.equal(await onHand(s, 'CPU cooler'), 50);
    const cnt = (await s.all('stockCounts'))[0];
    assert.equal(cnt.lines[0].expected, before - 3);
    assert.equal(cnt.lines[0].diff, 50 - (before - 3));
  } finally {
    await s.close();
  }
});

test('planning: Create Purchase Orders covers every shortfall, Receive brings the stock in', async () => {
  const s = await sampleStore();
  try {
    const { order: wo } = await A.newOrder(s, TODAY, { type: 'Work Order', party: 'Gaming PC' });
    await A.saveOrder(s, TODAY, wo.id, { qty: 60 });
    let C = await A.compute(s, TODAY);
    assert.ok(C.wait[wo.id]);
    await A.createPurchaseOrders(s, TODAY);
    C = await A.compute(s, TODAY);
    assert.equal(C.items.filter((i) => i.toOrder > 0).length, 0);
    await assert.rejects(A.createPurchaseOrders(s, TODAY), /Nothing to order/);
    for (const po of (await s.all('orders')).filter((o) => o.type === 'Purchase Order' && o.status === 'On order')) await A.poReceive(s, TODAY, po.id);
    assert.equal((await A.compute(s, TODAY)).wait[wo.id], undefined);
  } finally {
    await s.close();
  }
});

test('moving an operation on the Floor moves the work order start', async () => {
  const s = await sampleStore();
  try {
    const { order: wo } = await A.newOrder(s, TODAY, { type: 'Work Order', party: 'Office PC' });
    await A.saveOrder(s, TODAY, wo.id, { qty: 1 });
    const first = (await s.all('operations')).filter((o) => o.orderId === wo.id)[0];
    await A.moveOperation(s, TODAY, first.id, { opStart: '2026-11-21' }); // a Saturday: lands on Monday
    assert.equal((await s.get('operations', first.id)).opStart, '2026-11-23');
    const starts = (await s.all('operations')).filter((o) => o.orderId === wo.id).map((o) => o.opStart).sort();
    assert.equal((await order(s, wo.id)).orderDate, starts[0]);
  } finally {
    await s.close();
  }
});

test('concurrent completes: one wins, the other is told', async () => {
  const s = await sampleStore();
  try {
    const { order: wo } = await A.newOrder(s, TODAY, { type: 'Work Order', party: 'Office PC' });
    await A.saveOrder(s, TODAY, wo.id, { qty: 1 });
    const r = await Promise.allSettled([1, 2, 3].map(() => A.woComplete(s, TODAY, wo.id, { force: true })));
    assert.equal(r.filter((x) => x.status === 'fulfilled').length, 1);
    assert.equal((await s.all('stockMoves')).filter((m) => m.orderId === wo.id && m.type === 'production').length, 1);
  } finally {
    await s.close();
  }
});
