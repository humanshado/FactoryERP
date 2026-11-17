// STOCK: every item with what is on hand now (the sum of its stock movements), its cost and status;
// a made item has its Bill of Materials and Routing, which set its cost. Adjust and Count correct the stock,
// always with a reason, never by editing a number.
import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { run } from '../api.js';
import {
  Badge, Card, DataList, Field, Form, History, Input, Loading, Modal, PageHead, SearchBox, Stat, Tabs, askConfirm, fmtDate, fmtMoney, fmtMoney2,
  fmtNum, initials, signalChange, useData,
} from '../ui.jsx';
import { useApp } from '../App.jsx';

const blank = () => ({ name: '', code: '', description: '', type: 'Raw', category: null, unit: 'each', unitCost: null, price: null, openingStock: 0, reorderPoint: null, supplier: null, expiryDate: null, notes: '' });
const MOVE_LABEL = { opening: 'Opening stock', receipt: 'Received', shipment: 'Shipped', production: 'Made', issue: 'Used in production', adjustment: 'Adjustment', count: 'Stock count' };

export default function Stock() {
  const { settings, can } = useApp();
  const editable = can('items.edit');
  const [data, reload, error] = useData('/stock');
  const [suppliers] = useData('/suppliers');
  const [params, setParams] = useSearchParams();
  const [search, setSearch] = useState('');
  const [type, setType] = useState('All');
  const [show, setShow] = useState('active');
  const [tab, setTab] = useState('details');
  const [draft, setDraft] = useState(null);
  const [adjust, setAdjust] = useState(false);
  const id = params.get('id') ? Number(params.get('id')) : null;
  const item = data?.items.find((i) => i.id === id) || null;
  useEffect(() => {
    if (item) setDraft({ ...item });
    else if (!params.get('new')) setDraft(null);
  }, [item]); // eslint-disable-line react-hooks/exhaustive-deps

  const stockOf = useMemo(() => new Map((data?.stock || []).map((s) => [s.id, s])), [data]);
  if (!data) return <Loading error={error} />;
  const rows = data.items
    .filter((i) => type === 'All' || i.type === type)
    .filter((i) => (show === 'all' ? true : show === 'archived' ? i.archived : !i.archived))
    .map((i) => ({ ...i, ...stockOf.get(i.id), id: i.id }));
  const cols = [
    { key: 'name', label: 'Item', render: (r) => <><b>{r.name}</b><div className="muted small">{[r.code, r.type].filter(Boolean).join(' · ')}</div></>, text: (r) => `${r.name} ${r.code || ''} ${r.type || ''} ${r.category || ''} ${r.supplier || ''}` },
    { key: 'onHand', label: 'On hand', align: 'right', render: (r) => <span className={r.onHand < 0 ? 'bad' : ''}>{fmtNum(r.onHand)} <span className="muted small">{r.unit}</span></span> },
    { key: 'cost', label: 'Cost', align: 'right', render: (r) => fmtMoney2(r.cost) },
    { key: 'status', label: 'Status', render: (r) => <Badge>{r.status}</Badge>, text: (r) => r.status },
  ];
  const select = (r) => {
    setParams(r ? { id: String(r.id) } : {});
    if (r && r.type !== 'Finished' && (tab === 'bom' || tab === 'routing')) setTab('details');
  };
  const isNew = draft && !draft.id;
  const dirty = draft && (isNew || JSON.stringify(draft) !== JSON.stringify(item));
  const save = async () => {
    const out = draft.id ? await run('PUT', `/items/${draft.id}`, draft) : await run('POST', '/items', draft);
    if (out?.record) {
      await reload();
      signalChange();
      select(out.record);
    }
  };
  const remove = async () => {
    if (!(await askConfirm(`Delete ${draft.name} with its bill of materials and routing?`, { ok: 'Delete', cancel: 'Keep', danger: true }))) return;
    if (await run('DELETE', `/items/${draft.id}`)) {
      select(null);
      signalChange();
    }
  };
  const archive = async (on) => {
    if (await run('PUT', `/items/${draft.id}`, { archived: on, rev: draft.rev })) signalChange();
  };
  const fields = [
    { key: 'name', label: 'Item name', required: true },
    { key: 'code', label: 'Item code' },
    { key: 'description', label: 'Description', wide: true },
    { key: 'type', label: 'Item type', type: 'select', options: settings.itemTypes, required: true },
    { key: 'category', label: 'Category', type: 'select', options: settings.itemCategories },
    { key: 'unit', label: 'Unit', type: 'select', options: settings.units },
    ...(draft?.type === 'Finished' ? [] : [{ key: 'unitCost', label: 'Unit cost', type: 'money' }]),
    { key: 'price', label: 'Price', type: 'money' },
    isNew
      ? { key: 'openingStock', label: 'Opening stock', type: 'number', hint: 'On hand today. After this, stock changes only by receipts, production, shipments, adjustments and counts.' }
      : { key: 'openingStock', label: 'Opening stock', type: 'number', readOnly: true, hint: 'Fixed: use Adjust stock to correct what is on hand.' },
    { key: 'reorderPoint', label: 'Reorder point', type: 'number' },
    ...(draft?.type === 'Finished' ? [] : [{ key: 'supplier', label: 'Supplier', type: 'select', options: (suppliers || []).filter((s) => !s.archived || s.name === draft?.supplier).map((s) => s.name) }]),
    ...(draft?.type === 'Perishable' ? [{ key: 'expiryDate', label: 'Expiry date', type: 'date' }] : []),
    { key: 'notes', label: 'Notes', type: 'textarea', wide: true },
  ];
  const st = item && stockOf.get(item.id);
  const bom = item ? data.bomLines.filter((b) => b.itemId === item.id) : [];
  const routing = item ? data.routingSteps.filter((r) => r.itemId === item.id) : [];
  const tabs = [{ key: 'details', label: 'Details' }, { key: 'moves', label: 'Movements' }];
  if (item?.type === 'Finished') tabs.push({ key: 'bom', label: 'Bill of materials', count: bom.length }, { key: 'routing', label: 'Routing', count: routing.length });
  if (item && can('audit.view')) tabs.push({ key: 'history', label: 'History' });

  return (
    <div className="page">
      <PageHead title="Stock" sub="Items, what is on hand, bills of materials and routings">
        {can('stock.adjust') && <Link className="btn" to="/stock/count">Stock count</Link>}
        {editable && <button className="btn btn-primary" onClick={() => { setParams({ new: '1' }); setDraft(blank()); setTab('details'); }}>+ New item</button>}
      </PageHead>
      <div className="split">
        <Card className="list-card" pad={false}>
          <div className="list-tools">
            <SearchBox value={search} onChange={setSearch} />
            <select value={type} onChange={(e) => setType(e.target.value)} aria-label="Item type">
              <option>All</option>
              {(settings.itemTypes || []).map((t) => <option key={t}>{t}</option>)}
            </select>
            <select value={show} onChange={(e) => setShow(e.target.value)} aria-label="Show">
              <option value="active">Active</option><option value="archived">Archived</option><option value="all">All</option>
            </select>
          </div>
          <DataList rows={rows} columns={cols} selectedId={id} onSelect={select} search={search} maxHeight="calc(100vh - 230px)" />
          <div className="list-foot muted">{rows.length} items · stock value {fmtMoney(rows.reduce((s, r) => s + (r.value || 0), 0))}</div>
        </Card>

        <div className="detail">
          {!draft && <div className="placeholder">Select an item in the list{editable ? <>, or click <b>New item</b></> : ''}.</div>}
          {draft && (
            <>
              {item && st && (
                <div className="item-card">
                  <ItemPicture item={item} onChanged={reload} editable={editable} />
                  <div className="item-card-main">
                    <h2>{item.name}{item.archived && <span className="badge badge-grey title-badge">Archived</span>}</h2>
                    <div className="muted">{[item.type, item.category, item.code].filter(Boolean).join(' · ')}</div>
                    <div className="muted small">{item.type === 'Finished' ? 'Made here: Bill of materials + Routing tabs' : item.supplier ? `From ${item.supplier}` : ''}</div>
                  </div>
                  <div className="item-card-side">
                    <Badge>{st.status}</Badge>
                    {can('stock.adjust') && <button className="btn btn-small" onClick={() => setAdjust(true)}>Adjust stock</button>}
                  </div>
                  <div className="item-kpis">
                    <Stat label="On hand" value={`${fmtNum(st.onHand)} ${item.unit || ''}`} />
                    <Stat label="Available" value={fmtNum(st.avail)} />
                    <Stat label="Cost" value={fmtMoney2(st.cost)} />
                    <Stat label="Value" value={fmtMoney(st.value)} />
                    {st.openPO > 0 && <Stat label="On order" value={fmtNum(st.openPO)} />}
                    {st.toOrder > 0 && <Stat label="To order" value={fmtNum(Math.ceil(st.toOrder))} />}
                  </div>
                </div>
              )}
              {!isNew && <Tabs tabs={tabs} value={tab} onChange={setTab} />}
              {tab === 'details' || isNew ? (
                <Card title={isNew ? 'New item' : 'Details'} actions={editable && (
                  <>
                    {!isNew && <button className="btn" onClick={() => archive(!draft.archived)}>{draft.archived ? 'Restore' : 'Archive'}</button>}
                    {!isNew && <button className="btn btn-ghost-danger" onClick={remove}>Delete</button>}
                    {isNew && <button className="btn" onClick={() => { setDraft(null); setParams({}); }}>Cancel</button>}
                    <button className="btn btn-primary" disabled={!dirty} onClick={save}>{isNew ? 'Add' : 'Save'}</button>
                  </>
                )}>
                  {!editable && <p className="readonly-note">Read only: your role does not change items.</p>}
                  <Form fields={fields} value={draft} onChange={setDraft} disabled={!editable} />
                  {item?.type === 'Finished' && st && (
                    <div className="cost-line">
                      Cost per unit: materials {fmtMoney2(st.matCost)} + {fmtNum(st.labourHours)} h × {fmtMoney2(settings.labourRate)} labour × (1 + {fmtNum(settings.overheadPct * 100)}% overhead)
                      {' = '}<b>{fmtMoney2(st.cost)}</b>
                      {item.price ? <> · margin <b>{fmtNum(((item.price - st.cost) / item.price) * 100, 1)}%</b></> : null}
                    </div>
                  )}
                  {!isNew && draft.updatedAt && <p className="stamp">Last changed by {draft.updatedBy} · {new Date(draft.updatedAt).toLocaleString()}</p>}
                </Card>
              ) : tab === 'moves' ? (
                <Moves item={item} />
              ) : tab === 'bom' ? (
                <Bom item={item} lines={bom} items={data.items} stockOf={stockOf} editable={editable} />
              ) : tab === 'routing' ? (
                <Routing item={item} steps={routing} settings={settings} editable={editable} />
              ) : (
                <History table="items" id={item.id} />
              )}
            </>
          )}
        </div>
      </div>
      {adjust && item && <AdjustDialog item={item} st={st} settings={settings} onClose={() => setAdjust(false)} />}
    </div>
  );
}

function AdjustDialog({ item, st, settings, onClose }) {
  const { today } = useApp();
  const reasons = settings.adjustReasons?.length ? settings.adjustReasons : ['Damaged', 'Lost', 'Found', 'Scrap', 'Correction', 'Other'];
  const [f, setF] = useState({ dir: '-', qty: null, reason: reasons[0], note: '', date: today });
  const q = (f.dir === '-' ? -1 : 1) * (f.qty || 0);
  const submit = async () => {
    if (await run('POST', '/stock/adjust', { itemId: item.id, qty: q, reason: f.reason, note: f.note, date: f.date })) {
      signalChange();
      onClose();
    }
  };
  return (
    <Modal title={`Adjust stock · ${item.name}`} onClose={onClose}>
      <div className="form-grid">
        <Field label="Take away or add">
          <select value={f.dir} onChange={(e) => setF({ ...f, dir: e.target.value })}><option value="-">Take away (−)</option><option value="+">Add (+)</option></select>
        </Field>
        <Field label={`Quantity (${item.unit || 'units'})`} required><Input f={{ key: 'qty', type: 'number' }} value={f.qty} onChange={(v) => setF({ ...f, qty: v })} /></Field>
        <Field label="Reason" required><Input f={{ key: 'reason', type: 'select', options: reasons }} value={f.reason} onChange={(v) => setF({ ...f, reason: v })} /></Field>
        <Field label="Date"><Input f={{ key: 'date', type: 'date' }} value={f.date} onChange={(v) => setF({ ...f, date: v })} /></Field>
        <Field label="Note" wide><Input f={{ key: 'note' }} value={f.note} onChange={(v) => setF({ ...f, note: v })} /></Field>
      </div>
      <p className="muted">On hand {fmtNum(st.onHand)} → <b>{fmtNum(st.onHand + q)}</b> {item.unit} · value {q < 0 ? '−' : '+'}{fmtMoney2(Math.abs(q * st.cost))}</p>
      <div className="modal-actions">
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={!f.qty || !f.reason} onClick={submit}>Post adjustment</button>
      </div>
    </Modal>
  );
}

function Moves({ item }) {
  const [rows] = useData(`/stock/moves?itemId=${item.id}`);
  if (!rows) return <Loading />;
  return (
    <Card title={`Stock movements · ${item.name}`} pad={false}>
      <div className="table-wrap" style={{ maxHeight: 520 }}>
        <table className="table compact">
          <thead><tr><th>Date</th><th>Movement</th><th>Reference</th><th className="num">In / out</th><th className="num">Balance</th><th>By</th></tr></thead>
          <tbody>
            {rows.map((m) => (
              <tr key={m.id}>
                <td className="nowrap">{fmtDate(m.moveDate, true)}</td>
                <td>{MOVE_LABEL[m.type] || m.type}{m.note && m.type !== 'opening' ? <span className="muted small"> · {m.note}</span> : ''}</td>
                <td>{m.orderId ? <Link to={`/orders?id=${m.orderId}`}>{m.refNo}</Link> : m.refNo}</td>
                <td className={`num ${m.qty < 0 ? 'bad' : 'good'}`}>{m.qty > 0 ? '+' : ''}{fmtNum(m.qty, 4)}</td>
                <td className="num">{fmtNum(m.balance, 4)}</td>
                <td className="muted small">{m.createdBy}</td>
              </tr>
            ))}
            {!rows.length && <tr><td colSpan={6} className="empty">No movements yet.</td></tr>}
          </tbody>
        </table>
      </div>
      <p className="note">On hand is the sum of these movements. They are never edited or deleted: a correction is a new adjustment.</p>
    </Card>
  );
}

function ItemPicture({ item, onChanged, editable }) {
  const upload = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const img = new Image();
    img.onload = async () => {
      const max = 320;
      const k = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * k);
      c.height = Math.round(img.height * k);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      if (await run('PUT', `/items/${item.id}`, { picture: c.toDataURL('image/jpeg', 0.85) })) onChanged();
      URL.revokeObjectURL(img.src);
    };
    img.src = URL.createObjectURL(file);
  };
  const clear = async () => {
    if (await run('PUT', `/items/${item.id}`, { picture: null })) onChanged();
  };
  const has = item.picture?.startsWith('data:');
  return (
    <div className="pic">
      {has ? <img src={item.picture} alt={item.name} /> : <span className="pic-initials">{initials(item.name)}</span>}
      {editable && (
        <label className="pic-btn" title="Add a picture">
          <input type="file" accept="image/*" onChange={upload} hidden />
          {has ? 'Change' : 'Add picture'}
        </label>
      )}
      {editable && has && <button className="pic-btn pic-del" onClick={clear} aria-label="Remove picture">✕</button>}
    </div>
  );
}

function Bom({ item, lines, items, stockOf, editable }) {
  const [nw, setNw] = useState({ material: '', qtyPerUnit: 1 });
  const mats = items.filter((i) => i.type !== 'Finished' && i.id !== item.id && !i.archived);
  const costOf = (name) => {
    const it = items.find((i) => i.name === name);
    return it ? stockOf.get(it.id)?.cost || 0 : 0;
  };
  const add = async () => {
    if (await run('POST', '/bomLines', { itemId: item.id, ...nw })) {
      setNw({ material: '', qtyPerUnit: 1 });
      signalChange();
    }
  };
  const upd = async (l, patch) => (await run('PUT', `/bomLines/${l.id}`, patch)) && signalChange();
  const del = async (l) => (await run('DELETE', `/bomLines/${l.id}`)) && signalChange();
  const total = lines.reduce((s, l) => s + (l.qtyPerUnit || 0) * costOf(l.material), 0);
  return (
    <Card title={`Bill of materials · ${item.name}`} pad={false}>
      <div className="lines">
        <table className="table lines-table">
          <thead><tr><th>Material</th><th className="num">Qty per unit</th><th className="num">Unit cost</th><th className="num">Line cost</th><th /></tr></thead>
          <tbody>
            {lines.map((l) => (
              <tr key={`${l.id}|${l.qtyPerUnit}|${l.material}`}>
                <td>
                  <select defaultValue={l.material} disabled={!editable} onChange={(e) => upd(l, { material: e.target.value })} aria-label="Material">
                    {!mats.some((m) => m.name === l.material) && <option>{l.material}</option>}
                    {mats.map((m) => <option key={m.id}>{m.name}</option>)}
                  </select>
                </td>
                <td><input type="number" className="num" step="any" disabled={!editable} defaultValue={l.qtyPerUnit} onBlur={(e) => Number(e.target.value) !== l.qtyPerUnit && upd(l, { qtyPerUnit: Number(e.target.value) })} aria-label="Qty per unit" /></td>
                <td className="num">{fmtMoney2(costOf(l.material))}</td>
                <td className="num">{fmtMoney2((l.qtyPerUnit || 0) * costOf(l.material))}</td>
                <td>{editable && <button className="icon-btn" onClick={() => del(l)} aria-label="Remove material">✕</button>}</td>
              </tr>
            ))}
            {editable && (
              <tr className="new-line">
                <td>
                  <select value={nw.material} onChange={(e) => setNw({ ...nw, material: e.target.value })} aria-label="New material">
                    <option value="">+ Add a material…</option>
                    {mats.map((m) => <option key={m.id}>{m.name}</option>)}
                  </select>
                </td>
                <td><input type="number" className="num" step="any" value={nw.qtyPerUnit ?? ''} onChange={(e) => setNw({ ...nw, qtyPerUnit: Number(e.target.value) })} aria-label="Qty per unit" /></td>
                <td /><td />
                <td><button className="btn btn-small btn-primary" disabled={!nw.material} onClick={add}>Add</button></td>
              </tr>
            )}
          </tbody>
          <tfoot><tr><th colSpan={3}>Materials per unit</th><th className="num">{fmtMoney2(total)}</th><th /></tr></tfoot>
        </table>
      </div>
    </Card>
  );
}

function Routing({ item, steps, settings, editable }) {
  const wcs = (settings.workCenters || []).map((w) => w.name);
  const [nw, setNw] = useState({ workCenter: wcs[0] || '', hoursPerUnit: 1 });
  const add = async () => (await run('POST', '/routingSteps', { itemId: item.id, ...nw })) && signalChange();
  const upd = async (s, patch) => (await run('PUT', `/routingSteps/${s.id}`, patch)) && signalChange();
  const del = async (s) => (await run('DELETE', `/routingSteps/${s.id}`)) && signalChange();
  const hrs = steps.reduce((s, x) => s + (x.hoursPerUnit || 0), 0);
  return (
    <Card title={`Routing · ${item.name}`} pad={false}>
      <div className="lines">
        <table className="table lines-table">
          <thead><tr><th>#</th><th>Work center</th><th className="num">Hours per unit</th><th className="num">Labour + overhead</th><th /></tr></thead>
          <tbody>
            {steps.map((s, i) => (
              <tr key={`${s.id}|${s.hoursPerUnit}|${s.workCenter}`}>
                <td>{i + 1}</td>
                <td>
                  <select defaultValue={s.workCenter} disabled={!editable} onChange={(e) => upd(s, { workCenter: e.target.value })} aria-label="Work center">
                    {!wcs.includes(s.workCenter) && <option>{s.workCenter}</option>}
                    {wcs.map((w) => <option key={w}>{w}</option>)}
                  </select>
                </td>
                <td><input type="number" className="num" step="any" disabled={!editable} defaultValue={s.hoursPerUnit} onBlur={(e) => Number(e.target.value) !== s.hoursPerUnit && upd(s, { hoursPerUnit: Number(e.target.value) })} aria-label="Hours per unit" /></td>
                <td className="num">{fmtMoney2((s.hoursPerUnit || 0) * settings.labourRate * (1 + settings.overheadPct))}</td>
                <td>{editable && <button className="icon-btn" onClick={() => del(s)} aria-label="Remove step">✕</button>}</td>
              </tr>
            ))}
            {editable && (
              <tr className="new-line">
                <td />
                <td>
                  <select value={nw.workCenter} onChange={(e) => setNw({ ...nw, workCenter: e.target.value })} aria-label="New step work center">
                    {wcs.map((w) => <option key={w}>{w}</option>)}
                  </select>
                </td>
                <td><input type="number" className="num" step="any" value={nw.hoursPerUnit ?? ''} onChange={(e) => setNw({ ...nw, hoursPerUnit: Number(e.target.value) })} aria-label="Hours per unit" /></td>
                <td />
                <td><button className="btn btn-small btn-primary" disabled={!nw.workCenter} onClick={add}>Add</button></td>
              </tr>
            )}
          </tbody>
          <tfoot><tr><th colSpan={2}>Hours per unit</th><th className="num">{fmtNum(hrs)}</th><th className="num">{fmtMoney2(hrs * settings.labourRate * (1 + settings.overheadPct))}</th><th /></tr></tfoot>
        </table>
      </div>
      <p className="note">Work orders get one operation per step, in this order. Days = hours × quantity ÷ the work center's hours per day (Admin).</p>
    </Card>
  );
}
