// REPORTS: profit & loss by month (cash basis, from the Ledger) and monthly hours (from the time entries).
import { useState } from 'react';
import { addMonths, monthStart } from '../../shared/dates.js';
import { Card, Loading, PageHead, fmtMoney, fmtMoney2, fmtMonth, fmtNum, useData } from '../ui.jsx';
import { useApp } from '../App.jsx';

function Bars({ months, inV, outV }) {
  const max = Math.max(1, ...inV, ...outV);
  const W = 560;
  const H = 150;
  const gw = W / months.length;
  const bw = Math.min(26, gw / 3);
  return (
    <svg viewBox={`0 0 ${W} ${H + 22}`} className="chart" role="img" aria-label="Money in and out by month">
      <line x1="0" x2={W} y1={H} y2={H} className="axis" />
      {months.map((m, i) => {
        const x = i * gw + gw / 2;
        const hi = (inV[i] / max) * (H - 8);
        const ho = (outV[i] / max) * (H - 8);
        return (
          <g key={m}>
            <rect x={x - bw - 2} y={H - hi} width={bw} height={hi} rx="3" className="bar-in"><title>{`${fmtMonth(m)} in ${fmtMoney(inV[i])}`}</title></rect>
            <rect x={x + 2} y={H - ho} width={bw} height={ho} rx="3" className="bar-out"><title>{`${fmtMonth(m)} out ${fmtMoney(outV[i])}`}</title></rect>
            <text x={x} y={H + 16} textAnchor="middle" className="tick">{fmtMonth(m).slice(0, 3)}</text>
          </g>
        );
      })}
    </svg>
  );
}

export default function Reports() {
  const { today } = useApp();
  const [month, setMonth] = useState(monthStart(today));
  const [data, , error] = useData(`/reports?month=${month}`);
  if (!data) return <Loading error={error} />;
  const { pnl, hours: H } = data;
  const row = (r, cls = '') => (
    <tr key={r.name} className={cls}>
      <th>{r.name}</th>
      {r.values.map((v, i) => <td key={i} className="num">{v ? fmtMoney(v) : '–'}</td>)}
    </tr>
  );
  return (
    <div className="page">
      <PageHead title="Reports" sub="Profit & loss and labour hours" />
      <div className="grid-2 grid-2-wide">
        <Card title="Profit & loss by month" actions={<span className="muted small">money in / out, from the Ledger</span>} pad={false}>
          <div className="chart-wrap">
            <Bars months={pnl.months} inV={pnl.moneyIn.total} outV={pnl.moneyOut.total} />
            <div className="legend"><span><i className="dot dot-in" />money in</span><span><i className="dot dot-out" />money out</span></div>
          </div>
          <div className="table-wrap">
            <table className="table grid-table pnl">
              <thead><tr><th />{pnl.months.map((m) => <th key={m} className="num">{fmtMonth(m)}</th>)}</tr></thead>
              <tbody>
                <tr className="sect"><th colSpan={pnl.months.length + 1}>Money in</th></tr>
                {pnl.moneyIn.rows.map((r) => row(r))}
                {row({ name: 'Total in', values: pnl.moneyIn.total }, 'sum')}
                <tr className="sect"><th colSpan={pnl.months.length + 1}>Money out</th></tr>
                {pnl.moneyOut.rows.map((r) => row(r))}
                {row({ name: 'Total out', values: pnl.moneyOut.total }, 'sum')}
                <tr className="net">
                  <th>Net (in − out)</th>
                  {pnl.net.map((v, i) => <td key={i} className={`num ${v < 0 ? 'bad' : 'good'}`}>{fmtMoney(v)}</td>)}
                </tr>
              </tbody>
            </table>
          </div>
          <p className="note">Cash basis: what came in and went out of the bank each month. Categories come from Admin › Money categories.</p>
        </Card>

        <Card title={`Monthly hours · ${fmtMonth(H.month)}`} actions={(
          <div className="btn-group">
            <button className="btn btn-small" onClick={() => setMonth(addMonths(month, -1))} aria-label="Previous month">‹</button>
            <button className="btn btn-small" onClick={() => setMonth(monthStart(today))}>This month</button>
            <button className="btn btn-small" onClick={() => setMonth(addMonths(month, 1))} aria-label="Next month">›</button>
            <button className="btn btn-small" onClick={() => window.print()}>Print</button>
          </div>
        )} pad={false} className="printable">
          <table className="table">
            <thead><tr><th>Employee</th><th className="num">Hours</th><th className="num">Overtime</th><th className="num">Rate</th><th className="num">Labour cost</th></tr></thead>
            <tbody>
              {H.employees.map((e) => (
                <tr key={e.id}><td>{e.name}</td><td className="num">{fmtNum(e.hours)}</td><td className="num">{e.overtime ? fmtNum(e.overtime) : ''}</td><td className="num">{fmtMoney2(e.rate)}</td><td className="num">{fmtMoney2(e.cost)}</td></tr>
              ))}
            </tbody>
            <tfoot><tr><th>Total ({H.employees.length} people)</th><th className="num">{fmtNum(H.total.hours)}</th><th className="num">{fmtNum(H.total.overtime)}</th><th /><th className="num">{fmtMoney2(H.total.cost)}</th></tr></tfoot>
          </table>
          <table className="table">
            <thead><tr><th>Work center</th><th className="num">Hours</th><th className="num">Overtime</th><th className="num">Labour cost</th></tr></thead>
            <tbody>
              {H.workCenters.map((w) => (
                <tr key={w.name}><td>{w.name}</td><td className="num">{fmtNum(w.hours)}</td><td className="num">{w.overtime ? fmtNum(w.overtime) : ''}</td><td className="num">{fmtMoney2(w.cost)}</td></tr>
              ))}
              {!H.workCenters.length && <tr><td colSpan={4} className="empty">No hours this month.</td></tr>}
            </tbody>
          </table>
          <p className="note">Overtime = hours over 40 in a Monday–Sunday week (the days inside the month). Labour cost = hours × rate + overtime × rate × 0.5.</p>
        </Card>
      </div>
    </div>
  );
}
