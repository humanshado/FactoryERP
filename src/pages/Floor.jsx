// FLOOR: the day's numbers and the production board (work centers x the next 10 working days).
// Drag a bar (or use the arrows) to move an operation; its work order starts with its first operation.
import { useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { run } from '../api.js';
import { addDays, monday, workdayAt } from '../../shared/dates.js';
import { Badge, Card, Kpi, Loading, PageHead, fmtDate, fmtDay, fmtMoney, fmtNum, fmtPct, signalChange, useData } from '../ui.jsx';
import { useApp } from '../App.jsx';

const LEGEND = [
  ['ontrack', 'on track'], ['scheduled', 'scheduled'], ['late', 'rush / late'], ['waiting', 'waiting for material'], ['done', 'done'],
];

export function KpiStrip({ k }) {
  return (
    <div className="kpis">
      <Kpi label="On-time (30 days)" value={k.onTime === null ? '–' : fmtPct(k.onTime)} sub={k.onTimeSub} tone={k.onTime !== null && k.onTime < 0.9 ? 'warn' : null} />
      <Kpi label="Open orders" value={k.open} sub={`${fmtMoney(k.openValue)} to build and ship`} />
      <Kpi label="In production" value={k.inProd} sub={k.inProdSub} />
      <Kpi label="Material shortages" value={k.short} sub={k.shortSub} tone={k.short ? 'bad' : 'good'} />
      <Kpi label="Stock value" value={fmtMoney(k.stock)} sub={`raw ${fmtMoney(k.stockRaw)} · finished ${fmtMoney(k.stockFG)}`} />
      <Kpi label="Gross margin (month)" value={k.gm === null ? '–' : fmtPct(k.gm, 1)} sub={`on ${fmtMoney(k.sales)} invoiced this month`} />
    </div>
  );
}

export default function Floor() {
  const { today, can } = useApp();
  const movable = can('workorders.edit');
  const [params, setParams] = useSearchParams();
  const week = params.get('week') || monday(today);
  const [data, , error] = useData(`/floor?week=${week}`);
  const [sel, setSel] = useState(null);
  const drag = useRef(null);
  const nav = useNavigate();
  if (!data) return <Loading error={error} />;
  const { board: B, kpis } = data;
  const setWeek = (w) => setParams(w === monday(today) ? {} : { week: w });
  const selBar = sel && B.lanes.flatMap((l) => l.bars.map((b) => ({ ...b, lane: l.name }))).find((b) => b.opId === sel);

  const move = async (bar, newIdx) => {
    const opStart = workdayAt(B.weekStart, newIdx);
    if (opStart === bar.opStart) return;
    if (await run('POST', `/operations/${bar.opId}/move`, { opStart })) signalChange();
  };
  const onDrop = (lane, dayIdx) => {
    const d = drag.current;
    drag.current = null;
    if (!d || d.lane !== lane) return;
    move(d.bar, dayIdx - d.grab);
  };

  return (
    <div className="page">
      <PageHead title="Floor" sub={`Production board · ${fmtDate(B.days[0])} – ${fmtDate(B.days[B.days.length - 1], true)}`}>
        <div className="btn-group">
          <button className="btn" onClick={() => setWeek(addDays(B.weekStart, -7))} aria-label="Previous week">‹ Prev</button>
          <button className="btn" onClick={() => setWeek(monday(today))}>This week</button>
          <button className="btn" onClick={() => setWeek(addDays(B.weekStart, 7))} aria-label="Next week">Next ›</button>
        </div>
      </PageHead>
      <KpiStrip k={kpis} />

      <div className="board-layout">
        <Card pad={false} className="board-card">
          <div className="board" style={{ '--days': B.days.length }}>
            <div className="board-row board-headrow">
              <div className="board-wc">Work center</div>
              {B.days.map((d) => <div key={d} className={`board-day ${d === today ? 'today' : ''}`}>{fmtDay(d)}</div>)}
            </div>
            {B.lanes.map((lane) => (
              <div key={lane.name} className="board-row">
                <div className="board-wc">
                  <b>{lane.name}</b>
                  <span className="muted">{fmtNum(lane.hoursPerDay)} h/day</span>
                </div>
                <div className="board-lane" style={{ gridTemplateRows: `repeat(${lane.rows}, 30px) 14px` }}>
                  {B.days.map((d, i) => (
                    <div key={d} className={`board-cell ${d === today ? 'today' : ''}`} style={{ gridColumn: i + 1, gridRow: `1 / span ${lane.rows + 1}` }}
                      onDragOver={(e) => drag.current?.lane === lane.name && e.preventDefault()} onDrop={() => onDrop(lane.name, i)} />
                  ))}
                  {lane.bars.map((b) => {
                    const s = Math.max(0, b.start);
                    const e = Math.min(B.days.length - 1, b.start + b.span - 1);
                    return (
                      <button key={b.opId} type="button"
                        className={`bar bar-${b.color} ${sel === b.opId ? 'sel' : ''} ${b.start < 0 ? 'cut-l' : ''} ${b.start + b.span > B.days.length ? 'cut-r' : ''}`}
                        style={{ gridColumn: `${s + 1} / ${e + 2}`, gridRow: b.row + 1 }}
                        draggable={movable && !b.done}
                        title={`${b.woNo} · ${b.product} × ${fmtNum(b.qty)} · ${fmtNum(b.hours)} h${b.waitingFor ? ` · waiting for ${b.waitingFor}` : ''}`}
                        onClick={() => setSel(b.opId)}
                        onDragStart={(ev) => {
                          const w = ev.currentTarget.getBoundingClientRect().width / (e - s + 1);
                          const grab = s + Math.floor(ev.nativeEvent.offsetX / w) - b.start;
                          drag.current = { bar: b, lane: lane.name, grab };
                          ev.dataTransfer.effectAllowed = 'move';
                        }}>
                        <span className="bar-no">{b.woNo}</span> <span className="bar-txt">{b.product} ×{fmtNum(b.qty)}</span>
                      </button>
                    );
                  })}
                  {lane.load.map((l, i) => (
                    <div key={`l${i}`} className={`board-load ${l.pct > 1 ? 'over' : l.pct > 0.9 ? 'near' : ''}`} style={{ gridColumn: i + 1, gridRow: lane.rows + 1 }}>
                      {l.hours ? `${fmtNum(l.hours, 1)}h` : ''}
                    </div>
                  ))}
                </div>
              </div>
            ))}
            {!B.lanes.length && <div className="empty">Add work centers on Admin to see the board.</div>}
          </div>
          <div className="legend">
            {LEGEND.map(([k, l]) => <span key={k}><i className={`dot bar-${k}`} />{l}</span>)}
            <span className="muted">{movable ? '· drag a bar to move it ' : ''}· hours under each day = load (red = over the work center's hours)</span>
          </div>
        </Card>

        <Card title={selBar ? `${selBar.woNo} · ${selBar.lane}` : 'Operation'} className="board-info">
          {!selBar && <p className="muted">Click a bar to see the operation and move it.</p>}
          {selBar && (
            <>
              <dl className="dl">
                <dt>Product</dt><dd>{selBar.product} × {fmtNum(selBar.qty)}</dd>
                <dt>Work order</dt><dd><Badge>{selBar.status}</Badge> {selBar.priority === 'Rush' && <Badge>Rush</Badge>}</dd>
                <dt>Operation</dt><dd>{fmtDate(selBar.opStart)} → {fmtDate(selBar.end)} ({selBar.days} day{selBar.days === 1 ? '' : 's'})</dd>
                <dt>Hours</dt><dd>{fmtNum(selBar.hours)} h</dd>
                <dt>Due</dt><dd className={selBar.dueDate && selBar.end > selBar.dueDate ? 'bad' : ''}>{fmtDate(selBar.dueDate, true) || '—'}</dd>
                {selBar.waitingFor && (<><dt>Waiting for</dt><dd className="bad">{selBar.waitingFor}</dd></>)}
                <dt>Done</dt><dd>{selBar.done ? 'Yes' : 'No'}</dd>
              </dl>
              {movable && !selBar.done && (
                <div className="btn-row">
                  <button className="btn" onClick={() => move(selBar, selBar.start - 1)}>◀ 1 day earlier</button>
                  <button className="btn" onClick={() => move(selBar, selBar.start + 1)}>1 day later ▶</button>
                </div>
              )}
              <button className="btn btn-primary block" onClick={() => nav(`/orders?id=${selBar.woId}`)}>Open work order</button>
            </>
          )}
        </Card>
      </div>
    </div>
  );
}
