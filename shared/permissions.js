// Who may do what. Everyone signed in can look at everything; changing things takes a permission.
// A user has one or more roles; a role is a set of permissions ('*' = all of them).

export const PERMISSIONS = {
  'items.edit': 'Items, bills of materials and routings',
  'stock.adjust': 'Stock adjustments and counts',
  'customers.edit': 'Customers',
  'suppliers.edit': 'Suppliers',
  'quotes.edit': 'Quotes',
  'invoices.edit': 'Invoices (customer orders)',
  'workorders.edit': 'Work orders and the Floor',
  'purchases.edit': 'Purchase orders and Planning › Create purchase orders',
  'orders.receive': 'Receive purchase orders',
  'orders.ship': 'Ship invoices',
  'payments.record': 'Record payments on orders',
  'ledger.edit': 'Ledger entries (add, edit, void)',
  'people.edit': 'Employees',
  'time.edit': 'Time entries',
  'audit.view': 'The audit log',
  'settings.edit': 'Settings and lists',
  'users.manage': 'Users and roles',
  'data.manage': 'Backup, restore, sample data',
};

const ADMIN_ONLY = ['settings.edit', 'users.manage', 'data.manage'];

export const ROLES = {
  admin: { label: 'Administrator', perms: ['*'], hint: 'Everything, including users, settings and data' },
  manager: { label: 'Manager', perms: Object.keys(PERMISSIONS).filter((p) => !ADMIN_ONLY.includes(p)), hint: 'All the daily work and the audit log' },
  sales: { label: 'Sales', perms: ['customers.edit', 'quotes.edit', 'invoices.edit', 'orders.ship', 'payments.record'], hint: 'Customers, quotes, invoices, shipping, customer payments' },
  purchasing: { label: 'Purchasing', perms: ['suppliers.edit', 'purchases.edit', 'orders.receive', 'items.edit'], hint: 'Suppliers, purchase orders, receiving, items' },
  production: { label: 'Production', perms: ['workorders.edit', 'time.edit'], hint: 'Work orders, the Floor, time entries' },
  warehouse: { label: 'Warehouse', perms: ['orders.receive', 'orders.ship', 'stock.adjust', 'items.edit'], hint: 'Receiving, shipping, adjustments and counts' },
  accounts: { label: 'Accounts', perms: ['payments.record', 'ledger.edit', 'customers.edit', 'suppliers.edit', 'people.edit'], hint: 'Payments, the Ledger, customers, suppliers, employees' },
  viewer: { label: 'Viewer', perms: [], hint: 'Looks at everything, changes nothing' },
};

export function permsOf(roles) {
  const out = new Set();
  for (const r of roles || []) for (const p of ROLES[r]?.perms || []) out.add(p);
  return out;
}

export function can(user, perm) {
  if (!user || user.active === false) return false;
  const p = permsOf(user.roles);
  return p.has('*') || p.has(perm);
}

/** The permission an order type needs to be created, edited or cancelled */
export const ORDER_PERM = {
  Quote: 'quotes.edit', Invoice: 'invoices.edit', 'Work Order': 'workorders.edit', 'Purchase Order': 'purchases.edit',
};
