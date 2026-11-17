// End to end on the sample data: quote -> invoice -> work orders -> floor -> ship -> paid, and purchasing.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Store } from '../server/db.js';
import { SEED_FILE, loadSeed, rollForward } from '../server/seed.js';
import * as A from '../server/actions.js';
import { createApp } from '../server/index.js';
import { board, pipeline, planning } from '../shared/engine.js';

const TODAY = '2026-11-17';
const seed = JSON.parse(fs.readFileSync(SEED_FILE, 'utf8'));

function sample() {
  const s = new Store(':memory:');
  loadSeed(s, seed);
  rollForward(s, TODAY);
  return s;
}
const onHand = (s, name) => A.compute(s, TODAY).itemByName(name).onHand;

test('sample data loads and rolls forward in whole weeks', () => {
  const s = sample();
  assert.equal(s.all('items').length, 26);
  assert.equal(s.all('orders').length, 233);
  assert.equal(s.getSettings().sampleAnchor, '2026-11-11'); // 2026-10-14 + 4 weeks
  const C = A.compute(s, TODAY);
  assert.ok(C.kpis.open > 0);
  assert.ok(pipeline(s.snapshot(), C).rows.length > 0);
  assert.ok(planning(s.snapshot(), C).materials.length > 0);
  assert.ok(board(s.snapshot(), C, TODAY).lanes.some((l) => l.bars.length));
});

test('quote to cash', () => {
  const s = sample();
  const office0 = onHand(s, 'Office PC');
  const cpu0 = onHand(s, '8-Core CPU');
  const { order: q } = A.newOrder(s, TODAY, { type: 'Quote', party: 'Oakmont Realty' });
  assert.match(q.orderNo, /^Q-\d+$/);
  assert.equal(q.status, 'Open');
  s.insert('orderLines', { orderId: q.id, item: 'Office PC', qty: 2, price: 1199 });

  const inv = s.get('orders', A.quoteMakeInvoice(s, TODAY, q.id).orderId);
  assert.equal(inv.type, 'Invoice');
  assert.equal(inv.status, 'Ordered');
  assert.equal(inv.fromNo, q.orderNo);
  assert.equal(s.get('orders', q.id).status, 'Accepted');
  assert.equal(s.all('orderLines').filter((l) => l.orderId === inv.id).length, 1);

  const r = A.makeWorkOrders(s, TODAY, q.id);
  const wo = s.get('orders', r.orderId);
  assert.equal(wo.type, 'Work Order');
  assert.equal(wo.party, 'Office PC');
  assert.equal(wo.qty, 2);
  assert.equal(wo.dueDate, inv.dueDate); // promised date of the invoice
  const ops = s.all('operations').filter((o) => o.orderId === wo.id);
  assert.equal(ops.length, 6); // one per routing step
  assert.ok(ops.every((o, i) => i === 0 || o.opStart >= ops[i - 1].opStart));
  assert.throws(() => A.makeWorkOrders(s, TODAY, q.id), /already has work orders/);

  A.woRelease(s, TODAY, wo.id);
  assert.equal(s.get('orders', inv.id).status, 'In production');
  A.woStart(s, TODAY, wo.id, { force: true });
  assert.equal(s.get('orders', wo.id).status, 'In progress');
  const done = A.woComplete(s, TODAY, wo.id, { force: true });
  assert.match(done.message, /shipped/);
  assert.ok(s.all('operations').filter((o) => o.orderId === wo.id).every((o) => o.done));
  assert.ok(s.all('timeEntries').some((t) => t.woNo === wo.orderNo));

  const shipped = s.get('orders', inv.id);
  assert.equal(shipped.status, 'Unpaid');
  assert.equal(shipped.closedDate, TODAY);
  // made 2, shipped 2: finished goods back where they were; materials used
  assert.equal(onHand(s, 'Office PC'), office0);
  assert.equal(onHand(s, '8-Core CPU'), cpu0 - 2);

  const total = 2 * 1199 * 1.08;
  assert.throws(() => A.recordPayment(s, TODAY, inv.id, { amount: total + 100 }), (e) => e.status === 409);
  A.recordPayment(s, TODAY, inv.id, { amount: 1000 });
  assert.equal(s.get('orders', inv.id).status, 'Part paid');
  A.recordPayment(s, TODAY, inv.id, { amount: total - 1000 });
  const paid = s.get('orders', inv.id);
  assert.equal(paid.status, 'Paid');
  assert.equal(paid.paidDate, TODAY);
  assert.equal(s.all('moneyEntries').filter((m) => m.reference === inv.orderNo).length, 2);
});

test('lost and expired quotes cannot be converted', () => {
  const s = sample();
  const { order: q } = A.newOrder(s, TODAY, { type: 'Quote', party: 'Oakmont Realty' });
  s.insert('orderLines', { orderId: q.id, item: 'Office PC', qty: 1, price: 1199 });
  s.update('orders', q.id, { status: 'Lost' });
  assert.throws(() => A.quoteMakeInvoice(s, TODAY, q.id), /lost/);
  s.update('orders', q.id, { status: 'Open', dueDate: '2026-11-01' });
  A.compute(s, TODAY);
  assert.equal(s.get('orders', q.id).status, 'Expired');
  assert.throws(() => A.quoteMakeInvoice(s, TODAY, q.id), /expired/);
});

test('planning: Create Purchase Orders covers every shortfall, Receive brings the stock in', () => {
  const s = sample();
  // a big work order that needs more than is on hand
  const { order: wo } = A.newOrder(s, TODAY, { type: 'Work Order', party: 'Gaming PC' });
  A.saveOrder(s, TODAY, wo.id, { qty: 60 });
  let C = A.compute(s, TODAY);
  assert.ok(C.wait[wo.id]);
  const shortBefore = C.items.filter((i) => i.toOrder > 0).length;
  assert.ok(shortBefore > 0);
  const out = A.createPurchaseOrders(s, TODAY);
  assert.match(out.message, /purchase order/);
  C = A.compute(s, TODAY);
  assert.equal(C.items.filter((i) => i.toOrder > 0).length, 0);
  assert.throws(() => A.createPurchaseOrders(s, TODAY), /Nothing to order/);

  // every open PO (the sample has some already) counts against "to order"; received, it is on hand
  const pos = s.all('orders').filter((o) => o.type === 'Purchase Order' && o.status === 'On order');
  assert.ok(pos.some((o) => o.notes === 'Created by Planning'));
  const gpu0 = onHand(s, 'Gaming GPU');
  for (const po of pos) A.poReceive(s, TODAY, po.id);
  assert.ok(onHand(s, 'Gaming GPU') > gpu0);
  assert.equal(A.compute(s, TODAY).wait[wo.id], undefined);
});

test('moving an operation on the Floor moves the work order start', () => {
  const s = sample();
  const { order: wo } = A.newOrder(s, TODAY, { type: 'Work Order', party: 'Office PC' });
  A.saveOrder(s, TODAY, wo.id, { qty: 1 });
  const first = s.all('operations').filter((o) => o.orderId === wo.id)[0];
  A.moveOperation(s, TODAY, first.id, { opStart: '2026-11-21' }); // a Saturday: lands on Monday
  assert.equal(s.get('operations', first.id).opStart, '2026-11-23');
  const starts = s.all('operations').filter((o) => o.orderId === wo.id).map((o) => o.opStart).sort();
  assert.equal(s.get('orders', wo.id).orderDate, starts[0]);
});

test('HTTP API: rename follows the links, lines lock', async () => {
  const s = sample();
  const app = createApp(s, { today: TODAY });
  const srv = app.listen(0);
  const base = `http://127.0.0.1:${srv.address().port}/api`;
  const call = async (method, url, body) => {
    const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };
  try {
    const cust = s.all('customers').find((c) => c.name === 'Oakmont Realty');
    const n0 = s.all('orders').filter((o) => o.party === 'Oakmont Realty').length;
    let r = await call('PUT', `/customers/${cust.id}`, { name: 'Oakmont Realty Group' });
    assert.equal(r.status, 200);
    assert.equal(s.all('orders').filter((o) => o.party === 'Oakmont Realty Group').length, n0);

    const paid = s.all('orders').find((o) => o.type === 'Invoice' && o.status === 'Paid');
    r = await call('POST', '/orderLines', { orderId: paid.id, item: 'Office PC', qty: 1, price: 1 });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /locked/);

    r = await call('GET', `/orders/${paid.id}`);
    assert.equal(r.status, 200);
    assert.ok(r.body.totals.total > 0);
    assert.equal(r.body.totals.balance, 0);

    for (const url of ['/bootstrap', '/stock', '/floor', '/pipeline', '/planning', '/reports', '/ledger/summary', '/orders']) {
      assert.equal((await call('GET', url)).status, 200, url);
    }
  } finally {
    srv.close();
  }
});
