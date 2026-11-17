// AUDIT LOG: every change, by whom, when, with the old and new values.
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { get } from '../api.js';
import { Card, Changes, Loading, PageHead, actionLabel, fmtStamp } from '../ui.jsx';
import { useApp } from '../App.jsx';

const TABLES = {
  orders: 'Orders', orderLines: 'Order lines', operations: 'Operations', items: 'Items', bomLines: 'BOM lines', routingSteps: 'Routing',
  customers: 'Customers', suppliers: 'Suppliers', moneyEntries: 'Ledger', employees: 'Employees', timeEntries: 'Time entries',
  stockCounts: 'Stock counts', users: 'Users', settings: 'Settings',
};
const LINK = { orders: (id) => `/orders?id=${id}`, items: (id) => `/stock?id=${id}`, customers: (id) => `/customers?id=${id}`, suppliers: (id) => `/suppliers?id=${id}`, moneyEntries: (id) => `/ledger?id=${id}`, employees: (id) => `/people?id=${id}` };

export default function Audit() {
  const { can } = useApp();
  const [f, setF] = useState({ table: '', q: '', action: '' });
  const [rows, setRows] = useState(null);
  const [more, setMore] = useState(false);
  const [open, setOpen] = useState(null);
  const load = async (beforeId) => {
    const p = new URLSearchParams({ limit: 100, ...(f.table ? { table: f.table } : {}), ...(f.q ? { q: f.q } : {}), ...(f.action ? { action: f.action } : {}), ...(beforeId ? { beforeId } : {}) });
    const r = await get(`/audit?${p}`);
    setRows((x) => (beforeId ? [...x, ...r] : r));
    setMore(r.length === 100);
  };
  useEffect(() => {
    if (!can('audit.view')) return undefined;
    const t = setTimeout(() => load(), 250);
    return () => clearTimeout(t);
  }, [f.table, f.q, f.action]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!can('audit.view')) return <div className="page"><PageHead title="Audit log" /><div className="placeholder">The audit log is for managers and administrators.</div></div>;
  return (
    <div className="page">
      <PageHead title="Audit log" sub="Every change: who, when, what it was and what it became" />
      <Card pad={false}>
        <div className="list-tools">
          <div className="search"><input type="search" placeholder="Search (order number, name, value…)" value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} aria-label="Search the audit log" /></div>
          <select value={f.table} onChange={(e) => setF({ ...f, table: e.target.value })} aria-label="Record type">
            <option value="">Every record type</option>
            {Object.entries(TABLES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
          <select value={f.action} onChange={(e) => setF({ ...f, action: e.target.value })} aria-label="Action">
            <option value="">Every action</option>
            {['create', 'update', 'delete', 'cancel', 'receive', 'ship', 'payment', 'complete', 'adjust', 'login', 'login-failed'].map((a) => <option key={a} value={a}>{actionLabel(a)}</option>)}
          </select>
        </div>
        {!rows ? <Loading /> : (
          <div className="table-wrap">
            <table className="table audit">
              <thead><tr><th>When</th><th>Who</th><th>What</th><th>Record</th></tr></thead>
              <tbody>
                {rows.map((a) => (
                  <tr key={a.id} className={a.changes ? 'clickable' : ''} onClick={() => a.changes && setOpen(open === a.id ? null : a.id)}>
                    <td className="nowrap">{fmtStamp(a.at)}</td>
                    <td>{a.userName}</td>
                    <td>
                      <span className={`act act-${a.action}`}>{actionLabel(a.action)}</span> {a.summary}
                      {a.changes && open !== a.id && <span className="muted small"> · {Object.keys(a.changes).length} field(s) ▸</span>}
                      {open === a.id && <Changes changes={a.changes} />}
                    </td>
                    <td className="nowrap">{a.tbl && (LINK[a.tbl] && a.recordId ? <Link to={LINK[a.tbl](a.recordId)} onClick={(e) => e.stopPropagation()}>{TABLES[a.tbl] || a.tbl} #{a.recordId}</Link> : TABLES[a.tbl] || a.tbl)}</td>
                  </tr>
                ))}
                {!rows.length && <tr><td colSpan={4} className="empty">Nothing matches.</td></tr>}
              </tbody>
            </table>
          </div>
        )}
        {more && <div className="list-foot"><button className="btn btn-small" onClick={() => load(rows[rows.length - 1].id)}>Show older</button></div>}
      </Card>
    </div>
  );
}
