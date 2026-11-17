// PIPELINE: order to cash, every open order stage by stage. Click an order to open it.
import { Link } from 'react-router-dom';
import { Badge, Card, DataList, Loading, PageHead, fmtDate, fmtMoney, useData } from '../ui.jsx';
import { useApp } from '../App.jsx';

export default function Pipeline() {
  const [data, , error] = useData('/pipeline');
  const { today } = useApp();
  if (!data) return <Loading error={error} />;
  const cols = [
    { key: 'orderNo', label: 'Order', render: (r) => <Link to={`/orders?id=${r.id}`}>{r.orderNo}</Link> },
    { key: 'party', label: 'Customer' },
    { key: 'dueDate', label: 'Due', render: (r) => <span className={r.dueDate && r.dueDate < today ? 'bad' : ''}>{fmtDate(r.dueDate, true)}</span> },
    { key: 'value', label: 'Value', align: 'right', render: (r) => fmtMoney(r.value) },
    { key: 'stage', label: 'Stage', render: (r) => <Badge tone="blue">{r.stage}</Badge> },
    { key: 'next', label: 'Next step' },
  ];
  return (
    <div className="page">
      <PageHead title="Pipeline" sub="Order to cash · every open order, stage by stage" />
      <div className="stages">
        {data.stages.map((s, i) => (
          <div key={s.name} className={`stage stage-${i}`}>
            <div className="stage-name">{s.name}{i === 6 && <span className="muted"> · last {data.paidDays} days</span>}</div>
            <div className="stage-count">{s.count}</div>
            <div className="stage-amt">{fmtMoney(s.amount)}</div>
            <div className="stage-list">
              {s.orders.slice(0, 4).map((o) => (
                <Link key={o.id} to={`/orders?id=${o.id}`} className="stage-chip">{o.orderNo} · {String(o.party || '').split(' ')[0]}</Link>
              ))}
              {s.orders.length > 4 && <span className="muted small">+{s.orders.length - 4} more</span>}
            </div>
          </div>
        ))}
      </div>
      <Card title="Open orders · next step" pad={false}>
        <DataList rows={data.rows} columns={cols} empty="No open orders." />
      </Card>
    </div>
  );
}
