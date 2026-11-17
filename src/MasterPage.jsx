// The workbook's standard screen: a searchable list on the left, the selected record's
// details on the right, a summary or child list below, and the record's history.
// Without the permission the form is read-only. A used record is archived instead of deleted.
import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { run } from './api.js';
import { Card, DataList, Form, History, Loading, PageHead, SearchBox, askConfirm, signalChange, useData } from './ui.jsx';
import { useApp } from './App.jsx';

export default function MasterPage({
  table, title, sub, columns, fields, blank, nameOf, summary, below, filters, initialSort, newLabel = 'New', headActions,
  perm, archivable = false, recordActions, readOnlyWhen, deletable = true,
}) {
  const { can } = useApp();
  const editable = !perm || can(perm);
  const [rows, reload, error] = useData(`/${table}`);
  const [params, setParams] = useSearchParams();
  const selectedId = params.get('id') ? Number(params.get('id')) : null;
  const [draft, setDraft] = useState(null);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState(filters ? filters.options[0].value : null);
  const [show, setShow] = useState('active');

  const selected = useMemo(() => (rows || []).find((r) => r.id === selectedId) || null, [rows, selectedId]);
  useEffect(() => {
    if (selected) setDraft({ ...selected });
    else if (!params.get('new')) setDraft(null);
  }, [selected]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!rows) return <Loading error={error} />;
  let list = filters ? rows.filter((r) => filters.test(r, filter)) : rows;
  if (archivable) list = list.filter((r) => (show === 'all' ? true : show === 'archived' ? r.archived : !r.archived));
  const select = (r) => setParams(r ? { id: String(r.id) } : {});
  const isNew = draft && !draft.id;
  const locked = !editable || (draft && readOnlyWhen && readOnlyWhen(draft));
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
  const archive = async (on) => {
    if (await run('PUT', `/${table}/${draft.id}`, { archived: on, rev: draft.rev })) {
      await reload();
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
        {editable && <button className="btn btn-primary" onClick={startNew}>+ {newLabel}</button>}
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
            {archivable && (
              <select value={show} onChange={(e) => setShow(e.target.value)} aria-label="Show">
                <option value="active">Active</option><option value="archived">Archived</option><option value="all">All</option>
              </select>
            )}
          </div>
          <DataList rows={list} columns={columns} selectedId={selectedId} onSelect={select} search={search} initialSort={initialSort} maxHeight="calc(100vh - 230px)" />
          <div className="list-foot muted">{list.length} {list.length === 1 ? 'record' : 'records'}</div>
        </Card>
        <div className="detail">
          {!draft && <div className="placeholder">Select a record in the list{editable ? <>, or click <b>{newLabel}</b></> : ''}.</div>}
          {draft && (
            <>
              <Card
                title={<>{isNew ? newLabel : nameOf(draft) || '(no name)'}{draft.archived && <span className="badge badge-grey title-badge">Archived</span>}</>}
                actions={editable && (
                  <>
                    {!isNew && recordActions && recordActions(draft, { reload })}
                    {!isNew && archivable && <button className="btn" onClick={() => archive(!draft.archived)}>{draft.archived ? 'Restore' : 'Archive'}</button>}
                    {!isNew && deletable && <button className="btn btn-ghost-danger" onClick={remove}>Delete</button>}
                    {isNew && <button className="btn" onClick={() => { setDraft(null); setParams({}); }}>Cancel</button>}
                    {!locked && <button className="btn btn-primary" disabled={!dirty} onClick={save}>{isNew ? 'Add' : 'Save'}</button>}
                  </>
                )}
              >
                {!editable && <p className="readonly-note">Read only: your role does not change {title.toLowerCase()}.</p>}
                <Form fields={fields(draft)} value={draft} onChange={setDraft} disabled={locked} />
                {!isNew && draft.updatedAt && <p className="stamp">Last changed by {draft.updatedBy} · {new Date(draft.updatedAt).toLocaleString()}</p>}
              </Card>
              {!isNew && summary && summary(selected || draft)}
              {!isNew && below && below(selected || draft)}
              {!isNew && can('audit.view') && <History key={draft.id} table={table} id={draft.id} />}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
