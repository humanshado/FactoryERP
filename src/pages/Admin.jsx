// ADMIN: settings, the lists behind every drop-down, and the data (backup, restore, sample, empty).
import { useEffect, useState } from 'react';
import { run } from '../api.js';
import { Card, Form, PageHead, askConfirm, signalChange, toast } from '../ui.jsx';
import { useApp } from '../App.jsx';

const SETTINGS_FIELDS = [
  { key: 'companyName', label: 'Company name', wide: true },
  { key: 'companyAddress', label: 'Company address', wide: true },
  { key: 'companyContact', label: 'Company contact (phone · email)', wide: true },
  { key: 'currency', label: 'Currency symbol' },
  { key: 'labourRate', label: 'Labour rate (per hour)', type: 'money' },
  { key: 'overheadPct', label: 'Overhead (% of labour)', type: 'percent' },
  { key: 'useSalesTax', label: 'Use sales tax?', type: 'select', options: ['Yes', 'No'] },
  { key: 'salesTaxName', label: 'Sales tax name' },
  { key: 'taxRate', label: 'Tax rate %', type: 'percent', hint: 'New orders keep the tax of the day they are made.' },
  { key: 'planningWeeks', label: 'Planning weeks (1–8)', type: 'number' },
  { key: 'dueDays', label: 'Order due (working days)', type: 'number' },
  { key: 'pipelinePaidDays', label: 'Pipeline: paid in the last … days', type: 'number' },
  { key: 'sampleMode', label: 'Sample mode', type: 'select', options: ['Yes', 'No'], hint: 'Yes: sample dates move forward each week so the demo stays current.' },
];

function ListBox({ title, values, onChange, hint }) {
  const [txt, setTxt] = useState('');
  const add = () => {
    const v = txt.trim();
    if (v && !values.includes(v)) onChange([...values, v]);
    setTxt('');
  };
  return (
    <Card title={title} className="listbox">
      <ul>
        {values.map((v, i) => (
          <li key={v}>
            <span>{v}</span>
            <span className="li-tools">
              <button className="icon-btn" disabled={i === 0} onClick={() => { const x = [...values]; [x[i - 1], x[i]] = [x[i], x[i - 1]]; onChange(x); }} aria-label={`Move ${v} up`}>↑</button>
              <button className="icon-btn" onClick={() => onChange(values.filter((x) => x !== v))} aria-label={`Remove ${v}`}>✕</button>
            </span>
          </li>
        ))}
      </ul>
      <div className="add-row">
        <input value={txt} onChange={(e) => setTxt(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add()} placeholder="Add…" aria-label={`Add to ${title}`} />
        <button className="btn btn-small" onClick={add}>Add</button>
      </div>
      {hint && <p className="note">{hint}</p>}
    </Card>
  );
}

export default function Admin() {
  const { settings, reload, can, database } = useApp();
  const editable = can('settings.edit');
  const [s, setS] = useState(null);
  useEffect(() => {
    setS({ ...settings, workCenters: (settings.workCenters || []).map((w) => ({ ...w, _orig: w.name })) });
  }, [settings]);
  if (!s) return null;
  const dirty = JSON.stringify(s.workCenters.map(({ _orig, ...w }) => w)) !== JSON.stringify(settings.workCenters)
    || SETTINGS_FIELDS.some((f) => s[f.key] !== settings[f.key])
    || ['itemCategories', 'units', 'payMethods', 'itemTypes', 'roles', 'moneyCategories', 'adjustReasons'].some((k) => JSON.stringify(s[k]) !== JSON.stringify(settings[k]));

  const save = async () => {
    const renames = { workCenters: {} };
    for (const w of s.workCenters) if (w._orig && w._orig !== w.name) renames.workCenters[w._orig] = w.name;
    const body = { ...s, workCenters: s.workCenters.filter((w) => w.name.trim()).map(({ _orig, ...w }) => ({ name: w.name.trim(), hoursPerDay: Number(w.hoursPerDay) || 8 })), renames };
    if (await run('PUT', '/settings', body)) {
      await reload();
      signalChange();
    }
  };
  const setList = (k) => (v) => setS({ ...s, [k]: v });
  const wcSet = (i, patch) => setS({ ...s, workCenters: s.workCenters.map((w, j) => (j === i ? { ...w, ...patch } : w)) });

  const restore = (e) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    const r = new FileReader();
    r.onload = async () => {
      let json;
      try {
        json = JSON.parse(r.result);
      } catch {
        toast('That file is not a FactoryERP backup.', 'error');
        return;
      }
      if (!(await askConfirm('Restore this backup? Everything now in FactoryERP is replaced.', { ok: 'Restore', cancel: 'Cancel', danger: true }))) return;
      if (await run('POST', '/restore', json)) {
        await reload();
        signalChange();
      }
    };
    r.readAsText(f);
  };
  const reset = async (mode) => {
    const q = mode === 'empty'
      ? 'Start an empty company? Every record is deleted (download a backup first).'
      : 'Load the sample data? Everything now in FactoryERP is replaced by the sample company.';
    if (!(await askConfirm(q, { ok: mode === 'empty' ? 'Start empty' : 'Load sample', cancel: 'Cancel', danger: true }))) return;
    if (await run('POST', '/reset', { mode })) {
      await reload();
      signalChange();
    }
  };

  return (
    <div className="page">
      <PageHead title="Admin" sub="Settings and lists · change them here, every drop-down follows">
        {editable ? <button className="btn btn-primary" disabled={!dirty} onClick={save}>Save settings</button> : <span className="muted">Read only: only an administrator changes settings.</span>}
      </PageHead>
      <div className="grid-2">
        <Card title="Settings"><fieldset className="plain" disabled={!editable}><Form fields={SETTINGS_FIELDS} value={s} onChange={setS} /></fieldset></Card>
        <div className="stack">
          <Card title="Work centers" pad={false} className={editable ? '' : 'ro'}>
            <div className="lines">
            <table className="table lines-table">
              <thead><tr><th>Work center</th><th className="num">Hours per day</th><th /></tr></thead>
              <tbody>
                {s.workCenters.map((w, i) => (
                  <tr key={i}>
                    <td><input value={w.name} onChange={(e) => wcSet(i, { name: e.target.value })} aria-label="Work center name" /></td>
                    <td><input type="number" className="num" value={w.hoursPerDay} onChange={(e) => wcSet(i, { hoursPerDay: Number(e.target.value) })} aria-label="Hours per day" /></td>
                    <td><button className="icon-btn" onClick={() => setS({ ...s, workCenters: s.workCenters.filter((_, j) => j !== i) })} aria-label={`Remove ${w.name}`}>✕</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
            <div className="add-row pad"><button className="btn btn-small" onClick={() => setS({ ...s, workCenters: [...s.workCenters, { name: '', hoursPerDay: 8 }] })}>+ Add work center</button></div>
            <p className="note">Hours per day = the capacity of the work center (8 = one shift; 16 = two people or two shifts). A rename follows into routings, operations and people.</p>
          </Card>
          {can('data.manage') && <Card title="Data">
            <div className="btn-col">
              <a className="btn" href="/api/backup" download>Download a backup (JSON)</a>
              <label className="btn">Restore a backup… <input type="file" accept="application/json,.json" hidden onChange={restore} /></label>
              <button className="btn" onClick={() => reset('sample')}>Load the sample data</button>
              <button className="btn btn-ghost-danger" onClick={() => reset('empty')}>Start an empty company</button>
            </div>
            <p className="note">Database: <b>{database === 'postgres' ? 'PostgreSQL' : 'SQLite file'}</b>. Users and the audit log are kept when data is replaced.</p>
            <p className="note">Have your own Excel workbook? <code>python3 tools/import_xlsm.py your.xlsm server/seed/sample.json</code>, then load the sample data.</p>
          </Card>}
        </div>
      </div>
      <fieldset className="plain lists" disabled={!editable}>
        <ListBox title="Item types" values={s.itemTypes || []} onChange={setList('itemTypes')} hint="Finished = made here (BOM + routing). Perishable items have an expiry date." />
        <ListBox title="Item categories" values={s.itemCategories || []} onChange={setList('itemCategories')} />
        <ListBox title="Units" values={s.units || []} onChange={setList('units')} />
        <ListBox title="Pay methods" values={s.payMethods || []} onChange={setList('payMethods')} />
        <ListBox title="Job roles" values={s.roles || []} onChange={setList('roles')} hint="Job titles on People (sign-in roles are on Users)." />
        <ListBox title="Stock adjustment reasons" values={s.adjustReasons || []} onChange={setList('adjustReasons')} />
        <Card title="Money categories" className="listbox">
          <ul>
            {(s.moneyCategories || []).map((c, i) => (
              <li key={i}>
                <input value={c.name} onChange={(e) => setS({ ...s, moneyCategories: s.moneyCategories.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)) })} aria-label="Category name" />
                <select value={c.direction} onChange={(e) => setS({ ...s, moneyCategories: s.moneyCategories.map((x, j) => (j === i ? { ...x, direction: e.target.value } : x)) })} aria-label="Direction">
                  <option>In</option><option>Out</option>
                </select>
                <button className="icon-btn" onClick={() => setS({ ...s, moneyCategories: s.moneyCategories.filter((_, j) => j !== i) })} aria-label={`Remove ${c.name}`}>✕</button>
              </li>
            ))}
          </ul>
          <div className="add-row"><button className="btn btn-small" onClick={() => setS({ ...s, moneyCategories: [...(s.moneyCategories || []), { name: 'New category', direction: 'Out' }] })}>+ Add category</button></div>
        </Card>
      </fieldset>
    </div>
  );
}

