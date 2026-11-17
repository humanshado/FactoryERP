import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';

// ---------------------------------------------------------------- app-wide settings (for formatting)
let SETTINGS = { currency: '$' };
export const setAppSettings = (s) => {
  SETTINGS = s || SETTINGS;
};
export const appSettings = () => SETTINGS;

// ---------------------------------------------------------------- formatting
const num = (v) => (typeof v === 'number' ? v : parseFloat(v));
export function fmtMoney(v, decimals = 0) {
  const x = num(v);
  if (!Number.isFinite(x)) return '';
  const s = Math.abs(x).toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  return `${x < 0 ? '-' : ''}${SETTINGS.currency ?? '$'}${s}`;
}
export const fmtMoney2 = (v) => fmtMoney(v, 2);
export function fmtNum(v, max = 2) {
  const x = num(v);
  if (!Number.isFinite(x)) return '';
  return x.toLocaleString('en-US', { maximumFractionDigits: max });
}
export function fmtPct(v, d = 0) {
  const x = num(v);
  return Number.isFinite(x) ? `${(x * 100).toFixed(d)}%` : '–';
}
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export function fmtDate(iso, withYear = false) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-').map(Number);
  return `${MONTHS[m - 1]} ${d}${withYear ? `, ${y}` : ''}`;
}
export function fmtDay(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return `${DAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]} ${m}/${d}`;
}
export function fmtMonth(iso) {
  const [y, m] = iso.split('-').map(Number);
  return `${MONTHS[m - 1]} ${y}`;
}

// ---------------------------------------------------------------- tiny global stores (toasts, confirm)
function createStore(initial) {
  let state = initial;
  const subs = new Set();
  return {
    get: () => state,
    set: (fn) => {
      state = typeof fn === 'function' ? fn(state) : fn;
      subs.forEach((s) => s());
    },
    subscribe: (s) => {
      subs.add(s);
      return () => subs.delete(s);
    },
  };
}
const toasts = createStore([]);
let toastId = 0;
export function toast(text, kind = 'ok') {
  const id = ++toastId;
  toasts.set((t) => [...t, { id, text, kind }]);
  setTimeout(() => toasts.set((t) => t.filter((x) => x.id !== id)), kind === 'error' || kind === 'warn' ? 6500 : 3500);
}
export function Toasts() {
  const list = useSyncExternalStore(toasts.subscribe, toasts.get);
  return (
    <div className="toasts" role="status" aria-live="polite">
      {list.map((t) => (
        <div key={t.id} className={`toast toast-${t.kind}`} onClick={() => toasts.set((x) => x.filter((y) => y.id !== t.id))}>
          {t.text}
        </div>
      ))}
    </div>
  );
}

const confirmStore = createStore(null);
export function askConfirm(text, { ok = 'Yes', cancel = 'No', danger = false } = {}) {
  return new Promise((resolve) => confirmStore.set({ text, ok, cancel, danger, resolve }));
}
export function ConfirmHost() {
  const c = useSyncExternalStore(confirmStore.subscribe, confirmStore.get);
  const okRef = useRef(null);
  useEffect(() => {
    if (c) okRef.current?.focus();
  }, [c]);
  if (!c) return null;
  const done = (v) => {
    confirmStore.set(null);
    c.resolve(v);
  };
  return (
    <div className="modal-back" onMouseDown={() => done(false)}>
      <div className="modal" role="dialog" aria-modal="true" onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.key === 'Escape' && done(false)}>
        <p>{c.text}</p>
        <div className="modal-actions">
          <button className="btn" onClick={() => done(false)}>{c.cancel}</button>
          <button ref={okRef} className={`btn ${c.danger ? 'btn-danger' : 'btn-primary'}`} onClick={() => done(true)}>{c.ok}</button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- data
/** Load a URL; reload() fetches again. Reloads on the global "changed" signal too. */
const changed = createStore(0);
export const signalChange = () => changed.set((x) => x + 1);
export function useData(url) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const tick = useSyncExternalStore(changed.subscribe, changed.get);
  const reload = useCallback(async () => {
    if (!url) return;
    try {
      const r = await fetch(`/api${url}`);
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || r.statusText);
      setData(j);
      setError(null);
    } catch (e) {
      setError(e.message);
    }
  }, [url]);
  useEffect(() => {
    reload();
  }, [reload, tick]);
  return [data, reload, error];
}

// ---------------------------------------------------------------- layout pieces
export function PageHead({ title, sub, children }) {
  return (
    <header className="page-head">
      <div>
        <h1>{title}</h1>
        {sub && <p className="muted">{sub}</p>}
      </div>
      <div className="page-head-actions">{children}</div>
    </header>
  );
}

export function Card({ title, actions, children, className = '', pad = true }) {
  return (
    <section className={`card ${className}`}>
      {(title || actions) && (
        <div className="card-head">
          {title && <h2>{title}</h2>}
          {actions && <div className="card-actions">{actions}</div>}
        </div>
      )}
      <div className={pad ? 'card-body' : ''}>{children}</div>
    </section>
  );
}

export function Loading({ error }) {
  return <div className={`loading ${error ? 'error' : ''}`}>{error || 'Loading…'}</div>;
}

const BADGE = {
  OK: 'green', Made: 'blue', Low: 'amber', Short: 'red', Expiring: 'amber',
  Open: 'blue', Accepted: 'green', Lost: 'grey', Expired: 'grey',
  Ordered: 'blue', 'In production': 'violet', Unpaid: 'amber', 'Part paid': 'amber', Paid: 'green',
  Planned: 'grey', Released: 'blue', 'In progress': 'violet', Done: 'green',
  'On order': 'blue', Received: 'green', In: 'green', Out: 'red', Rush: 'red', Normal: 'grey',
};
export function Badge({ children, tone }) {
  return <span className={`badge badge-${tone || BADGE[children] || 'grey'}`}>{children}</span>;
}

export function Kpi({ label, value, sub, tone }) {
  return (
    <div className={`kpi ${tone ? `kpi-${tone}` : ''}`}>
      <div className="kpi-label">{label}</div>
      <div className="kpi-value">{value}</div>
      {sub && <div className="kpi-sub">{sub}</div>}
    </div>
  );
}

// ---------------------------------------------------------------- forms
export function Field({ label, required, children, wide, hint }) {
  return (
    <label className={`field ${wide ? 'field-wide' : ''}`}>
      <span className="field-label">
        {label}
        {required && <b className="req"> *</b>}
      </span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}

/** One input for a field description: { key, label, type: text|number|date|select|textarea|money|percent, options } */
export function Input({ f, value, onChange, disabled }) {
  const v = value ?? '';
  const common = { disabled: disabled || f.readOnly, id: f.key, name: f.key };
  if (f.type === 'select') {
    const opts = typeof f.options === 'function' ? f.options() : f.options || [];
    const list = opts.map((o) => (typeof o === 'object' ? o : { value: o, label: o }));
    if (v !== '' && !list.some((o) => String(o.value) === String(v))) list.unshift({ value: v, label: String(v) });
    return (
      <select {...common} value={v} onChange={(e) => onChange(e.target.value === '' ? null : f.numeric ? Number(e.target.value) : e.target.value)}>
        <option value="">{f.placeholder || '—'}</option>
        {list.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    );
  }
  if (f.type === 'textarea') return <textarea {...common} rows={f.rows || 3} value={v} onChange={(e) => onChange(e.target.value)} />;
  if (f.type === 'percent') {
    return (
      <input {...common} type="number" step="0.1" value={v === '' ? '' : Math.round(v * 10000) / 100}
        onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value) / 100)} />
    );
  }
  if (f.type === 'number' || f.type === 'money') {
    return <input {...common} type="number" step={f.step || 'any'} value={v} onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))} />;
  }
  if (f.type === 'date') return <input {...common} type="date" value={v} onChange={(e) => onChange(e.target.value || null)} />;
  return <input {...common} type={f.inputType || 'text'} value={v} list={f.list} onChange={(e) => onChange(e.target.value)} />;
}

export function Form({ fields, value, onChange, disabled }) {
  return (
    <div className="form-grid">
      {fields.map((f) => (
        <Field key={f.key} label={f.label} required={f.required} wide={f.wide} hint={f.hint}>
          <Input f={f} value={value[f.key]} disabled={disabled} onChange={(v) => onChange({ ...value, [f.key]: v })} />
        </Field>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- lists
/** A searchable, sortable list. columns: [{ key, label, render?, align?, sort? }] */
export function DataList({ rows, columns, selectedId, onSelect, search, empty = 'Nothing here yet.', initialSort, maxHeight }) {
  const [sort, setSort] = useState(initialSort || null);
  const sorted = useMemo(() => {
    if (!sort) return rows;
    const col = columns.find((c) => c.key === sort.key);
    const val = col?.sort || ((r) => r[sort.key]);
    return [...rows].sort((a, b) => {
      const x = val(a);
      const y = val(b);
      if (x === y) return 0;
      if (x === null || x === undefined || x === '') return 1;
      if (y === null || y === undefined || y === '') return -1;
      const c = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), undefined, { numeric: true });
      return sort.dir === 'desc' ? -c : c;
    });
  }, [rows, sort, columns]);
  const q = (search || '').trim().toLowerCase();
  const shown = q ? sorted.filter((r) => columns.some((c) => String(c.text ? c.text(r) : r[c.key] ?? '').toLowerCase().includes(q))) : sorted;
  const clickSort = (key) => setSort((s) => (s?.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' }));
  return (
    <div className="table-wrap" style={maxHeight ? { maxHeight } : undefined}>
      <table className="table">
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.key} className={c.align === 'right' ? 'num' : ''} onClick={() => clickSort(c.key)} aria-sort={sort?.key === c.key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : undefined}>
                {c.label}
                {sort?.key === c.key && <span className="sort">{sort.dir === 'asc' ? ' ▲' : ' ▼'}</span>}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {shown.map((r) => (
            <tr key={r.id} className={`${onSelect ? 'clickable' : ''} ${r.id === selectedId ? 'selected' : ''}`} onClick={onSelect ? () => onSelect(r) : undefined}>
              {columns.map((c) => <td key={c.key} className={c.align === 'right' ? 'num' : ''}>{c.render ? c.render(r) : r[c.key]}</td>)}
            </tr>
          ))}
          {!shown.length && (
            <tr><td colSpan={columns.length} className="empty">{q ? 'No match.' : empty}</td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

export function SearchBox({ value, onChange, placeholder = 'Search…' }) {
  return (
    <div className="search">
      <input type="search" value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} aria-label="Search" />
    </div>
  );
}

export function Chips({ options, value, onChange }) {
  return (
    <div className="chips" role="tablist">
      {options.map((o) => {
        const v = typeof o === 'object' ? o.value : o;
        const l = typeof o === 'object' ? o.label : o;
        return (
          <button key={v} role="tab" aria-selected={value === v} className={`chip ${value === v ? 'on' : ''}`} onClick={() => onChange(v)}>{l}</button>
        );
      })}
    </div>
  );
}

export function Tabs({ tabs, value, onChange }) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((t) => (
        <button key={t.key} role="tab" aria-selected={value === t.key} className={`tab ${value === t.key ? 'on' : ''}`} onClick={() => onChange(t.key)}>
          {t.label}
          {t.count !== undefined && <span className="tab-count">{t.count}</span>}
        </button>
      ))}
    </div>
  );
}

export function Stat({ label, value }) {
  return (
    <div className="stat">
      <span>{label}</span>
      <b>{value}</b>
    </div>
  );
}

export function initials(name) {
  const p = String(name || '').trim().split(/\s+/);
  return ((p[0]?.[0] || '+') + (p[1]?.[0] || '')).toUpperCase();
}
