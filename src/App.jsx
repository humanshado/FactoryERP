import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { NavLink, Route, Routes, useLocation } from 'react-router-dom';
import { api, run, setOnUnauthorized } from './api.js';
import { ConfirmHost, Loading, Toasts, setAppSettings, setDataUnauthorized, useData } from './ui.jsx';
import { ROLES, can as canDo } from '../shared/permissions.js';
import Floor from './pages/Floor.jsx';
import Pipeline from './pages/Pipeline.jsx';
import Planning from './pages/Planning.jsx';
import Orders from './pages/Orders.jsx';
import OrderPrint from './pages/OrderPrint.jsx';
import Stock from './pages/Stock.jsx';
import StockCount from './pages/StockCount.jsx';
import { Customers, Suppliers } from './pages/Parties.jsx';
import Ledger from './pages/Ledger.jsx';
import People from './pages/People.jsx';
import Reports from './pages/Reports.jsx';
import Admin from './pages/Admin.jsx';
import Users from './pages/Users.jsx';
import Audit from './pages/Audit.jsx';
import { ChangePassword, Login, Setup } from './pages/Login.jsx';

const AppCtx = createContext(null);
/** { settings, today, reload, user, can(perm) } */
export const useApp = () => useContext(AppCtx);

const NAV = [
  { group: 'Run', items: [
    { to: '/', label: 'Floor', icon: 'M3 21V9l6 4V9l6 4V9l6 4v8z' },
    { to: '/pipeline', label: 'Pipeline', icon: 'M3 6h18M6 12h12M10 18h4' },
    { to: '/planning', label: 'Planning', icon: 'M4 5h16v15H4zM4 10h16M9 5V3m6 2V3' },
  ] },
  { group: 'Records', items: [
    { to: '/orders', label: 'Orders', icon: 'M6 3h9l4 4v14H6zM9 12h7M9 16h7M9 8h3' },
    { to: '/stock', label: 'Stock', icon: 'M3 8l9-5 9 5v8l-9 5-9-5zM3 8l9 5 9-5M12 13v8' },
    { to: '/customers', label: 'Customers', icon: 'M8 11a4 4 0 100-8 4 4 0 000 8zM2 21c0-4 3-6 6-6s6 2 6 6M16 3a4 4 0 010 8M18 15c2 .5 4 2.5 4 6' },
    { to: '/suppliers', label: 'Suppliers', icon: 'M2 7h11v10H2zM13 10h4l4 4v3h-8zM6 20a2 2 0 100-4 2 2 0 000 4zM17 20a2 2 0 100-4 2 2 0 000 4z' },
    { to: '/ledger', label: 'Ledger', icon: 'M12 3v18M17 7H9.5a3 3 0 000 6h5a3 3 0 010 6H6' },
    { to: '/people', label: 'People', icon: 'M12 11a4 4 0 100-8 4 4 0 000 8zM4 21c0-4 4-7 8-7s8 3 8 7' },
  ] },
  { group: 'Look back', items: [
    { to: '/reports', label: 'Reports', icon: 'M4 20V10m6 10V4m6 16v-7m4 7H2' },
    { to: '/audit', label: 'Audit log', icon: 'M12 8v5l3 2M12 21a9 9 0 100-18 9 9 0 000 18z', perm: 'audit.view' },
    { to: '/users', label: 'Users', icon: 'M16 11a3 3 0 100-6 3 3 0 000 6zM8 11a3 3 0 100-6 3 3 0 000 6zM2 20c0-3 3-5 6-5s6 2 6 5M14 15c3 0 8 1 8 5', perm: 'users.manage' },
    { to: '/admin', label: 'Admin', icon: 'M12 15a3 3 0 100-6 3 3 0 000 6zM19 12l2-1-1-3-2 .2-1.3-1.5.4-2-3-1-1 1.8h-2L10 3.7l-3 1 .4 2L6 8.2 4 8 3 11l2 1v0l-2 1 1 3 2-.2 1.3 1.5-.4 2 3 1 1-1.8h2l1 1.8 3-1-.4-2 1.4-1.5 2 .2 1-3z' },
  ] },
];

function Icon({ d }) {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}

function Rail({ settings, user, can, open, onClose, onSignOut, onPassword }) {
  const roles = (user.roles || []).map((r) => ROLES[r]?.label || r).join(', ');
  return (
    <aside className={`rail ${open ? 'open' : ''}`}>
      <div className="brand">
        <svg viewBox="0 0 32 32" width="30" height="30" aria-hidden="true"><rect width="32" height="32" rx="7" fill="var(--accent)" /><path d="M6 25V13l6 4v-4l6 4v-4l6 4V7h3v18z" fill="#fff" /></svg>
        <div>
          <div className="brand-name">FactoryERP</div>
          <div className="brand-co">{settings.companyName}</div>
        </div>
      </div>
      <nav>
        {NAV.map((g) => (
          <div key={g.group} className="nav-group">
            <div className="nav-title">{g.group}</div>
            {g.items.filter((it) => !it.perm || can(it.perm)).map((it) => (
              <NavLink key={it.to} to={it.to} end={it.to === '/'} className="nav-link" onClick={onClose}>
                <Icon d={it.icon} />
                <span>{it.label}</span>
              </NavLink>
            ))}
          </div>
        ))}
      </nav>
      <div className="rail-foot">
        {String(settings.sampleMode).toUpperCase() === 'YES' && <div className="sample-pill" title="Sample data: Admin > Data to start your own">SAMPLE DATA</div>}
        <div className="me">
          <div className="me-avatar" aria-hidden="true">{(user.name || user.username).slice(0, 1).toUpperCase()}</div>
          <div className="me-txt">
            <div className="me-name">{user.name || user.username}</div>
            <div className="me-role">{roles}</div>
          </div>
        </div>
        <div className="me-actions">
          <button onClick={onPassword}>Password</button>
          <button onClick={onSignOut}>Sign out</button>
        </div>
      </div>
    </aside>
  );
}

function Shell({ user, onSignOut }) {
  const [boot, reload, error] = useData('/bootstrap');
  const [menu, setMenu] = useState(false);
  const [pw, setPw] = useState(false);
  const loc = useLocation();
  useEffect(() => setMenu(false), [loc.pathname]);
  const can = useCallback((perm) => canDo(user, perm), [user]);
  if (!boot) return <Loading error={error && `Cannot reach the FactoryERP server: ${error}`} />;
  setAppSettings(boot.settings);
  const printing = /\/print$/.test(loc.pathname);
  return (
    <AppCtx.Provider value={{ settings: boot.settings, today: boot.today, reload, user, can, database: boot.database }}>
      {printing ? (
        <Routes><Route path="/orders/:id/print" element={<OrderPrint />} /></Routes>
      ) : (
        <div className="shell">
          <Rail settings={boot.settings} user={user} can={can} open={menu} onClose={() => setMenu(false)} onSignOut={onSignOut} onPassword={() => setPw(true)} />
          {menu && <div className="rail-back" onClick={() => setMenu(false)} />}
          <main className="main">
            <button className="menu-btn" onClick={() => setMenu(true)} aria-label="Open menu">☰ FactoryERP</button>
            <Routes>
              <Route path="/" element={<Floor />} />
              <Route path="/pipeline" element={<Pipeline />} />
              <Route path="/planning" element={<Planning />} />
              <Route path="/orders" element={<Orders />} />
              <Route path="/stock" element={<Stock />} />
              <Route path="/stock/count" element={<StockCount />} />
              <Route path="/customers" element={<Customers />} />
              <Route path="/suppliers" element={<Suppliers />} />
              <Route path="/ledger" element={<Ledger />} />
              <Route path="/people" element={<People />} />
              <Route path="/reports" element={<Reports />} />
              <Route path="/audit" element={<Audit />} />
              <Route path="/users" element={<Users />} />
              <Route path="/admin" element={<Admin />} />
              <Route path="*" element={<Floor />} />
            </Routes>
          </main>
        </div>
      )}
      {pw && <ChangePassword onClose={() => setPw(false)} />}
    </AppCtx.Provider>
  );
}

export default function App() {
  const [auth, setAuth] = useState(null);
  const [error, setError] = useState(null);
  const load = useCallback(async () => {
    try {
      setAuth(await api('GET', '/auth/me'));
      setError(null);
    } catch (e) {
      setError(e.message);
    }
  }, []);
  useEffect(() => {
    load();
    setOnUnauthorized(load);
    setDataUnauthorized(load);
  }, [load]);
  const signOut = async () => {
    await run('POST', '/auth/logout');
    load();
  };
  let body;
  if (!auth) body = <Loading error={error && `Cannot reach the FactoryERP server: ${error}`} />;
  else if (auth.setupNeeded) body = <Setup onDone={load} />;
  else if (!auth.user) body = <Login onDone={load} />;
  else body = <Shell key={auth.user.id} user={auth.user} onSignOut={signOut} />;
  return (
    <>
      {body}
      <Toasts />
      <ConfirmHost />
    </>
  );
}
