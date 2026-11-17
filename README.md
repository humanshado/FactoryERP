# FactoryERP

A manufacturing ERP as a web app, rebuilt from the *Manufacturing ERP* Excel workbook
(`Manufacturing_ERP.xlsm`). It keeps the workbook's screens, its data and its rules
(the VBA engine was ported line by line), and adds what several people need to work
in it safely: sign-in with roles, an audit trail, a stock ledger, and records that are
cancelled or voided instead of deleted.

| Screen | What it does |
| --- | --- |
| **Floor** | Six KPIs (on-time %, open orders, in production, material shortages, stock value, gross margin) and the production board: work centers × the next 10 working days. Drag a bar, or use the arrow buttons, to move an operation. |
| **Pipeline** | Order to cash: Quoted → Ordered → Materials → In production → QC & Ship → Invoiced → Paid, with the next step for every open order. |
| **Planning** | MRP for the next 8 weeks: products the work orders start each week (coloured by work-center load), work-center load, each material's projected balance, and **Create purchase orders** (one per supplier for every shortfall). |
| **Orders** | Quotes, invoices, work orders and purchase orders, each with its own **next step** buttons (described below). Receive and ship all or part of each line. Every order prints or saves as a PDF and keeps its history. |
| **Stock** | Items with on hand, available, cost and status (OK / Low / Short / Expiring / Made), and each item's **stock movements**. Made items have a **bill of materials** and a **routing** that set their cost. **Adjust stock** (with a reason) and **Stock count**. |
| **Customers / Suppliers** | Contact details, a summary (open orders, unpaid invoices, paid to date…) and every order. Archive the ones you no longer use. |
| **Ledger** | Money in and out. Payments recorded on orders land here. Entries are **voided** (they stay, struck out, with the reason), never deleted. |
| **People** | Employees and their time entries. |
| **Reports** | Profit & loss by month (cash basis) and monthly hours with overtime and labour cost. |
| **Audit log** | Every change: who, when, the old value and the new one. Also sign-ins and failed sign-ins. Each record also shows its own **History**. |
| **Users** | Who can sign in, and with which roles. |
| **Admin** | Company, labour rate, overhead, tax, planning settings, every drop-down list, and the data tools (backup, restore, sample data, empty company). |

### The workflow (Orders › Next step)

- **Quote:** *Make invoice* creates the customer's order with the quote's lines and marks the quote Accepted. *Make work orders* creates one work order per product you make, with operations from its routing. An open quote past its *Valid until* date becomes Expired.
- **Invoice:** follows its work orders. It becomes In production once one is released, and ships by itself when all are done. You can also ship it, all at once or line by line; until everything has shipped it is *Part shipped*. Once fully shipped its status follows the payments: Unpaid → Part paid → Paid.
- **Work order:** *Schedule* → *Release* (checks the materials) → *Start* → *Complete*. Complete brings in the finished goods, uses up the materials, and logs hours for the people of each work center.
- **Purchase order:** *Receive*, all at once or line by line; until everything is in it is *Part received*.
- **Record payment** (invoice or PO) adds a Ledger row with the order number. An invoice can be paid in parts, and a payment made before it ships counts as a deposit.

**Changing the status field** goes through the same steps. Setting an invoice to Unpaid ships it, setting a PO to Received receives it, and setting a work order to Done completes it. A status that would undo posted stock (a done work order back to Planned) is refused.

### Nothing disappears

| What | Rule |
| --- | --- |
| Orders | Can be **deleted** only while they are drafts: still in their first status, nothing received, shipped, made or paid, and no order made from them. After that they are **cancelled**: the order stays on file, marked Cancelled, with who cancelled it and why in its notes. |
| Cancel rules | An invoice can be cancelled only before it ships anything and while it has no payments (void them first). Cancelling it also cancels its work orders that haven't started. A partly received PO can be cancelled; what was received stays in stock. A done work order cannot be cancelled. |
| Ledger entries | **Voided**, never deleted. A voided payment leaves the invoice's paid amount, and the invoice's status follows. |
| Items, customers, suppliers, employees | **Archived** once they are used; they leave the pick lists but stay on old records. Deleted only if never used. |
| Stock | Changes only by movements: receipts, shipments, production, issues, **adjustments** (with a reason) and **counts**. On hand is the sum of the movements, and movements are never edited. |

### Roles

Everyone who signs in can see every screen. Changing things takes a role:

| Role | May change |
| --- | --- |
| Administrator | Everything, including users, settings, backup and restore |
| Manager | All the daily work, and the audit log |
| Sales | Customers, quotes, invoices, shipping, customer payments |
| Purchasing | Suppliers, purchase orders, receiving, items |
| Production | Work orders, the Floor, time entries |
| Warehouse | Receiving, shipping, stock adjustments and counts, items |
| Accounts | Payments, the Ledger, customers, suppliers, employees |
| Viewer | Nothing (looks only) |

A user can have several roles. The server checks every change, and the screens hide what a role can't do.

### Security

- Passwords are hashed with scrypt and must be at least 10 characters. Sessions are HttpOnly cookies, and only a hash of each session token is stored.
- After five wrong passwords, that user name is paused for 15 minutes from that address.
- Every changing request must carry an `X-FactoryERP` header, which a page on another site cannot add, so cross-site requests are blocked.
- Security headers are set (including a content security policy and protection against being framed).
- Changing your password signs out your other devices. Switching a user off signs them out at once.
- Two people editing the same record: the second save is refused with "changed by … since you opened it" instead of silently overwriting.
- Every write runs in one transaction, one at a time, so two clicks on *Complete* make the goods once.

### How the numbers are worked out (`shared/engine.js`)

- **On hand** = the sum of the item's stock movements. Data from before the stock ledger existed is converted on first start, from the order history: opening stock, received POs, done work orders and shipped invoices.
- **Cost** of a made item = materials + routing hours × labour rate × (1 + overhead %); a bought item's cost is its unit cost
- **Waiting for material:** open work orders, those in progress first and then by start date, use up what is on hand. A Planned or Released one that finds a material short is waiting.
- **To order** = what the planning weeks need − on hand − what open POs still bring in, so creating purchase orders never orders twice
- Every order keeps the tax rate it was made with, so changing the tax in Admin never re-prices old orders.

## Run it

You need **Node.js 22.5 or newer**.

```bash
npm install
```

```bash
npm run build
```

```bash
npm start
```

Then open <http://localhost:3000>. The first visit asks you to create the **administrator**, who then adds everyone else under **Users**. The first start loads the workbook's sample company, *Copperline PC Works*.

In **Sample mode** (Admin), the sample dates move forward in whole weeks so the demo always looks current, as the workbook does. To use FactoryERP for real, go to Admin › Data › *Start an empty company* and set Sample mode to No. Users and the audit log are kept.

### Database

Without settings, FactoryERP keeps everything in one SQLite file, `data/factoryerp.db`. That's enough for one site with a handful of users. For a server many people use, point it at **PostgreSQL**:

```bash
DATABASE_URL=postgres://user:password@host:5432/factoryerp npm start
```

The tables are created on first start. Several FactoryERP processes can share one PostgreSQL database: writes are serialised with a database lock.

### Settings (environment variables)

| Variable | |
| --- | --- |
| `PORT` | Port to listen on (default 3000) |
| `DATABASE_URL` | PostgreSQL connection string (default: the SQLite file) |
| `FACTORYERP_DB` | Path of the SQLite file |
| `FACTORYERP_ADMIN_USER`, `FACTORYERP_ADMIN_PASSWORD` | Create the first administrator on start, without the setup page (only when there are no users yet) |
| `FACTORYERP_SESSION_HOURS` | How long a sign-in lasts without use (default 12; any use in the second half extends it) |
| `FACTORYERP_SECURE_COOKIE=1` | Mark the session cookie Secure. Set this when users reach FactoryERP over HTTPS through a proxy. |
| `FACTORYERP_TRUST_PROXY` | Express `trust proxy` setting (e.g. `true` or `1`), so sign-in pauses and the audit log see the real client address behind a proxy |

**On the internet, put FactoryERP behind HTTPS** (a reverse proxy such as Caddy or nginx), and set `FACTORYERP_SECURE_COOKIE=1` and `FACTORYERP_TRUST_PROXY=1`.

### Development and tests

`npm run dev` runs the API with auto-restart and the Vite dev server on <http://localhost:5173>.

| Command | |
| --- | --- |
| `npm test` | Engine, workflow and API tests on SQLite: quote to cash, partial receipts and shipments, cancel and void, stock counts, roles, sign-in, audit, edit conflicts, concurrent clicks |
| `npm run test:pg` | The same tests on PostgreSQL (`TEST_DATABASE_URL`, default `postgres://factoryerp:factoryerp@localhost/factoryerp_test`; the tests drop and recreate its tables) |
| `npm run reset-db` | Reload the sample data (`-- --empty` for an empty company). Users and the audit log stay. |

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
server/      Express API (index.js), sign-in (auth.js), workflow actions (actions.js),
             storage for SQLite and PostgreSQL with the audit log (db.js), data upgrades (migrate.js), seeding (seed.js)
shared/      the engine, date helpers and roles/permissions, used by the server and the browser
src/         React screens (pages/), shared UI (ui.jsx), styles
tools/       import_xlsm.py: Excel workbook → seed JSON
test/        node:test suites (run on SQLite, or PostgreSQL with TEST_DATABASE_URL)
```

Backups are plain JSON (Admin › Data, administrators only). A backup holds the business data and settings, not users or passwords. Restoring one replaces the business data and keeps the users and the audit log.
