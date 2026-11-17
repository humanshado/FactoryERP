// The workbook's standard screen: a searchable list on the left, the selected record's
// details on the right (New / Save / Delete), and an optional summary or child list.
import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { run } from './api.js';
import { Card, DataList, Form, Loading, PageHead, SearchBox, askConfirm, signalChange, useData } from './ui.jsx';

export default function MasterPage({
  table, title, sub, columns, fields, blank, nameOf, summary, below, filters, initialSort, newLabel = 'New', headActions,
}) {
  const [rows, reload, error] = useData(`/${table}`);
  const [params, setParams] = useSearchParams();
  const selectedId = params.get('id') ? Number(params.get('id')) : null;
  const [draft, setDraft] = useState(null);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState(filters ? filters.options[0].value : null);

  const selected = useMemo(() => (rows || []).find((r) => r.id === selectedId) || null, [rows, selectedId]);
  useEffect(() => {
    if (selected) setDraft({ ...selected });
    else if (!params.get('new')) setDraft(null);
  }, [selected]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!rows) return <Loading error={error} />;
  const list = filters ? rows.filter((r) => filters.test(r, filter)) : rows;
  const select = (r) => setParams(r ? { id: String(r.id) } : {});
  const isNew = draft && !draft.id;
  const dirty = draft && (isNew || JSON.stringify(draft) !== JSON.stringify(selected));

  const save = async () => {
    const out = draft.id ? await run('PUT', `/${table}/${draft.id}`, draft) : await run('POST', `/${table}`, draft);
    if (out?.record) {
      await reload();
      signalChange();
      select(out.record);
    }
  };
  const remove = async () => {
    if (!(await askConfirm(`Delete ${nameOf(draft) || 'this record'}? This cannot be undone.`, { ok: 'Delete', cancel: 'Keep', danger: true }))) return;
    if (await run('DELETE', `/${table}/${draft.id}`)) {
      select(null);
      setDraft(null);
      signalChange();
    }
  };
  const startNew = () => {
    setParams({ new: '1' });
    setDraft(blank());
  };

  return (
    <div className="page">
      <PageHead title={title} sub={sub}>
        {headActions}
        <button className="btn btn-primary" onClick={startNew}>+ {newLabel}</button>
      </PageHead>
      <div className="split">
        <Card className="list-card" pad={false}>
          <div className="list-tools">
            <SearchBox value={search} onChange={setSearch} />
            {filters && (
              <select value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter">
                {filters.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            )}
          </div>
          <DataList rows={list} columns={columns} selectedId={selectedId} onSelect={select} search={search} initialSort={initialSort} maxHeight="calc(100vh - 230px)" />
          <div className="list-foot muted">{list.length} {list.length === 1 ? 'record' : 'records'}</div>
        </Card>
        <div className="detail">
          {!draft && <div className="placeholder">Select a record in the list, or click <b>{newLabel}</b>.</div>}
          {draft && (
            <>
              <Card
                title={isNew ? newLabel : nameOf(draft) || '(no name)'}
                actions={(
                  <>
                    {!isNew && <button className="btn btn-ghost-danger" onClick={remove}>Delete</button>}
                    {isNew && <button className="btn" onClick={() => { setDraft(null); setParams({}); }}>Cancel</button>}
                    <button className="btn btn-primary" disabled={!dirty} onClick={save}>{isNew ? 'Add' : 'Save'}</button>
                  </>
                )}
              >
                <Form fields={fields(draft)} value={draft} onChange={setDraft} />
              </Card>
              {!isNew && summary && summary(selected || draft)}
              {!isNew && below && below(selected || draft)}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
