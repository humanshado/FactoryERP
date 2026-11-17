// CUSTOMERS and SUPPLIERS: details, a summary, and their orders.
import { Link } from 'react-router-dom';
import MasterPage from '../MasterPage.jsx';
import { Badge, Card, Stat, fmtDate, fmtMoney, fmtMoney2, useData } from '../ui.jsx';

function PartyOrders({ name, orders }) {
  const mine = (orders || []).filter((o) => o.party === name).sort((a, b) => (b.orderDate || '').localeCompare(a.orderDate || ''));
  return (
    <Card title={`Orders · ${mine.length}`} pad={false}>
      <div className="table-wrap" style={{ maxHeight: 340 }}>
        <table className="table compact">
          <tbody>
            {mine.map((o) => (
              <tr key={o.id}>
                <td><Link to={`/orders?id=${o.id}`}>{o.orderNo}</Link></td>
                <td>{fmtDate(o.orderDate, true)}</td>
                <td>{o.type}</td>
                <td className="num">{o.total === null ? '' : fmtMoney2(o.total)}</td>
                <td><Badge>{o.status}</Badge></td>
              </tr>
            ))}
            {!mine.length && <tr><td className="empty">No orders yet.</td></tr>}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function useRelated() {
  const [orders] = useData('/orders');
  const [money] = useData('/moneyEntries');
  const [items] = useData('/items');
  return { orders: orders || [], money: money || [], items: items || [] };
}

export function Customers() {
  const R = useRelated();
  const fields = () => [
    { key: 'name', label: 'Customer name', required: true, wide: true },
    { key: 'contact', label: 'Contact' },
    { key: 'phone', label: 'Phone', inputType: 'tel' },
    { key: 'email', label: 'Email', inputType: 'email', wide: true },
    { key: 'street', label: 'Street', wide: true },
    { key: 'city', label: 'City' },
    { key: 'state', label: 'State' },
    { key: 'zip', label: 'Zip' },
    { key: 'notes', label: 'Notes', type: 'textarea', wide: true },
  ];
  const openOrders = (name) => R.orders.filter((o) => o.party === name && o.type === 'Invoice' && (o.status === 'Ordered' || o.status === 'In production')).length;
  const summary = (c) => {
    const inv = R.orders.filter((o) => o.party === c.name && o.type === 'Invoice');
    const unpaid = inv.filter((o) => o.status === 'Unpaid' || o.status === 'Part paid');
    const last = inv.map((o) => o.orderDate).sort().pop();
    return (
      <Card title="Summary">
        <div className="stats">
          <Stat label="Open orders (not shipped)" value={openOrders(c.name)} />
          <Stat label="Unpaid invoices" value={`${unpaid.length} · ${fmtMoney(unpaid.reduce((s, o) => s + (o.total || 0), 0))}`} />
          <Stat label="Open quotes" value={R.orders.filter((o) => o.party === c.name && o.type === 'Quote' && o.status === 'Open').length} />
          <Stat label="Paid to date" value={fmtMoney(R.money.filter((m) => !m.void && m.direction === 'In' && m.party === c.name).reduce((s, m) => s + (m.amount || 0), 0))} />
          <Stat label="Last invoice" value={last ? fmtDate(last, true) : 'none'} />
        </div>
      </Card>
    );
  };
  return (
    <MasterPage
      table="customers" title="Customers" sub="Who you sell to" newLabel="New customer" nameOf={(r) => r.name} perm="customers.edit" archivable
      columns={[
        { key: 'name', label: 'Customer', render: (r) => <b>{r.name}</b> },
        { key: 'contact', label: 'Contact' },
        { key: 'phone', label: 'Phone' },
        { key: 'open', label: 'Open', align: 'right', render: (r) => openOrders(r.name) || '', sort: (r) => openOrders(r.name), text: () => '' },
      ]}
      initialSort={{ key: 'name', dir: 'asc' }}
      fields={fields} blank={() => ({ name: '' })} summary={summary}
      below={(c) => <PartyOrders name={c.name} orders={R.orders} />}
    />
  );
}

export function Suppliers() {
  const R = useRelated();
  const fields = () => [
    { key: 'name', label: 'Supplier name', required: true, wide: true },
    { key: 'contact', label: 'Contact' },
    { key: 'phone', label: 'Phone', inputType: 'tel' },
    { key: 'email', label: 'Email', inputType: 'email' },
    { key: 'leadDays', label: 'Lead days', type: 'number', hint: 'Days from ordering to delivery (Planning uses it).' },
    { key: 'notes', label: 'Notes', type: 'textarea', wide: true },
  ];
  const summary = (s) => {
    const pos = R.orders.filter((o) => o.party === s.name && o.type === 'Purchase Order');
    const last = pos.map((o) => o.orderDate).sort().pop();
    const mine = R.items.filter((i) => i.supplier === s.name);
    return (
      <Card title="Summary">
        <div className="stats">
          <Stat label="Open purchase orders" value={pos.filter((o) => o.status === 'On order').length} />
          <Stat label="Received purchase orders" value={pos.filter((o) => o.status === 'Received').length} />
          <Stat label="Items from this supplier" value={mine.length} />
          <Stat label="Paid to date" value={fmtMoney(R.money.filter((m) => !m.void && m.direction === 'Out' && m.party === s.name).reduce((t, m) => t + (m.amount || 0), 0))} />
          <Stat label="Last purchase order" value={last ? fmtDate(last, true) : 'none'} />
        </div>
        {mine.length > 0 && (
          <p className="muted small">Supplies: {mine.map((i, k) => <span key={i.id}>{k ? ', ' : ''}<Link to={`/stock?id=${i.id}`}>{i.name}</Link></span>)}</p>
        )}
      </Card>
    );
  };
  return (
    <MasterPage
      table="suppliers" title="Suppliers" sub="Who you buy from" newLabel="New supplier" nameOf={(r) => r.name} perm="suppliers.edit" archivable
      columns={[
        { key: 'name', label: 'Supplier', render: (r) => <b>{r.name}</b> },
        { key: 'contact', label: 'Contact' },
        { key: 'phone', label: 'Phone' },
        { key: 'leadDays', label: 'Lead days', align: 'right' },
      ]}
      initialSort={{ key: 'name', dir: 'asc' }}
      fields={fields} blank={() => ({ name: '', leadDays: 5 })} summary={summary}
      below={(s) => <PartyOrders name={s.name} orders={R.orders} />}
    />
  );
}
