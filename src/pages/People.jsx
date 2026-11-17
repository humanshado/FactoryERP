// PEOPLE: employees and their time entries (Complete on a work order logs hours for its work centers' people).
import { useState } from 'react';
import { Link } from 'react-router-dom';
import MasterPage from '../MasterPage.jsx';
import { run } from '../api.js';
import { Card, Field, Input, fmtDate, fmtMoney2, fmtNum, signalChange, useData } from '../ui.jsx';
import { useApp } from '../App.jsx';

function TimeEntries({ emp }) {
  const { today } = useApp();
  const [all] = useData('/timeEntries');
  const [orders] = useData('/orders');
  const [nw, setNw] = useState({ workDate: today, woNo: null, hours: 8, notes: '' });
  const rows = (all || []).filter((t) => t.employeeId === emp.id).sort((a, b) => b.workDate.localeCompare(a.workDate) || b.id - a.id);
  const woNos = (orders || []).filter((o) => o.type === 'Work Order' && o.status !== 'Done').map((o) => o.orderNo);
  const woId = new Map((orders || []).map((o) => [o.orderNo, o.id]));
  const add = async () => {
    if (await run('POST', '/timeEntries', { ...nw, employeeId: emp.id })) {
      setNw({ ...nw, notes: '' });
      signalChange();
    }
  };
  const del = async (t) => (await run('DELETE', `/timeEntries/${t.id}`)) && signalChange();
  const last30 = rows.filter((t) => t.workDate > new Date(Date.parse(today) - 30 * 864e5).toISOString().slice(0, 10)).reduce((s, t) => s + (t.hours || 0), 0);
  return (
    <Card title={`Time entries · ${fmtNum(last30)} h in the last 30 days`}>
      <div className="form-grid four">
        <Field label="Work date" required><Input f={{ key: 'workDate', type: 'date' }} value={nw.workDate} onChange={(v) => setNw({ ...nw, workDate: v })} /></Field>
        <Field label="WO No"><Input f={{ key: 'woNo', type: 'select', options: woNos, placeholder: 'none' }} value={nw.woNo} onChange={(v) => setNw({ ...nw, woNo: v })} /></Field>
        <Field label="Hours" required><Input f={{ key: 'hours', type: 'number' }} value={nw.hours} onChange={(v) => setNw({ ...nw, hours: v })} /></Field>
        <Field label="Notes"><Input f={{ key: 'notes' }} value={nw.notes} onChange={(v) => setNw({ ...nw, notes: v })} /></Field>
      </div>
      <div className="btn-row"><button className="btn btn-primary" onClick={add}>Add time entry</button></div>
      <div className="table-wrap" style={{ maxHeight: 360 }}>
        <table className="table compact">
          <thead><tr><th>Work date</th><th>WO No</th><th className="num">Hours</th><th>Notes</th><th /></tr></thead>
          <tbody>
            {rows.map((t) => (
              <tr key={t.id}>
                <td>{fmtDate(t.workDate, true)}</td>
                <td>{t.woNo && woId.has(t.woNo) ? <Link to={`/orders?id=${woId.get(t.woNo)}`}>{t.woNo}</Link> : t.woNo}</td>
                <td className="num">{fmtNum(t.hours)}</td>
                <td>{t.notes}</td>
                <td><button className="icon-btn" onClick={() => del(t)} aria-label="Remove time entry">✕</button></td>
              </tr>
            ))}
            {!rows.length && <tr><td colSpan={5} className="empty">No time entries yet.</td></tr>}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

export default function People() {
  const { settings, today } = useApp();
  const fields = () => [
    { key: 'name', label: 'Employee name', required: true },
    { key: 'role', label: 'Role', type: 'select', options: settings.roles || [] },
    { key: 'workCenter', label: 'Work center', type: 'select', options: (settings.workCenters || []).map((w) => w.name), hint: 'Complete logs this person’s hours for operations here.' },
    { key: 'hourlyRate', label: 'Hourly rate', type: 'money' },
    { key: 'startDate', label: 'Start date', type: 'date' },
    { key: 'phone', label: 'Phone', inputType: 'tel' },
    { key: 'notes', label: 'Notes', type: 'textarea', wide: true },
  ];
  return (
    <MasterPage
      table="employees" title="People" sub="Employees and their hours" newLabel="New employee" nameOf={(r) => r.name}
      columns={[
        { key: 'name', label: 'Employee', render: (r) => <b>{r.name}</b> },
        { key: 'role', label: 'Role' },
        { key: 'workCenter', label: 'Work center' },
        { key: 'hourlyRate', label: 'Rate', align: 'right', render: (r) => fmtMoney2(r.hourlyRate) },
      ]}
      fields={fields} blank={() => ({ name: '', startDate: today })}
      below={(e) => <TimeEntries emp={e} />}
    />
  );
}
