// LEDGER: every amount of money in and out. Payments recorded on orders land here too.
import { Link } from 'react-router-dom';
import MasterPage from '../MasterPage.jsx';
import { run } from '../api.js';
import { Badge, Kpi, askText, fmtDate, fmtMoney, fmtMoney2, fmtMonth, signalChange, useData } from '../ui.jsx';
import { useApp } from '../App.jsx';

export default function Ledger() {
  const { settings, today } = useApp();
  const [sum] = useData('/ledger/summary');
  const [customers] = useData('/customers');
  const [suppliers] = useData('/suppliers');
  const [orders] = useData('/orders');
  const cats = settings.moneyCategories || [];
  const orderByNo = new Map((orders || []).map((o) => [o.orderNo, o]));
  const fields = (d) => [
    { key: 'entryDate', label: 'Entry date', type: 'date', required: true },
    { key: 'direction', label: 'Direction', type: 'select', options: ['In', 'Out'], required: true },
    { key: 'category', label: 'Category', type: 'select', required: true, options: cats.filter((c) => !d.direction || c.direction === d.direction).map((c) => c.name) },
    { key: 'amount', label: 'Amount', type: 'money', required: true },
    { key: 'party', label: 'Party', list: 'parties' },
    { key: 'reference', label: 'Reference', hint: 'An invoice or PO number counts as a payment on that order.' },
    { key: 'method', label: 'Method', type: 'select', options: settings.payMethods || [] },
    { key: 'notes', label: 'Notes', type: 'textarea', wide: true },
    ...(d.void ? [{ key: 'voidReason', label: 'Void because', wide: true, readOnly: true }] : []),
  ];
  return (
    <>
      <datalist id="parties">
        {[...(customers || []), ...(suppliers || [])].map((p) => <option key={`${p.id}-${p.name}`} value={p.name} />)}
      </datalist>
      {sum && (
        <div className="page page-top">
          <div className="kpis kpis-4">
            <Kpi label={`Money in · ${fmtMonth(sum.month)}`} value={fmtMoney(sum.moneyIn)} tone="good" />
            <Kpi label="Money out" value={fmtMoney(sum.moneyOut)} tone="bad" />
            <Kpi label="Net (in − out)" value={fmtMoney(sum.net)} tone={sum.net < 0 ? 'bad' : 'good'} />
            <Kpi label="Entries this month" value={sum.entries} />
          </div>
        </div>
      )}
      <MasterPage
        table="moneyEntries" title="Ledger" sub="Money in and out (cash basis) · entries are voided, never deleted" newLabel="New entry"
        perm="ledger.edit" deletable={false} readOnlyWhen={(r) => r.void}
        recordActions={(r, { reload }) => !r.void && (
          <button className="btn btn-ghost-danger" onClick={async () => {
            const reason = await askText(`Void this ${fmtMoney2(r.amount)} entry? It stays on the Ledger, struck out, and leaves every total.`, { ok: 'Void', danger: true, required: true, placeholder: 'Why (e.g. duplicate, bounced, refunded)' });
            if (reason && (await run('POST', `/moneyEntries/${r.id}/void`, { reason }))) {
              await reload();
              signalChange();
            }
          }}>Void</button>
        )}
        nameOf={(r) => `${r.direction === 'In' ? 'Money in' : 'Money out'} · ${fmtMoney2(r.amount)}`}
        columns={[
          { key: 'entryDate', label: 'Date', render: (r) => fmtDate(r.entryDate, true) },
          { key: 'reference', label: 'Reference', render: (r) => (orderByNo.has(r.reference) ? <Link to={`/orders?id=${orderByNo.get(r.reference).id}`} onClick={(e) => e.stopPropagation()}>{r.reference}</Link> : r.reference) },
          { key: 'category', label: 'Category' },
          { key: 'party', label: 'Party' },
          { key: 'direction', label: '', render: (r) => (r.void ? <Badge tone="grey">Void</Badge> : <Badge>{r.direction}</Badge>), text: (r) => (r.void ? 'void' : r.direction) },
          { key: 'amount', label: 'Amount', align: 'right', render: (r) => <span className={r.void ? 'voided' : r.direction === 'Out' ? 'bad' : 'good'}>{r.direction === 'Out' ? '−' : '+'}{fmtMoney2(r.amount)}</span> },
        ]}
        initialSort={{ key: 'entryDate', dir: 'desc' }}
        filters={{
          options: [{ value: 'All', label: 'In and out' }, { value: 'In', label: 'Money in' }, { value: 'Out', label: 'Money out' }],
          test: (r, f) => f === 'All' || r.direction === f,
        }}
        fields={fields}
        blank={() => ({ entryDate: today, direction: 'Out', category: null, amount: null, method: (settings.payMethods || [])[0] || null })}
      />
    </>
  );
}
