// PLANNING (MRP), the next weeks from this Monday: products the open work orders start each week
// (coloured by the busiest work center they use), each material's projected balance, and what to order.
import { run } from '../api.js';
import { Card, Loading, PageHead, fmtDate, fmtMoney, fmtNum, fmtPct, signalChange, useData } from '../ui.jsx';
import { useApp } from '../App.jsx';

export default function Planning() {
  const [data, , error] = useData('/planning');
  const { can } = useApp();
  if (!data) return <Loading error={error} />;
  const { weeks } = data;
  const create = async () => {
    if (await run('POST', '/planning/create-pos')) signalChange();
  };
  const head = (
    <tr>
      <th className="sticky-col">&nbsp;</th>
      {weeks.map((w) => <th key={w} className="num">{fmtDate(w)}</th>)}
    </tr>
  );
  return (
    <div className="page">
      <PageHead title="Planning" sub={`Materials requirement planning · ${weeks.length} weeks from ${fmtDate(weeks[0], true)}`}>
        {can('purchases.edit') && <button className="btn btn-primary" disabled={!data.toOrder.length} onClick={create}>Create purchase orders</button>}
      </PageHead>

      <div className="grid-2">
        <Card title="Planned production by week (units)" pad={false}>
          <div className="table-wrap">
            <table className="table grid-table">
              <thead>{head}</thead>
              <tbody>
                {data.products.map((p) => (
                  <tr key={p.id}>
                    <th className="sticky-col">{p.name}</th>
                    {p.cells.map((c, i) => <td key={i} className={`num load-${c.load || ''}`}>{c.qty ? fmtNum(c.qty) : ''}</td>)}
                  </tr>
                ))}
                {!data.products.length && <tr><td colSpan={weeks.length + 1} className="empty">No open work orders in these weeks.</td></tr>}
              </tbody>
            </table>
          </div>
          <p className="note">Green = fits the work centers' hours that week · amber = over 90% · red = over capacity (move it on the Floor, add a shift or outsource).</p>
        </Card>

        <Card title="Work-center load by week" pad={false}>
          <div className="table-wrap">
            <table className="table grid-table">
              <thead>{head}</thead>
              <tbody>
                {data.workCenters.map((w) => (
                  <tr key={w.name}>
                    <th className="sticky-col">{w.name}<span className="muted small"> · {fmtNum(w.hoursPerWeek)} h/wk</span></th>
                    {w.cells.map((c, i) => (
                      <td key={i} className={`num load-${c.pct > 1 ? 'over' : c.pct > 0.9 ? 'near' : c.hours ? 'ok' : ''}`} title={`${fmtNum(c.hours)} h`}>
                        {c.hours ? fmtPct(c.pct) : ''}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="note">Hours of operations not done yet, spread over their working days, as a share of each work center's week (Admin: hours per day × 5).</p>
        </Card>
      </div>

      <Card title="Materials · projected balance by week" pad={false}>
        <div className="table-wrap">
          <table className="table grid-table">
            <thead>{head}</thead>
            <tbody>
              {data.materials.map((m) => (
                <tr key={m.id} className={m.short ? 'row-short' : ''}>
                  <th className="sticky-col">{m.name}</th>
                  {m.cells.map((v, i) => <td key={i} className={`num ${v < -1e-6 ? 'bad strong' : ''}`}>{fmtNum(v)}</td>)}
                </tr>
              ))}
              {!data.materials.length && <tr><td colSpan={weeks.length + 1} className="empty">No material is needed or on order in these weeks.</td></tr>}
            </tbody>
          </table>
        </div>
        <p className="note">Balance = on hand + purchase orders due that week − what the work orders starting that week use. Red = short.</p>
      </Card>

      <Card title="To order" actions={<span className="muted">
        {data.toOrder.length
          ? `${data.poCount} purchase order${data.poCount === 1 ? '' : 's'} would cover every shortfall · ${fmtMoney(data.toOrderTotal)} · ${data.toOrder.length} material${data.toOrder.length === 1 ? '' : 's'}`
          : `Nothing to order: the open work orders are covered for the next ${weeks.length} weeks`}
      </span>} pad={false}>
        {data.toOrder.length > 0 && (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Material</th><th>Supplier</th><th className="num">Qty</th><th>Unit</th><th className="num">Unit cost</th><th className="num">Cost</th><th>Arrives</th></tr></thead>
              <tbody>
                {data.toOrder.map((t) => (
                  <tr key={t.id}>
                    <td>{t.name}</td>
                    <td className={t.supplier ? '' : 'bad'}>{t.supplier || '(no supplier: set one on Stock)'}</td>
                    <td className="num">{fmtNum(t.qty)}</td>
                    <td>{t.unit}</td>
                    <td className="num">{fmtMoney(t.unitCost, 2)}</td>
                    <td className="num">{fmtMoney(t.cost, 2)}</td>
                    <td>{fmtDate(t.arrives, true)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
