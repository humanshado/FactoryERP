// ORDERS: quotes, invoices (the invoice is the customer's order), work orders and purchase orders in one list.
// The selected order shows as its document, with the NEXT STEP buttons of its type.
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { run } from '../api.js';
import {
  Badge, Card, Chips, DataList, Field, Input, Loading, PageHead, SearchBox, askConfirm, fmtDate, fmtMoney2, fmtNum, signalChange, useData,
} from '../ui.jsx';
import { useApp } from '../App.jsx';

export const TYPES = ['Quote', 'Invoice', 'Work Order', 'Purchase Order'];
export const STATUSES = {
  Quote: ['Open', 'Accepted', 'Lost', 'Expired'],
  Invoice: ['Ordered', 'In production', 'Unpaid', 'Part paid', 'Paid'],
  'Work Order': ['Planned', 'Released', 'In progress', 'Done'],
  'Purchase Order': ['On order', 'Received'],
};
export const LABELS = {
  Quote: { date: 'Quote date', due: 'Valid until', closed: null, party: 'Customer' },
  Invoice: { date: 'Invoice date', due: 'Due date', closed: 'Shipped', party: 'Customer' },
  'Work Order': { date: 'Start date', due: 'Due date', closed: 'Done date', party: 'Product' },
  'Purchase Order': { date: 'Order date', due: 'Expected', closed: 'Received', party: 'Supplier' },
};

function NewMenu({ onPick }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="menu-wrap">
      <button className="btn btn-primary" onClick={() => setOpen((o) => !o)} aria-expanded={open}>+ New ▾</button>
      {open && (
        <div className="menu" onMouseLeave={() => setOpen(false)}>
          {TYPES.map((t) => <button key={t} onClick={() => { setOpen(false); onPick(t); }}>{t}</button>)}
        </div>
      )}
    </div>
  );
}

export default function Orders() {
  const [orders, reloadList, error] = useData('/orders');
  const [params, setParams] = useSearchParams();
  const [search, setSearch] = useState('');
  const type = params.get('type') || 'All';
  const id = params.get('id') ? Number(params.get('id')) : null;
  const setQ = (patch) => {
    const p = Object.fromEntries(params.entries());
    Object.assign(p, patch);
    Object.keys(p).forEach((k) => (p[k] === null || p[k] === undefined || p[k] === 'All') && delete p[k]);
    setParams(p);
  };
  if (!orders) return <Loading error={error} />;
  const rows = type === 'All' ? orders : orders.filter((o) => o.type === type);
  const cols = [
    {
      key: 'orderNo', label: 'Order', render: (r) => <><b>{r.orderNo}</b><div className="muted small">{r.type}</div></>,
      sort: (r) => `${r.orderNo.replace(/\d+$/, '')}${r.orderNo.replace(/^\D+/, '').padStart(8, '0')}`, text: (r) => `${r.orderNo} ${r.type}`,
    },
    { key: 'party', label: 'Customer / supplier', render: (r) => <span className="clip">{r.party}</span> },
    { key: 'orderDate', label: 'Date', render: (r) => fmtDate(r.orderDate) },
    { key: 'total', label: 'Total', align: 'right', sort: (r) => (r.type === 'Work Order' ? null : r.total), render: (r) => (r.type === 'Work Order' ? <span className="muted">{fmtNum(r.qty)} units</span> : fmtMoney2(r.total)) },
    { key: 'status', label: 'Status', render: (r) => <Badge>{r.status}</Badge>, text: (r) => r.status },
  ];
  const create = async (t) => {
    const out = await run('POST', '/orders/new', { type: t });
    if (out?.order) {
      await reloadList();
      setQ({ id: out.order.id });
    }
  };
  return (
    <div className="page">
      <PageHead title="Orders" sub="Quotes, invoices, work orders and purchase orders">
        <NewMenu onPick={create} />
      </PageHead>
      <div className="split split-wide">
        <Card className="list-card" pad={false}>
          <div className="list-tools">
            <SearchBox value={search} onChange={setSearch} placeholder="Search number, party, status…" />
          </div>
          <div className="list-tools">
            <Chips options={['All', ...TYPES]} value={type} onChange={(t) => setQ({ type: t })} />
          </div>
          <DataList rows={rows} columns={cols} selectedId={id} onSelect={(r) => setQ({ id: r.id })} search={search}
            initialSort={{ key: 'orderDate', dir: 'desc' }} maxHeight="calc(100vh - 270px)" />
          <div className="list-foot muted">{rows.length} orders</div>
        </Card>
        <div className="detail">
          {id ? <OrderDoc key={id} id={id} onChanged={reloadList} onOpen={(oid) => setQ({ id: oid })} onGone={() => setQ({ id: null })} />
            : <div className="placeholder">Select an order in the list, or click <b>New</b>.</div>}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- one order
function OrderDoc({ id, onChanged, onOpen, onGone }) {
  const { settings, today } = useApp();
  const [doc, reload, error] = useData(`/orders/${id}`);
  const [stock] = useData('/stock');
  const [customers] = useData('/customers');
  const [suppliers] = useData('/suppliers');
  const [draft, setDraft] = useState(null);
  const nav = useNavigate();
  useEffect(() => {
    if (doc) setDraft({ ...doc.order });
  }, [doc]);
  const items = stock?.items || [];

  if (error) return <Loading error={error} />;
  if (!doc || !draft) return <Loading />;
  const o = doc.order;
  const L = LABELS[o.type];
  const dirty = JSON.stringify(draft) !== JSON.stringify(o);
  const refresh = async () => {
    await reload();
    onChanged();
    signalChange();
  };
  const act = async (action, body) => {
    const out = await run('POST', `/orders/${o.id}/${action}`, body);
    if (!out) return null;
    await refresh();
    if (out.boardWeek) nav(`/?week=${out.boardWeek}`);
    else if (out.orderId && out.orderId !== o.id) onOpen(out.orderId);
    return out;
  };
  const save = async () => {
    const patch = {};
    for (const k of Object.keys(draft)) if (draft[k] !== o[k]) patch[k] = draft[k];
    if (await run('PUT', `/orders/${o.id}`, patch)) refresh();
  };
  const remove = async () => {
    if (!(await askConfirm(`Delete ${o.orderNo} with its lines${o.type === 'Work Order' ? ' and operations' : ''}? This cannot be undone.`, { ok: 'Delete', cancel: 'Keep', danger: true }))) return;
    if (await run('DELETE', `/orders/${o.id}`)) {
      onChanged();
      signalChange();
      onGone();
    }
  };

  const partyOptions = o.type === 'Purchase Order' ? (suppliers || []).map((s) => s.name)
    : o.type === 'Work Order' ? items.filter((i) => i.type === 'Finished').map((i) => i.name)
      : (customers || []).map((c) => c.name);
  const set = (k) => (v) => setDraft({ ...draft, [k]: v });
  const P = doc.party;
  const addr = P && (o.type === 'Work Order'
    ? [P.description, P.code].filter(Boolean)
    : [P.contact && `Attn: ${P.contact}`, P.street, [P.city, P.state, P.zip].filter(Boolean).join(' '), P.phone, P.email].filter(Boolean));

  return (
    <>
      <Card pad={false} className="doc">
        <div className="doc-bar">
          <div className="doc-title">
            <span className="doc-type">{o.type.toUpperCase()}</span>
            <span className="doc-no">{o.orderNo}</span>
            <Badge>{o.status}</Badge>
            {o.priority === 'Rush' && <Badge>Rush</Badge>}
          </div>
          <div className="btn-row">
            <button className="btn btn-ghost-danger" onClick={remove}>Delete</button>
            <Link className="btn" to={`/orders/${o.id}/print`} target="_blank">Print / PDF</Link>
            <button className="btn btn-primary" disabled={!dirty} onClick={save}>Save</button>
          </div>
        </div>

        <div className="doc-head">
          <div className="doc-party">
            <Field label={L.party} required>
              <Input f={{ key: 'party', type: 'select', options: partyOptions, placeholder: `Pick the ${L.party.toLowerCase()}` }} value={draft.party} onChange={set('party')} />
            </Field>
            {addr && <div className="addr">{addr.map((a) => <div key={a}>{a}</div>)}</div>}
            {o.type === 'Work Order' && (
              <div className="form-grid two">
                <Field label="Quantity" required><Input f={{ key: 'qty', type: 'number' }} value={draft.qty} onChange={set('qty')} /></Field>
                <Field label="Priority"><Input f={{ key: 'priority', type: 'select', options: ['Normal', 'Rush'] }} value={draft.priority} onChange={set('priority')} /></Field>
              </div>
            )}
          </div>
          <div className="form-grid two doc-fields">
            <Field label="Number" required><Input f={{ key: 'orderNo' }} value={draft.orderNo} onChange={set('orderNo')} /></Field>
            <Field label="Status" required><Input f={{ key: 'status', type: 'select', options: STATUSES[o.type] }} value={draft.status} onChange={set('status')} /></Field>
            <Field label={L.date} required><Input f={{ key: 'orderDate', type: 'date' }} value={draft.orderDate} onChange={set('orderDate')} /></Field>
            <Field label={L.due}><Input f={{ key: 'dueDate', type: 'date' }} value={draft.dueDate} onChange={set('dueDate')} /></Field>
            {L.closed && <Field label={L.closed}><Input f={{ key: 'closedDate', type: 'date' }} value={draft.closedDate} onChange={set('closedDate')} /></Field>}
            {(o.type === 'Invoice' || o.type === 'Purchase Order') && (
              <Field label="Paid in full"><Input f={{ key: 'paidDate', type: 'date' }} value={draft.paidDate} onChange={set('paidDate')} /></Field>
            )}
            <Field label="From">
              <div className="from">
                {doc.related.filter((r) => r.orderNo === o.fromNo).map((r) => <a key={r.id} onClick={() => onOpen(r.id)}>{r.orderNo}</a>)}
                {!doc.related.some((r) => r.orderNo === o.fromNo) && (o.fromNo || 'New')}
              </div>
            </Field>
          </div>
        </div>

        {o.type === 'Work Order'
          ? <Operations doc={doc} settings={settings} refresh={refresh} />
          : <Lines doc={doc} items={items} refresh={refresh} />}

        <div className="doc-foot">
          <Field label="Notes" wide><Input f={{ key: 'notes', type: 'textarea', rows: 2 }} value={draft.notes} onChange={set('notes')} /></Field>
          {o.type !== 'Work Order' ? (
            <div className="totals">
              <div><span>Subtotal</span><b>{fmtMoney2(doc.totals.subtotal)}</b></div>
              {doc.totals.taxLabel && <div><span>{doc.totals.taxLabel}</span><b>{fmtMoney2(doc.totals.tax)}</b></div>}
              <div className="grand"><span>Total</span><b>{fmtMoney2(doc.totals.total)}</b></div>
              {(o.type === 'Invoice' || o.type === 'Purchase Order') && (
                <>
                  <div><span>{o.type === 'Invoice' ? 'Payments' : 'Paid'}</span><b>{fmtMoney2(doc.totals.paid)}</b></div>
                  <div className="grand"><span>Balance</span><b className={doc.totals.balance > 0.004 ? 'bad' : ''}>{fmtMoney2(doc.totals.balance)}</b></div>
                </>
              )}
              <TaxEdit draft={draft} setDraft={setDraft} />
            </div>
          ) : (
            <div className="totals">
              <div><span>Total hours</span><b>{fmtNum(doc.operations.reduce((s, x) => s + (x.hours || 0), 0))}</b></div>
              <div><span>Hours logged</span><b>{fmtNum(doc.loggedHours)}</b></div>
            </div>
          )}
        </div>
      </Card>

      <NextStep doc={doc} act={act} today={today} settings={settings} onOpen={onOpen} />
    </>
  );
}

function TaxEdit({ draft, setDraft }) {
  const [open, setOpen] = useState(false);
  if (!open) return <button className="link small" onClick={() => setOpen(true)}>Tax for this order…</button>;
  return (
    <div className="form-grid three tax-edit">
      <Field label="Charge tax"><Input f={{ key: 'useTax', type: 'select', options: ['Yes', 'No'] }} value={draft.useTax} onChange={(v) => setDraft({ ...draft, useTax: v })} /></Field>
      <Field label="Tax name"><Input f={{ key: 'taxName' }} value={draft.taxName} onChange={(v) => setDraft({ ...draft, taxName: v })} /></Field>
      <Field label="Rate %"><Input f={{ key: 'taxRate', type: 'percent' }} value={draft.taxRate} onChange={(v) => setDraft({ ...draft, taxRate: v })} /></Field>
    </div>
  );
}

// ---------------------------------------------------------------- lines (quotes, invoices, purchase orders)
function Lines({ doc, items, refresh }) {
  const o = doc.order;
  const isPO = o.type === 'Purchase Order';
  const pick = isPO ? items.filter((i) => i.type !== 'Finished') : items;
  const priceOf = (name) => {
    const it = items.find((i) => i.name === name);
    return it ? (isPO ? it.unitCost : it.price) : null;
  };
  const blank = { item: null, description: '', qty: 1, price: null };
  const [nw, setNw] = useState(blank);
  const add = async () => {
    const out = await run('POST', '/orderLines', { ...nw, orderId: o.id });
    if (out) {
      setNw(blank);
      refresh();
    }
  };
  return (
    <div className="lines">
      <table className="table lines-table order-lines">
        <thead>
          <tr><th>Item</th><th>Description</th><th className="num">Qty</th><th className="num">{isPO ? 'Unit cost' : 'Price'}</th><th className="num">Line total</th><th /></tr>
        </thead>
        <tbody>
          {doc.lines.map((l) => <LineRow key={l.id} line={l} pick={pick} items={items} priceOf={priceOf} locked={doc.locked} refresh={refresh} />)}
          {!doc.locked && (
            <tr className="new-line">
              <td>
                <select value={nw.item || ''} aria-label="New line item" onChange={(e) => {
                  const name = e.target.value || null;
                  const it = items.find((i) => i.name === name);
                  setNw({ ...nw, item: name, description: it?.description || '', price: priceOf(name) });
                }}>
                  <option value="">+ Add an item…</option>
                  {pick.map((i) => <option key={i.id} value={i.name}>{i.name}</option>)}
                </select>
              </td>
              <td><input value={nw.description || ''} onChange={(e) => setNw({ ...nw, description: e.target.value })} aria-label="Description" /></td>
              <td><input type="number" className="num" value={nw.qty ?? ''} onChange={(e) => setNw({ ...nw, qty: e.target.value === '' ? null : Number(e.target.value) })} aria-label="Qty" /></td>
              <td><input type="number" className="num" step="any" value={nw.price ?? ''} onChange={(e) => setNw({ ...nw, price: e.target.value === '' ? null : Number(e.target.value) })} aria-label="Price" /></td>
              <td className="num muted">{nw.item ? fmtMoney2((nw.qty || 0) * (nw.price || 0)) : ''}</td>
              <td><button className="btn btn-small btn-primary" disabled={!nw.item} onClick={add}>Add</button></td>
            </tr>
          )}
        </tbody>
      </table>
      <div className="lines-note muted">
        {doc.lines.length} line{doc.lines.length === 1 ? '' : 's'}
        {doc.locked && ` · locked: ${o.status.toLowerCase()}`}
      </div>
    </div>
  );
}

function LineRow({ line, pick, items, priceOf, locked, refresh }) {
  const [v, setV] = useState(line);
  useEffect(() => setV(line), [line]);
  const commit = async (next) => {
    const changed = ['item', 'description', 'qty', 'price'].some((k) => next[k] !== line[k]);
    if (changed && (await run('PUT', `/orderLines/${line.id}`, next))) refresh();
  };
  const del = async () => {
    if (await run('DELETE', `/orderLines/${line.id}`)) refresh();
  };
  if (locked) {
    return (
      <tr>
        <td>{line.item}</td><td>{line.description}</td><td className="num">{fmtNum(line.qty)}</td>
        <td className="num">{fmtMoney2(line.price)}</td><td className="num">{fmtMoney2((line.qty || 0) * (line.price || 0))}</td><td />
      </tr>
    );
  }
  return (
    <tr>
      <td>
        <select value={v.item || ''} aria-label="Item" onChange={(e) => {
          const name = e.target.value;
          const it = items.find((i) => i.name === name);
          const next = { ...v, item: name, description: it?.description || v.description, price: priceOf(name) ?? v.price };
          setV(next);
          commit(next);
        }}>
          {!pick.some((i) => i.name === v.item) && <option value={v.item}>{v.item}</option>}
          {pick.map((i) => <option key={i.id} value={i.name}>{i.name}</option>)}
        </select>
      </td>
      <td><input value={v.description || ''} onChange={(e) => setV({ ...v, description: e.target.value })} onBlur={() => commit(v)} aria-label="Description" /></td>
      <td><input type="number" className="num" value={v.qty ?? ''} onChange={(e) => setV({ ...v, qty: e.target.value === '' ? null : Number(e.target.value) })} onBlur={() => commit(v)} aria-label="Qty" /></td>
      <td><input type="number" className="num" step="any" value={v.price ?? ''} onChange={(e) => setV({ ...v, price: e.target.value === '' ? null : Number(e.target.value) })} onBlur={() => commit(v)} aria-label="Price" /></td>
      <td className="num">{fmtMoney2((v.qty || 0) * (v.price || 0))}</td>
      <td><button className="icon-btn" title="Remove line" aria-label="Remove line" onClick={del}>✕</button></td>
    </tr>
  );
}

// ---------------------------------------------------------------- operations (work orders)
function Operations({ doc, settings, refresh }) {
  const wcs = (settings.workCenters || []).map((w) => w.name);
  const save = async (op, patch) => {
    if (await run('PUT', `/operations/${op.id}`, patch)) refresh();
  };
  const add = async () => {
    const last = doc.operations[doc.operations.length - 1];
    if (await run('POST', '/operations', { orderId: doc.order.id, workCenter: wcs[0], opStart: last?.opStart || doc.order.orderDate, days: 1, hours: 1 })) refresh();
  };
  const del = async (op) => {
    if (await run('DELETE', `/operations/${op.id}`)) refresh();
  };
  return (
    <div className="lines">
      <table className="table lines-table">
        <thead><tr><th>#</th><th>Work center</th><th>Start</th><th className="num">Days</th><th className="num">Hours</th><th>Done</th><th /></tr></thead>
        <tbody>
          {doc.operations.map((op, i) => (
            <tr key={`${op.id}|${op.opStart}|${op.days}|${op.hours}`} className={op.done ? 'muted' : ''}>
              <td>{i + 1}</td>
              <td>
                <select value={op.workCenter || ''} onChange={(e) => save(op, { workCenter: e.target.value })} aria-label="Work center">
                  {!wcs.includes(op.workCenter) && <option>{op.workCenter}</option>}
                  {wcs.map((w) => <option key={w}>{w}</option>)}
                </select>
              </td>
              <td><input type="date" defaultValue={op.opStart || ''} onBlur={(e) => e.target.value !== op.opStart && save(op, { opStart: e.target.value })} aria-label="Start" /></td>
              <td><input type="number" className="num" min="1" defaultValue={op.days ?? ''} onBlur={(e) => Number(e.target.value) !== op.days && save(op, { days: Number(e.target.value) })} aria-label="Days" /></td>
              <td><input type="number" className="num" step="any" defaultValue={op.hours ?? ''} onBlur={(e) => Number(e.target.value) !== op.hours && save(op, { hours: Number(e.target.value) })} aria-label="Hours" /></td>
              <td><input type="checkbox" checked={!!op.done} onChange={(e) => save(op, { done: e.target.checked })} aria-label="Done" /></td>
              <td><button className="icon-btn" title="Remove operation" aria-label="Remove operation" onClick={() => del(op)}>✕</button></td>
            </tr>
          ))}
          {!doc.operations.length && <tr><td colSpan={7} className="empty">No operations yet: Schedule makes them from the product's routing.</td></tr>}
        </tbody>
      </table>
      <div className="lines-note muted">
        {doc.operations.length} operations · from the routing; move them on the Floor
        <button className="link small" onClick={add}>+ add an operation</button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- NEXT STEP
function NextStep({ doc, act, today, settings, onOpen }) {
  const o = doc.order;
  const [pay, setPay] = useState({ amount: null, date: today, method: (settings.payMethods || [])[0] || 'Bank transfer' });
  const steps = useMemo(() => {
    const s = [];
    const st = o.status;
    if (o.type === 'Quote') {
      s.push({ a: 'make-invoice', l: 'Make invoice', hint: 'A new invoice with these lines; the quote is Accepted.' });
      s.push({ a: 'make-work-orders', l: 'Make work orders', hint: 'One work order per product you make, with operations from its routing.' });
    } else if (o.type === 'Invoice') {
      if (!doc.shipped && !doc.workOrders.length) s.push({ a: 'make-work-orders', l: 'Make work orders', hint: 'One work order per product you make on this invoice.' });
      if (!doc.shipped) s.push({ a: 'ship', l: 'Ship now', hint: 'Ships it today (stock leaves); status follows the payments.' });
    } else if (o.type === 'Work Order') {
      s.push({ a: 'schedule', l: 'Schedule', hint: 'Operations from the routing (if none yet), then the Floor.' });
      if (st === 'Planned') s.push({ a: 'release', l: 'Release', hint: 'Checks the materials.' });
      if (st === 'Planned' || st === 'Released') s.push({ a: 'start', l: 'Start' });
      if (st !== 'Done') s.push({ a: 'complete', l: 'Complete', hint: 'Finished goods in, materials out, hours logged.' });
    } else if (o.type === 'Purchase Order' && st !== 'Received') {
      s.push({ a: 'receive', l: 'Receive', hint: 'The stock comes in today.' });
    }
    return s;
  }, [o, doc]);
  const payable = o.type === 'Invoice' || o.type === 'Purchase Order';
  return (
    <Card title="Next step">
      {doc.waitingFor && <div className="alert">Waiting for material: <b>{doc.waitingFor}</b>. Planning › Create purchase orders orders what is missing.</div>}
      {o.type === 'Invoice' && doc.workOrders.length > 0 && (
        <p className="muted small">Work orders: {doc.workOrders.map((w, i) => (
          <span key={w.id}>{i ? ', ' : ''}<a onClick={() => onOpen(w.id)}>{w.orderNo}</a> ({w.status.toLowerCase()})</span>
        ))}. The invoice ships by itself when they are all done.</p>
      )}
      <div className="steps">
        {steps.map((s) => (
          <button key={s.a} className="step" onClick={() => act(s.a)}>
            <b>{s.l}</b>
            {s.hint && <span>{s.hint}</span>}
          </button>
        ))}
        {!steps.length && !payable && <p className="muted">Nothing more to do on this {o.type.toLowerCase()}.</p>}
      </div>
      {payable && (
        <div className="pay">
          <h3>Record payment</h3>
          <div className="form-grid three">
            <Field label={o.type === 'Invoice' ? 'Amount received' : 'Amount paid'}>
              <Input f={{ key: 'amount', type: 'money' }} value={pay.amount} onChange={(v) => setPay({ ...pay, amount: v })} />
            </Field>
            <Field label="Date"><Input f={{ key: 'date', type: 'date' }} value={pay.date} onChange={(v) => setPay({ ...pay, date: v })} /></Field>
            <Field label="Method"><Input f={{ key: 'method', type: 'select', options: settings.payMethods || [] }} value={pay.method} onChange={(v) => setPay({ ...pay, method: v })} /></Field>
          </div>
          <div className="btn-row">
            {doc.totals.balance > 0.004 && <button className="btn" onClick={() => setPay({ ...pay, amount: doc.totals.balance })}>Balance {fmtMoney2(doc.totals.balance)}</button>}
            <button className="btn btn-primary" disabled={!(pay.amount > 0)} onClick={async () => (await act('payment', pay)) && setPay({ ...pay, amount: null })}>Record payment</button>
          </div>
          <p className="muted small">{o.type === 'Invoice'
            ? 'Adds a Money In row on the Ledger with the invoice number: an invoice can be paid in parts. Paid before it ships, it is a deposit.'
            : 'Adds a Money Out row (Supplier payment) with the PO number.'}</p>
          {doc.payments.length > 0 && (
            <table className="table compact">
              <tbody>
                {doc.payments.map((p) => (
                  <tr key={p.id}><td>{fmtDate(p.entryDate, true)}</td><td>{p.method}</td><td className="num">{fmtMoney2(p.amount)}</td></tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
      {doc.related.length > 0 && (
        <div className="related">
          <h3>Related</h3>
          {doc.related.map((r) => (
            <a key={r.id} className="rel" onClick={() => onOpen(r.id)}>
              <span>{r.orderNo}</span><span className="muted">{r.type}</span><Badge>{r.status}</Badge>
            </a>
          ))}
        </div>
      )}
    </Card>
  );
}
