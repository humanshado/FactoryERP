import test from 'node:test';
import assert from 'node:assert/strict';
import { addWorkdays, monday, nextWorkday, planWeek, workday, workdayIndex } from '../shared/dates.js';
import { orderTotals, payStatus, r2, recalc } from '../shared/engine.js';

const settings = {
  labourRate: 25, overheadPct: 0.3, useSalesTax: 'Yes', salesTaxName: 'Sales Tax', taxRate: 0.08, planningWeeks: 8,
  workCenters: [{ name: 'Assembly', hoursPerDay: 8 }, { name: 'Test', hoursPerDay: 8 }],
};

function fixture() {
  return {
    settings,
    items: [
      { id: 1, name: 'CPU', type: 'Raw', unitCost: 100, openingStock: 10, reorderPoint: 2, supplier: 'Chips Inc' },
      { id: 2, name: 'Case', type: 'Raw', unitCost: 50, openingStock: 3, reorderPoint: 5, supplier: 'Boxes Ltd' },
      { id: 3, name: 'Paste', type: 'Perishable', unitCost: 5, openingStock: 4, expiryDate: '2026-11-20' },
      { id: 4, name: 'PC', type: 'Finished', price: 999, openingStock: 1 },
    ],
    bomLines: [
      { id: 1, itemId: 4, material: 'CPU', qtyPerUnit: 1 },
      { id: 2, itemId: 4, material: 'Case', qtyPerUnit: 1 },
      { id: 3, itemId: 4, material: 'Paste', qtyPerUnit: 0.1 },
    ],
    routingSteps: [
      { id: 1, itemId: 4, workCenter: 'Assembly', hoursPerUnit: 2 },
      { id: 2, itemId: 4, workCenter: 'Test', hoursPerUnit: 1 },
    ],
    customers: [], suppliers: [], employees: [], timeEntries: [], operations: [], moneyEntries: [],
    orders: [], orderLines: [],
  };
}

test('working days', () => {
  assert.equal(monday('2026-11-19'), '2026-11-16');
  assert.equal(nextWorkday('2026-11-21'), '2026-11-23'); // Saturday -> Monday
  assert.equal(addWorkdays('2026-11-20', 1), '2026-11-23'); // Friday + 1 -> Monday
  assert.equal(workday('2026-11-17', 15), '2026-12-08');
  assert.equal(workdayIndex('2026-11-24', '2026-11-16'), 6);
  assert.equal(planWeek('2026-11-10', '2026-11-16'), 1); // earlier counts as this week
  assert.equal(planWeek('2026-11-30', '2026-11-16'), 3);
});

test('money rounds half up to the cent', () => {
  assert.equal(r2(211.525), 211.53);
  assert.equal(r2(-1.005), -1.01);
});

test('made item cost = materials + routing hours x labour x (1 + overhead)', () => {
  const C = recalc(fixture(), '2026-11-17');
  const pc = C.byId.get(4);
  // materials 100 + 50 + 0.5 = 150.5; labour 3 h x 25 x 1.3 = 97.5
  assert.equal(pc.cost, 248);
  assert.equal(pc.status, 'Made');
});

test('statuses: Low, Expiring, OK', () => {
  const C = recalc(fixture(), '2026-11-17');
  assert.equal(C.byId.get(1).status, 'OK');
  assert.equal(C.byId.get(2).status, 'Low'); // 3 on hand, reorder at 5
  assert.equal(C.byId.get(3).status, 'Expiring'); // perishable, expires within 30 days
});

test('stock moves: received PO in, done WO made in / materials out, shipped invoice out', () => {
  const D = fixture();
  D.orders.push(
    { id: 1, orderNo: 'PO-1001', type: 'Purchase Order', party: 'Boxes Ltd', status: 'Received', dueDate: '2026-11-10' },
    { id: 2, orderNo: 'WO-1001', type: 'Work Order', party: 'PC', qty: 2, status: 'Done', orderDate: '2026-11-10' },
    { id: 3, orderNo: 'INV-1001', type: 'Invoice', party: 'Acme', status: 'Unpaid', orderDate: '2026-11-12' },
    { id: 4, orderNo: 'INV-1002', type: 'Invoice', party: 'Acme', status: 'Ordered', orderDate: '2026-11-12' },
  );
  D.orderLines.push(
    { id: 1, orderId: 1, item: 'Case', qty: 10, price: 50 },
    { id: 2, orderId: 3, item: 'PC', qty: 1, price: 999 },
    { id: 3, orderId: 4, item: 'PC', qty: 5, price: 999 }, // not shipped: stays
  );
  const C = recalc(D, '2026-11-17');
  assert.equal(C.byId.get(2).onHand, 3 + 10 - 2);
  assert.equal(C.byId.get(1).onHand, 10 - 2);
  assert.equal(C.byId.get(4).onHand, 1 + 2 - 1);
  assert.equal(C.kpis.open, 1);
});

test('open work orders: waiting for material, to order and Short', () => {
  const D = fixture();
  D.suppliers.push({ id: 1, name: 'Boxes Ltd', leadDays: 3 });
  D.orders.push(
    { id: 1, orderNo: 'WO-1001', type: 'Work Order', party: 'PC', qty: 2, status: 'In progress', orderDate: '2026-11-18' },
    { id: 2, orderNo: 'WO-1002', type: 'Work Order', party: 'PC', qty: 4, status: 'Released', orderDate: '2026-11-17' },
    { id: 3, orderNo: 'PO-1001', type: 'Purchase Order', party: 'Boxes Ltd', status: 'On order', dueDate: '2026-11-25' },
  );
  D.orderLines.push({ id: 1, orderId: 3, item: 'Case', qty: 1, price: 50 });
  const C = recalc(D, '2026-11-17');
  // the one in progress takes its 2 cases first, leaving 1 for the released one that needs 4
  assert.equal(C.wait[2], 'Case');
  assert.equal(C.wait[1], undefined);
  const cs = C.byId.get(2);
  assert.equal(cs.toOrder, 6 - 3 - 1); // needs 6, has 3, 1 on order
  assert.equal(cs.status, 'Short');
  assert.equal(C.kpis.short, 1);
});

test('open quote past Valid Until expires', () => {
  const D = fixture();
  D.orders.push({ id: 1, orderNo: 'Q-1001', type: 'Quote', party: 'Acme', status: 'Open', dueDate: '2026-11-01' });
  const C = recalc(D, '2026-11-17');
  assert.deepEqual(C.expiredQuotes, [1]);
});

test('order totals use the tax the order was made with; payments decide pay status', () => {
  const D = fixture();
  D.orders.push({ id: 1, orderNo: 'INV-1001', type: 'Invoice', status: 'Unpaid', useTax: 'Yes', taxRate: 0.05, taxName: 'VAT' });
  D.orderLines.push({ id: 1, orderId: 1, item: 'PC', qty: 2, price: 100.25 });
  let t = orderTotals(D, D.orders[0]);
  assert.equal(t.subtotal, 200.5);
  assert.equal(t.tax, 10.03);
  assert.equal(t.total, 210.53);
  assert.equal(t.taxLabel, 'VAT 5.0%');
  assert.equal(payStatus(D, D.orders[0]), 'Unpaid');
  D.moneyEntries.push({ id: 1, direction: 'In', reference: 'INV-1001', amount: 100 });
  assert.equal(payStatus(D, D.orders[0]), 'Part paid');
  D.moneyEntries.push({ id: 2, direction: 'In', reference: 'INV-1001', amount: 110.53 });
  t = orderTotals(D, D.orders[0]);
  assert.equal(t.balance, 0);
  assert.equal(payStatus(D, D.orders[0]), 'Paid');
});
