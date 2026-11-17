// STOCK COUNT: count what is on the shelves, compare with what FactoryERP says, post the differences.
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { run } from '../api.js';
import { Card, Field, Input, Loading, Modal, PageHead, SearchBox, askConfirm, fmtDate, fmtMoney2, fmtNum, signalChange, useData } from '../ui.jsx';
import { useApp } from '../App.jsx';

export default function StockCount() {
  const { settings, today, can } = useApp();
  const [data, , error] = useData('/stock');
  const [counts] = useData('/stockCounts');
  const [counted, setCounted] = useState({});
  const [search, setSearch] = useState('');
  const [cat, setCat] = useState('');
  const [hideFinished, setHideFinished] = useState(false);
  const [meta, setMeta] = useState({ date: today, note: '' });
  const [view, setView] = useState(null);
  const stockOf = useMemo(() => new Map((data?.stock || []).map((s) => [s.id, s])), [data]);
  if (!data) return <Loading error={error} />;
  const q = search.trim().toLowerCase();
  const items = data.items
    .filter((i) => !i.archived && (!cat || i.category === cat) && (!hideFinished || i.type !== 'Finished'))
    .filter((i) => !q || `${i.name} ${i.code || ''}`.toLowerCase().includes(q));
  const typed = Object.entries(counted).filter(([, v]) => v !== null && v !== '' && v !== undefined);
  const diffs = typed.map(([id, v]) => {
    const st = stockOf.get(Number(id));
    return { id: Number(id), diff: Number(v) - (st?.onHand || 0), cost: st?.cost || 0 };
  });
  const value = diffs.reduce((s, d) => s + d.diff * d.cost, 0);
  const post = async () => {
    const changed = diffs.filter((d) => Math.abs(d.diff) > 1e-9).length;
    if (!(await askConfirm(`Post this count? ${typed.length} item(s) counted, ${changed} difference(s) go to stock (${value >= 0 ? '+' : '−'}${fmtMoney2(Math.abs(value))}).`, { ok: 'Post count', cancel: 'Not yet' }))) return;
    const out = await run('POST', '/stock/count', { date: meta.date, note: meta.note, lines: typed.map(([itemId, v]) => ({ itemId: Number(itemId), counted: Number(v) })) });
    if (out) {
      setCounted({});
      signalChange();
    }
  };
  return (
    <div className="page">
      <PageHead title="Stock count" sub="Type what you count; FactoryERP posts the differences as count adjustments">
        <Link className="btn" to="/stock">‹ Stock</Link>
        {can('stock.adjust') && <button className="btn btn-primary" disabled={!typed.length} onClick={post}>Post count ({typed.length})</button>}
      </PageHead>
      <div className="grid-2 grid-2-wide">
        <Card pad={false}>
          <div className="list-tools">
            <SearchBox value={search} onChange={setSearch} />
            <select value={cat} onChange={(e) => setCat(e.target.value)} aria-label="Category">
              <option value="">Every category</option>
              {(settings.itemCategories || []).map((c) => <option key={c}>{c}</option>)}
            </select>
            <label className="check"><input type="checkbox" checked={hideFinished} onChange={(e) => setHideFinished(e.target.checked)} /> materials only</label>
          </div>
          <div className="table-wrap">
            <table className="table count-table">
              <thead><tr><th>Item</th><th className="num">System says</th><th className="num">Counted</th><th className="num">Difference</th><th className="num">Value</th></tr></thead>
              <tbody>
                {items.map((i) => {
                  const st = stockOf.get(i.id);
                  const v = counted[i.id];
                  const has = v !== undefined && v !== null && v !== '';
                  const d = has ? Number(v) - st.onHand : null;
                  return (
                    <tr key={i.id} className={has ? 'row-counted' : ''}>
                      <td><b>{i.name}</b><div className="muted small">{[i.code, i.category].filter(Boolean).join(' · ')}</div></td>
                      <td className="num">{fmtNum(st.onHand, 4)} <span className="muted small">{i.unit}</span></td>
                      <td className="num"><input type="number" step="any" className="num count-input" value={v ?? ''} disabled={!can('stock.adjust')} aria-label={`Counted ${i.name}`}
                        onChange={(e) => setCounted({ ...counted, [i.id]: e.target.value === '' ? null : e.target.value })} /></td>
                      <td className={`num ${d > 0 ? 'good' : d < 0 ? 'bad' : ''}`}>{has ? `${d > 0 ? '+' : ''}${fmtNum(d, 4)}` : ''}</td>
                      <td className="num">{has && d ? fmtMoney2(d * st.cost) : ''}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
        <div className="stack">
          <Card title="This count">
            <div className="form-grid">
              <Field label="Count date"><Input f={{ key: 'date', type: 'date' }} value={meta.date} onChange={(v) => setMeta({ ...meta, date: v })} /></Field>
              <Field label="Note"><Input f={{ key: 'note' }} value={meta.note} onChange={(v) => setMeta({ ...meta, note: v })} /></Field>
            </div>
            <p className="muted">{typed.length} counted · {diffs.filter((d) => Math.abs(d.diff) > 1e-9).length} differ · value {value >= 0 ? '+' : '−'}{fmtMoney2(Math.abs(value))}</p>
            <p className="note">Leave an item empty to skip it. Only typed quantities are posted.</p>
          </Card>
          <Card title="Past counts" pad={false}>
            <table className="table compact">
              <tbody>
                {(counts || []).slice().reverse().map((c) => (
                  <tr key={c.id} className="clickable" onClick={() => setView(c)}>
                    <td><b>{c.countNo}</b></td><td>{fmtDate(c.countDate, true)}</td><td>{(c.lines || []).length} items</td><td className="muted small">{c.createdBy}</td>
                  </tr>
                ))}
                {!(counts || []).length && <tr><td className="empty">No counts yet.</td></tr>}
              </tbody>
            </table>
          </Card>
        </div>
      </div>
      {view && (
        <Modal title={`${view.countNo} · ${fmtDate(view.countDate, true)}`} onClose={() => setView(null)} wide>
          {view.note && <p>{view.note}</p>}
          <table className="table compact">
            <thead><tr><th>Item</th><th className="num">System said</th><th className="num">Counted</th><th className="num">Difference</th></tr></thead>
            <tbody>
              {(view.lines || []).map((l) => (
                <tr key={l.itemId}><td>{l.item}</td><td className="num">{fmtNum(l.expected, 4)}</td><td className="num">{fmtNum(l.counted, 4)}</td>
                  <td className={`num ${l.diff > 0 ? 'good' : l.diff < 0 ? 'bad' : ''}`}>{l.diff ? `${l.diff > 0 ? '+' : ''}${fmtNum(l.diff, 4)}` : '—'}</td></tr>
              ))}
            </tbody>
          </table>
          <p className="muted small">Posted by {view.createdBy}</p>
        </Modal>
      )}
    </div>
  );
}
