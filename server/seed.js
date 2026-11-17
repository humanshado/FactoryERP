// Load the sample data (server/seed/sample.json, made from the Excel workbook by tools/import_xlsm.py)
// and, in Sample Mode, move every sample date forward in whole weeks so the data ends this week
// (weekdays stay weekdays), as the workbook's Sample_RollForward does.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store, TABLES } from './db.js';
import { migrate } from './migrate.js';
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
  adjustReasons: ['Damaged', 'Lost', 'Found', 'Scrap', 'Correction', 'Other'],
};

export const readSeed = () => JSON.parse(fs.readFileSync(SEED_FILE, 'utf8'));

/** Replace every business record with a data set (a sample or a backup). Users and the audit log stay. */
export async function loadData(store, data, what = 'Sample data loaded') {
  await store.tx(async () => {
    await store.wipe();
    for (const t of TABLES) for (const rec of data[t] || []) await store.insert(t, rec, { audit: false });
    await store.setSettings({ ...DEFAULT_SETTINGS, ...(data.settings || {}) }, { audit: false });
    await migrate(store);
    await store.audit({ action: 'load', summary: what });
  });
}

export async function startEmpty(store) {
  await store.tx(async () => {
    await store.wipe();
    await store.setSettings(DEFAULT_SETTINGS, { audit: false });
    await store.audit({ action: 'load', summary: 'Started an empty company' });
  });
}

export async function rollForward(store, today = todayIso()) {
  const s = await store.getSettings();
  if (String(s.sampleMode).toUpperCase() !== 'YES' || !s.sampleAnchor) return 0;
  const shift = 7 * Math.floor(diffDays(today, s.sampleAnchor) / 7);
  if (shift <= 0) return 0;
  await store.tx(async () => {
    await store.shiftDates(shift);
    await store.setSettings({ sampleAnchor: addDays(s.sampleAnchor, shift) }, { audit: false });
    await store.audit({ action: 'sample', summary: `Sample dates moved ${shift} days forward` });
  });
  return shift;
}

/** The database (DATABASE_URL = PostgreSQL, else the SQLite file), seeded and upgraded */
export async function openStore({ url = process.env.DATABASE_URL, file = DB_FILE, seed = true } = {}) {
  const store = await Store.open({ url, file });
  if (seed && (await store.isEmpty())) {
    if (fs.existsSync(SEED_FILE)) await loadData(store, readSeed());
    else await startEmpty(store);
  }
  await migrate(store);
  return store;
}

// npm run reset-db: start again from the sample data (or an empty company with --empty)
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const store = await openStore({ seed: false });
  if (process.argv.includes('--empty')) {
    await startEmpty(store);
    console.log('Empty company started');
  } else {
    await loadData(store, readSeed());
    const shift = await rollForward(store);
    console.log(`Sample data loaded${shift ? ` (dates moved ${shift} days forward)` : ''}`);
  }
  console.log(`Database: ${process.env.DATABASE_URL ? 'PostgreSQL (DATABASE_URL)' : DB_FILE}`);
  await store.close();
}
