// The HTTP API: sign-in, roles, the request header, the audit log, edit conflicts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { freshStore, sampleStore, server } from './helpers.js';

test('first run: set up the administrator once, then sign in', async () => {
  const s = await freshStore();
  const app = await server(s);
  try {
    const c = app.client();
    let r = await c('GET', '/auth/me');
    assert.equal(r.body.setupNeeded, true);
    assert.equal((await c('GET', '/bootstrap')).status, 401);
    assert.equal((await c('POST', '/auth/setup', { username: 'boss', password: 'short' })).status, 400);
    r = await c('POST', '/auth/setup', { username: 'boss', name: 'The Boss', password: 'a long enough password' });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.user.roles, ['admin']);
    assert.equal(r.body.user.passwordHash, undefined);
    assert.equal((await c('GET', '/bootstrap')).status, 200);
    // never twice
    assert.equal((await app.client()('POST', '/auth/setup', { username: 'mallory', password: 'another long password' })).status, 409);

    await c('POST', '/auth/logout');
    assert.equal((await c('GET', '/bootstrap')).status, 401);
    const d = app.client();
    assert.equal((await d('POST', '/auth/login', { username: 'boss', password: 'wrong password!!' })).status, 401);
    assert.equal((await d('POST', '/auth/login', { username: 'BOSS', password: 'a long enough password' })).status, 200);
    assert.equal((await d('GET', '/bootstrap')).status, 200);
  } finally {
    await app.close();
    await s.close();
  }
});

test('wrong passwords: a pause after five', async () => {
  const s = await freshStore();
  const app = await server(s);
  try {
    await app.as('admin');
    const c = app.client();
    for (let i = 0; i < 5; i++) assert.equal((await c('POST', '/auth/login', { username: 't-admin', password: `nope nope ${i}` })).status, 401);
    const r = await c('POST', '/auth/login', { username: 't-admin', password: 'correct horse battery' });
    assert.equal(r.status, 429);
    const audit = await s.auditLog({ action: 'login-failed' });
    assert.equal(audit.length, 5);
  } finally {
    await app.close();
    await s.close();
  }
});

test('changing requests need the FactoryERP header', async () => {
  const s = await sampleStore();
  const app = await server(s);
  try {
    const c = await app.as('admin');
    const r = await c('POST', '/customers', { name: 'Sneaky Co' }, { header: false });
    assert.equal(r.status, 403);
    assert.equal((await c('POST', '/customers', { name: 'Fine Co' })).status, 200);
  } finally {
    await app.close();
    await s.close();
  }
});

test('roles: each does its own work', async () => {
  const s = await sampleStore();
  const app = await server(s);
  try {
    const viewer = await app.as('viewer');
    const sales = await app.as('sales');
    const wh = await app.as('warehouse');
    assert.equal((await viewer('GET', '/orders')).status, 200);
    assert.equal((await viewer('POST', '/customers', { name: 'X' })).status, 403);
    assert.equal((await viewer('POST', '/orders/new', { type: 'Quote' })).status, 403);
    assert.equal((await viewer('GET', '/audit')).status, 403);
    assert.equal((await viewer('GET', '/users')).status, 403);

    const q = await sales('POST', '/orders/new', { type: 'Quote' });
    assert.equal(q.status, 200);
    assert.equal((await sales('POST', '/orders/new', { type: 'Purchase Order' })).status, 403);
    assert.equal((await sales('POST', '/stock/adjust', { itemId: 1, qty: 1, reason: 'Found' })).status, 403);
    assert.equal((await wh('POST', '/stock/adjust', { itemId: 1, qty: 1, reason: 'Found' })).status, 200);
    assert.equal((await wh('PUT', '/settings', { companyName: 'Hacked' })).status, 403);
    assert.equal((await wh('GET', '/backup')).status, 403);
  } finally {
    await app.close();
    await s.close();
  }
});

test('users: the administrator manages them; at least one administrator stays', async () => {
  const s = await freshStore();
  const app = await server(s);
  try {
    const admin = await app.as('admin');
    let r = await admin('POST', '/users', { username: 'ana', name: 'Ana', roles: ['production'], password: 'ana password 123' });
    assert.equal(r.status, 200);
    const ana = r.body.record;
    assert.equal((await admin('POST', '/users', { username: 'ANA', roles: ['viewer'], password: 'another password' })).status, 400);
    const anaC = app.client();
    assert.equal((await anaC('POST', '/auth/login', { username: 'ana', password: 'ana password 123' })).status, 200);
    // switched off: signed out at once
    assert.equal((await admin('PUT', `/users/${ana.id}`, { active: false })).status, 200);
    assert.equal((await anaC('GET', '/bootstrap')).status, 401);
    const me = (await admin('GET', '/auth/me')).body.user;
    r = await admin('PUT', `/users/${me.id}`, { roles: ['viewer'] });
    assert.equal(r.status, 400);
    // change your own password: old one stops working
    r = await admin('POST', '/auth/password', { current: 'correct horse battery', next: 'a brand new password' });
    assert.equal(r.status, 200);
    assert.equal((await app.client()('POST', '/auth/login', { username: 't-admin', password: 'correct horse battery' })).status, 401);
    assert.equal((await admin('GET', '/bootstrap')).status, 200); // this device stays signed in
  } finally {
    await app.close();
    await s.close();
  }
});

test('audit log: who changed what, with old and new values', async () => {
  const s = await sampleStore();
  const app = await server(s);
  try {
    const c = await app.as('manager');
    const cust = (await s.all('customers'))[0];
    await c('PUT', `/customers/${cust.id}`, { phone: '(616) 555-9999', rev: cust.rev });
    const log = (await c('GET', `/audit?table=customers&recordId=${cust.id}`)).body;
    assert.equal(log[0].userName, 't-manager');
    assert.deepEqual(log[0].changes.phone, [cust.phone, '(616) 555-9999']);
    const q = (await c('POST', '/orders/new', { type: 'Quote' })).body.order;
    await c('POST', `/orders/${q.id}/cancel`, { reason: 'test' });
    const ql = (await c('GET', `/audit?table=orders&recordId=${q.id}`)).body;
    assert.ok(ql.some((a) => a.action === 'cancel' && a.userName === 't-manager'));
    assert.ok(ql.some((a) => a.action === 'create'));
    assert.equal((await s.get('orders', q.id)).updatedBy, 't-manager');
  } finally {
    await app.close();
    await s.close();
  }
});

test('two people edit the same record: the second is told, nothing is lost silently', async () => {
  const s = await sampleStore();
  const app = await server(s);
  try {
    const a = await app.as('manager');
    const b = await app.as('accounts');
    const cust = (await s.all('customers'))[0];
    assert.equal((await a('PUT', `/customers/${cust.id}`, { ...cust, contact: 'Alan A.' })).status, 200);
    const r = await b('PUT', `/customers/${cust.id}`, { ...cust, contact: 'Alan B.' });
    assert.equal(r.status, 409);
    assert.match(r.body.error, /changed by t-manager/);
    assert.equal((await s.get('customers', cust.id)).contact, 'Alan A.');
  } finally {
    await app.close();
    await s.close();
  }
});

test('ledger entries are voided, not deleted; used records are archived, not deleted', async () => {
  const s = await sampleStore();
  const app = await server(s);
  try {
    const c = await app.as('admin');
    const m = (await s.all('moneyEntries'))[0];
    assert.equal((await c('DELETE', `/moneyEntries/${m.id}`)).status, 400);
    assert.equal((await c('POST', `/moneyEntries/${m.id}/void`, { reason: 'Duplicate' })).status, 200);
    assert.equal((await c('PUT', `/moneyEntries/${m.id}`, { amount: 1 })).status, 400);
    const cust = (await s.all('customers'))[0];
    assert.equal((await c('DELETE', `/customers/${cust.id}`)).status, 400);
    assert.equal((await c('PUT', `/customers/${cust.id}`, { archived: true })).status, 200);
    assert.ok((await s.get('customers', cust.id)).archived);
    for (const url of ['/bootstrap', '/stock', '/stock/moves?itemId=1', '/floor', '/pipeline', '/planning', '/reports', '/ledger/summary', '/orders', '/orders/2', '/stockCounts']) {
      assert.equal((await c('GET', url)).status, 200, url);
    }
    const r = await c('GET', '/backup');
    assert.equal(r.status, 200);
    assert.equal(r.body.users, undefined);
    assert.ok(r.body.stockMoves.length > 1000);
  } finally {
    await app.close();
    await s.close();
  }
});
