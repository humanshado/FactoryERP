// The printed page of an order (any type). Print it, or "Save as PDF" from the print dialog.
import { useParams } from 'react-router-dom';
import { Loading, fmtDate, fmtMoney2, fmtNum, useData } from '../ui.jsx';
import { useApp } from '../App.jsx';
import { LABELS } from './Orders.jsx';

export default function OrderPrint() {
  const { id } = useParams();
  const { settings } = useApp();
  const [doc, , error] = useData(`/orders/${id}`);
  if (!doc) return <Loading error={error} />;
  const o = doc.order;
  const L = LABELS[o.type];
  const P = doc.party;
  const isWO = o.type === 'Work Order';
  const to = isWO ? 'Product' : o.type === 'Purchase Order' ? 'Supplier' : 'Bill to';
  return (
    <div className="print-page">
      <div className="print-tools no-print">
        <button className="btn btn-primary" onClick={() => window.print()}>Print / Save as PDF</button>
        <button className="btn" onClick={() => window.close()}>Close</button>
      </div>
      <article className="paper">
        <header className="paper-head">
          <div>
            <div className="paper-co">{settings.companyName}</div>
            <div className="muted">{settings.companyAddress}</div>
            <div className="muted">{settings.companyContact}</div>
          </div>
          <div className="paper-type">
            <div>{o.type.toUpperCase()}</div>
            <table className="paper-meta">
              <tbody>
                <tr><th>{isWO ? 'WO No' : o.type === 'Purchase Order' ? 'PO No' : `${o.type} No`}</th><td>{o.orderNo}</td></tr>
                <tr><th>{L.date}</th><td>{fmtDate(o.orderDate, true)}</td></tr>
                {o.dueDate && <tr><th>{L.due}</th><td>{fmtDate(o.dueDate, true)}</td></tr>}
                {o.fromNo && <tr><th>From</th><td>{o.fromNo}</td></tr>}
                <tr><th>Status</th><td>{o.status}</td></tr>
              </tbody>
            </table>
          </div>
        </header>
        <section className="paper-to">
          <div className="paper-label">{to}</div>
          <b>{o.party}</b>
          {P && !isWO && (
            <>
              {P.contact && <div>Attn: {P.contact}</div>}
              {P.street && <div>{P.street}</div>}
              {(P.city || P.state) && <div>{[P.city, P.state, P.zip].filter(Boolean).join(' ')}</div>}
              {P.phone && <div>{P.phone}</div>}
              {P.email && <div>{P.email}</div>}
            </>
          )}
          {isWO && <div>Quantity: <b>{fmtNum(o.qty)}</b>{o.priority === 'Rush' ? ' · RUSH' : ''}</div>}
        </section>
        {isWO ? (
          <table className="paper-lines">
            <thead><tr><th>#</th><th>Operation</th><th>Start</th><th className="num">Days</th><th className="num">Hours</th><th>Done</th></tr></thead>
            <tbody>
              {doc.operations.map((op, i) => (
                <tr key={op.id}><td>{i + 1}</td><td>{op.workCenter}</td><td>{fmtDate(op.opStart, true)}</td><td className="num">{op.days}</td><td className="num">{fmtNum(op.hours)}</td><td>{op.done ? '✓' : '☐'}</td></tr>
              ))}
            </tbody>
          </table>
        ) : (
          <>
            <table className="paper-lines">
              <thead><tr><th>Item</th><th>Description</th><th className="num">Qty</th><th className="num">{o.type === 'Purchase Order' ? 'Unit cost' : 'Price'}</th><th className="num">Line total</th></tr></thead>
              <tbody>
                {doc.lines.map((l) => (
                  <tr key={l.id}><td>{l.item}</td><td>{l.description}</td><td className="num">{fmtNum(l.qty)}</td><td className="num">{fmtMoney2(l.price)}</td><td className="num">{fmtMoney2((l.qty || 0) * (l.price || 0))}</td></tr>
                ))}
              </tbody>
            </table>
            <table className="paper-totals">
              <tbody>
                <tr><th>Subtotal</th><td>{fmtMoney2(doc.totals.subtotal)}</td></tr>
                {doc.totals.taxLabel && <tr><th>{doc.totals.taxLabel}</th><td>{fmtMoney2(doc.totals.tax)}</td></tr>}
                <tr className="grand"><th>Total</th><td>{fmtMoney2(doc.totals.total)}</td></tr>
                {(o.type === 'Invoice' || o.type === 'Purchase Order') && doc.totals.paid > 0 && (
                  <>
                    <tr><th>Paid</th><td>{fmtMoney2(doc.totals.paid)}</td></tr>
                    <tr className="grand"><th>Balance due</th><td>{fmtMoney2(doc.totals.balance)}</td></tr>
                  </>
                )}
              </tbody>
            </table>
          </>
        )}
        {o.notes && <section className="paper-notes"><div className="paper-label">Notes</div>{o.notes}</section>}
        <footer className="paper-foot">{settings.companyName} · {settings.companyContact}</footer>
      </article>
    </div>
  );
}
