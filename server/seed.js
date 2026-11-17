// Load the sample data (server/seed/sample.json, made from the Excel workbook by tools/import_xlsm.py)
// and, in Sample Mode, move every sample date forward in whole weeks so the data ends this week
// (weekdays stay weekdays), as the workbook's Sample_RollForward does.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SCHEMA, Store, TABLES } from './db.js';
import { addDays, diffDays, todayIso } from '../shared/dates.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const SEED_FILE = path.join(here, 'seed', 'sample.json');
export const DB_FILE = process.env.FACTORYERP_DB || path.join(here, '..', 'data', 'factoryerp.db');

export const DEFAULT_SETTINGS = {
  companyName: 'My Factory', companyAddress: '', companyContact: '', labourRate: 25, overheadPct: 0.3,
  useSalesTax: 'Yes', salesTaxName: 'Sales Tax', taxRate: 0, planningWeeks: 8, pipelinePaidDays: 30, dueDays: 15,
  currency: '$', sampleMode: 'No', sampleAnchor: null, workCenters: [], itemCategories: [], units: ['each'], payMethods: ['Bank transfer'],
  itemTypes: ['Raw', 'Finished', 'Packaging', 'Consumable', 'Perishable'],
  moneyCategories: [{ name: 'Customer payment', direction: 'In' }, { name: 'Supplier payment', direction: 'Out' }], roles: [],
};

export function loadSeed(store, seed) {
  store.tx(() => {
    store.wipe();
    for (const t of TABLES) for (const rec of seed[t] || []) store.insert(t, rec);
    store.setSettings({ ...DEFAULT_SETTINGS, ...(seed.settings || {}) });
  });
}

export function rollForward(store, today = todayIso()) {
  const s = store.getSettings();
  if (String(s.sampleMode).toUpperCase() !== 'YES' || !s.sampleAnchor) return 0;
  const shift = 7 * Math.floor(diffDays(today, s.sampleAnchor) / 7);
  if (shift <= 0) return 0;
  store.tx(() => {
    for (const [t, fields] of Object.entries(SCHEMA)) {
      for (const [f, kind] of Object.entries(fields)) {
        if (kind !== 'date') continue;
        store.db.prepare(`UPDATE "${t}" SET "${f}" = date("${f}", '+${shift} days') WHERE "${f}" IS NOT NULL`).run();
      }
    }
    store.setSettings({ sampleAnchor: addDays(s.sampleAnchor, shift) });
  });
  store.invalidate();
  return shift;
}

export function openStore(file = DB_FILE, { seed = true } = {}) {
  const store = new Store(file);
  if (seed && store.isEmpty()) {
    if (fs.existsSync(SEED_FILE)) loadSeed(store, JSON.parse(fs.readFileSync(SEED_FILE, 'utf8')));
    else store.setSettings(DEFAULT_SETTINGS);
  }
  return store;
}

// npm run reset-db: start again from the sample data (or an empty company with --empty)
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const store = new Store(DB_FILE);
  if (process.argv.includes('--empty')) {
    store.tx(() => {
      store.wipe();
      store.setSettings(DEFAULT_SETTINGS);
    });
    console.log(`Empty database: ${DB_FILE}`);
  } else {
    loadSeed(store, JSON.parse(fs.readFileSync(SEED_FILE, 'utf8')));
    const shift = rollForward(store);
    console.log(`Sample data loaded into ${DB_FILE}${shift ? ` (dates moved ${shift} days forward)` : ''}`);
  }
  store.close();
}
