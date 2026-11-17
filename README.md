# FactoryERP

A manufacturing ERP as a web app, rebuilt from the *Manufacturing ERP* Excel workbook
(`Manufacturing_ERP.xlsm`). It keeps the workbook's screens, its data and its rules
(the VBA engine was ported line by line), and runs in any browser.

| Screen | What it does |
| --- | --- |
| **Floor** | Six KPIs (on-time %, open orders, in production, material shortages, stock value, gross margin) and the production board: work centers × the next 10 working days. Drag a bar, or use the arrow buttons, to move an operation. |
| **Pipeline** | Order to cash: Quoted → Ordered → Materials → In production → QC & Ship → Invoiced → Paid, with the next step for every open order. |
| **Planning** | MRP for the next 8 weeks: products the work orders start each week (coloured by work-center load), work-center load, each material's projected balance, and **Create purchase orders** (one per supplier for every shortfall). |
| **Orders** | Quotes, invoices, work orders and purchase orders. Each type has its own **next step** buttons, described below. Every order prints or saves as a PDF. |
| **Stock** | Items with on hand, available, cost and status (OK / Low / Short / Expiring / Made). Made items have a **bill of materials** and a **routing** that set their cost. Items can have a picture. |
| **Customers / Suppliers** | Contact details, a summary (open orders, unpaid invoices, paid to date…) and every order. |
| **Ledger** | Money in and out. Payments recorded on orders land here. Shows this month's totals. |
| **People** | Employees and their time entries. |
| **Reports** | Profit & loss by month (cash basis) and monthly hours with overtime and labour cost. |
| **Admin** | Company, labour rate, overhead, tax, planning settings, every drop-down list, and the data tools (backup, restore, sample data, empty company). |

### The workflow (Orders › Next step)

- **Quote:** *Make invoice* creates the customer's order with the quote's lines and marks the quote Accepted. *Make work orders* creates one work order per product you make, with operations from its routing. An open quote past its *Valid until* date becomes Expired.
- **Invoice:** follows its work orders. It becomes In production once one is released, and ships by itself when all are done. Its status then follows the payments: Unpaid → Part paid → Paid.
- **Work order:** *Schedule* → *Release* (checks the materials) → *Start* → *Complete*. Complete brings in the finished goods, uses up the materials, and logs hours for the people of each work center.
- **Purchase order:** *Receive* brings the stock in.
- **Record payment** (invoice or PO) adds a Ledger row with the order number. An invoice can be paid in parts, and a payment made before it ships counts as a deposit.

### How the numbers are worked out (`shared/engine.js`)

- **On hand** = opening stock + received POs + made (done work orders) − used (done work orders × BOM) − shipped (shipped invoices)
- **Cost** of a made item = materials + routing hours × labour rate × (1 + overhead %); a bought item's cost is its unit cost
- **Waiting for material:** open work orders, those in progress first and then by start date, use up what is on hand. A Planned or Released one that finds a material short is waiting.
- **To order** = what the planning weeks need − on hand − every open PO, so creating purchase orders never orders twice
- Every order keeps the tax rate it was made with, so changing the tax in Admin never re-prices old orders.

## Run it

You need **Node.js 22.5 or newer** (it uses Node's built-in SQLite, so there is nothing native to compile).

```bash
npm install
```

```bash
npm run build
```

```bash
npm start
```

Then open <http://localhost:3000>. The first start creates `data/factoryerp.db` with the workbook's sample company, *Copperline PC Works*.

In **Sample mode** (Admin), the sample dates move forward in whole weeks so the demo always looks current, as the workbook does. To use FactoryERP for real, go to Admin › Data › *Start an empty company* and set Sample mode to No.

For development, `npm run dev` runs the API with auto-restart and the Vite dev server on <http://localhost:5173>.

| Command | |
| --- | --- |
| `npm test` | Engine and workflow tests (quote to cash, MRP, Floor moves, the HTTP API) |
| `npm run reset-db` | Reload the sample data (`-- --empty` for an empty company) |
| `PORT=8080 npm start` | Another port |
| `FACTORYERP_DB=/path/to.db npm start` | Another database file |

## Import your own workbook

```bash
pip install openpyxl
```

```bash
python3 tools/import_xlsm.py path/to/Manufacturing_ERP.xlsm server/seed/sample.json
```

```bash
npm run reset-db
```

The importer reads every *… DB* sheet and the lists and settings on the Admin sheet. Item pictures embedded in the workbook are not imported; add them on Stock.

## Layout

```
server/      Express API (index.js), workflow actions (actions.js), SQLite store (db.js), seeding (seed.js)
shared/      the engine and date helpers, used by the server and the browser
src/         React screens (pages/), shared UI (ui.jsx), styles
tools/       import_xlsm.py: Excel workbook → seed JSON
test/        node:test suites
```

Backups are plain JSON (Admin › Data). Restoring one replaces everything.
