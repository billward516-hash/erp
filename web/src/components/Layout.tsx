import { useEffect, useState } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth';
import { useApi, useOutbox } from '../hooks';
import { syncOutbox } from '../offline';
import { setToken } from '../api';
import { FormAutosave } from './Autosave';

type Item = { to: string; label: string; show: boolean; badge?: number };
type Section = { heading: string; items: Item[] };

/**
 * The intranet shell (D-130): a company sidebar with every destination the user may open, grouped by area, a top bar
 * with search across the company, notifications and the user; on phones the sidebar is a drawer behind "Menu".
 */
export function Layout() {
  const { me, can, signOut } = useAuth();
  const queue = useApi<any[]>('/api/approvals/queue');
  const unread = useApi<{ count: number }>('/api/notifications/unread-count');
  const { pathname, search } = useLocation();
  const navigate = useNavigate();
  const { items: outboxItems } = useOutbox();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  // Refresh the badges on navigation, so they do not show items already handled; close the drawer.
  const reloadQueue = queue.reload;
  const reloadUnread = unread.reload;
  useEffect(() => { void reloadQueue(); void reloadUnread(); setOpen(false); }, [pathname, search, reloadQueue, reloadUnread]);
  useEffect(() => {
    if (!open) return;
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('keydown', esc);
    return () => document.removeEventListener('keydown', esc);
  }, [open]);
  const count = queue.data?.length ?? 0;
  const anyReport = ['reports.view', 'qualifications.view', 'moc.view', 'purchasing.view', 'crm.view', 'ar.view', 'production.view', 'quality.view', 'safety.view', 'continuity.view',
    'leasing.view', 'visits.view', 'planning.view', 'expenses.view_all', 'improve.submit', 'budgets.view', 'proforma.view'].some((p) => can(p));
  const sections: Section[] = [
    { heading: 'My day', items: [
      { to: '/', label: 'Home', show: true },
      { to: '/approvals', label: 'Approvals', show: true, badge: count },
      // Periodic reviews (D-154): for anyone who manages a kind of record that is reviewed.
      { to: '/reviews', label: 'Reviews', show: ['tenant.admin', 'quality.manage', 'documents.manage', 'policies.manage', 'expenses.manage', 'learning.manage', 'purchasing.manage', 'work_orders.manage', 'assets.manage', 'visits.conduct', 'continuity.manage'].some((p) => can(p as never)) },
      { to: '/notifications', label: 'Notifications', show: true, badge: unread.data?.count ?? 0 },
      { to: '/my-settings', label: 'How I like to work', show: true },
      { to: '/time', label: 'Time', show: !!me?.employeeId || can('time.approve') || can('time.view_all') || can('time.export') },
      { to: '/expenses', label: 'Expenses', show: can('expenses.submit') },
      { to: '/training', label: 'Training', show: can('learning.view') },
      { to: '/performance', label: 'Performance', show: !!me?.employeeId || can('performance.manage' as never) },
    ] },
    { heading: 'Company', items: [
      { to: '/news', label: 'News and events', show: true },
      { to: '/people', label: 'People', show: true },
      { to: '/policies', label: 'Policies & handbook', show: true },
      { to: '/improvements', label: 'Improvements', show: can('improve.submit') },
    ] },
    { heading: 'Maintenance', items: [
      { to: '/assets', label: 'Assets', show: can('assets.view') },
      { to: '/work-orders', label: 'Work orders', show: can('work_orders.view') },
      { to: '/pm', label: 'PM', show: can('work_orders.view') },
      { to: '/inventory', label: 'Storerooms', show: can('inventory.view') },
      { to: '/scan', label: 'Scan station', show: can('inventory.view') },
    ] },
    { heading: 'Field service', items: [
      { to: '/service', label: 'Field service', show: !!me?.fieldService && can('fieldservice.view') },
      { to: '/service/my-day', label: 'My day', show: !!me?.fieldService && can('fieldservice.execute') },
    ] },
    { heading: 'Production', items: [
      { to: '/production', label: 'Production orders', show: can('production.view') },
      { to: '/planning', label: 'Planning', show: can('planning.view') },
      { to: '/production/floor', label: 'Shop floor', show: can('production.execute') || can('production.manage') },
      { to: '/shift-log', label: 'Shift log', show: can('production.view') || can('work_orders.view') },
    ] },
    { heading: 'Quality & safety', items: [
      { to: '/quality', label: 'Quality', show: can('quality.view') || can('quality.report') },
      { to: '/capa', label: 'CAPA & 8D', show: can('quality.view') },
      { to: '/documents', label: 'Document control', show: can('documents.view') },
      { to: '/safety', label: 'Safety', show: can('safety.view') || can('safety.report') },
      { to: '/changes', label: 'Changes', show: can('moc.view') },
      { to: '/continuity', label: 'Continuity', show: can('continuity.view') },
      { to: '/stores', label: 'Conditions & visits', show: can('visits.view') },
    ] },
    { heading: 'Sales & supply', items: [
      { to: '/crm', label: 'Customers', show: can('crm.view') },
      { to: '/sales', label: 'Quotes & orders', show: can('sales.view') },
      { to: '/purchasing', label: 'Purchasing', show: can('purchasing.view') },
      { to: '/leasing', label: 'Leasing', show: can('leasing.view') },
    ] },
    { heading: 'Finance', items: [
      { to: '/books', label: 'Books', show: can('books.view') },
      { to: '/budgets', label: 'Budgets', show: can('budgets.view') || can('budgets.manage') },
      { to: '/proforma', label: 'Business cases', show: can('proforma.view') || can('proforma.manage') },
      { to: '/receivables', label: 'Receivables', show: can('ar.view') },
      { to: '/ap', label: 'Payables', show: can('ap.view') },
    ] },
    { heading: 'Insight', items: [{ to: '/reports', label: 'Reports', show: anyReport }, { to: '/late', label: 'What is late', show: true }] },
    { heading: 'Admin', items: [
      { to: '/sites', label: 'Sites', show: can('tenant.admin') || can('work_orders.manage') },
      { to: '/sign-in-settings', label: 'Sign-in', show: can('tenant.admin') },
      { to: '/features', label: 'Features', show: can('tenant.admin') },
      { to: '/reminders', label: 'Reminders', show: can('tenant.admin') || !!me?.remindersEditable },
      { to: '/retention', label: 'Data retention', show: can('tenant.admin') },
      { to: '/archives', label: 'Archives and restore', show: can('tenant.admin') },
      { to: '/fit', label: 'Fit interview', show: can('tenant.admin') },
      { to: '/implementation', label: 'Implementation', show: can('tenant.admin') || !!me?.implementationSteps },
      { to: '/jobs', label: 'Scheduled jobs', show: can('tenant.admin') },
      { to: '/imports', label: 'Data import', show: can('imports.run') },
      { to: '/integrations', label: 'Accounting', show: can('integrations.manage') },
    ] },
  ];
  // Features hidden from this user (D-149) leave the sidebar; the server refuses them anyway.
  const hiddenNav = me?.hiddenNav ?? [];
  const isHidden = (path: string) => hiddenNav.some((h) => path === h || path.startsWith(`${h}/`));
  for (const s of sections) s.items = s.items.filter((i) => !isHidden(i.to));
  // Lite (D-135) shows only its areas; the server refuses the rest anyway.
  if (me?.edition === 'lite') {
    const LITE = new Set(['/', '/approvals', '/reviews', '/performance', '/notifications', '/expenses', '/news', '/people', '/policies', '/crm', '/receivables', '/ap', '/purchasing', '/books', '/reports', '/late', '/imports', '/integrations', '/sign-in-settings', '/features', '/reminders', '/retention', '/archives', '/jobs']);
    for (const s of sections) s.items = s.items.filter((i) => LITE.has(i.to));
    const supply = sections.find((s) => s.heading === 'Sales & supply');
    if (supply) supply.items = supply.items.filter((i) => i.to !== '/purchasing');
  }
  const initials = (me?.displayName ?? '?').split(/\s+/).map((p) => p[0]).slice(0, 2).join('').toUpperCase();
  const signOutSafely = () => {
    const n = outboxItems.length;
    if (!n || window.confirm(`${n} change${n === 1 ? '' : 's'} made offline ${n === 1 ? 'has' : 'have'} not been sent yet and will be lost. Sign out anyway?`)) signOut();
  };
  return (
    <>
      <a className="skip" href="#main">Skip to content</a>
      <div className={`shell${open ? ' drawer-open' : ''}`}>
        <aside className="sidebar" id="sidebar">
          <Link to="/" className="company">
            <span className="mark" aria-hidden="true">{(me?.tenantName ?? 'O')[0]}</span>
            <span><strong>{me?.tenantName ?? 'Ops Platform'}</strong><small>{me?.edition === 'lite' ? 'Intranet · Lite' : 'Intranet'}</small></span>
          </Link>
          <nav aria-label="Main">
            {sections.map((s) => {
              const items = s.items.filter((i) => i.show);
              if (!items.length) return null;
              return (
                <div key={s.heading} className="nav-section">
                  <h2>{s.heading}</h2>
                  {items.map((i) => (
                    <NavLink key={i.to} to={i.to} end={i.to === '/'}>
                      {i.label}{i.badge ? <span className="count" aria-label={`${i.badge} waiting`}>{i.badge}</span> : null}
                    </NavLink>
                  ))}
                </div>
              );
            })}
          </nav>
        </aside>
        {open && <button className="scrim" aria-label="Close menu" onClick={() => setOpen(false)} />}
        <div className="shell-main">
          <header className="topbar">
            <button className="menu-button" aria-controls="sidebar" aria-expanded={open} onClick={() => setOpen(!open)}>Menu</button>
            <form className="search" role="search" onSubmit={(e) => { e.preventDefault(); if (q.trim().length >= 2) navigate(`/search?q=${encodeURIComponent(q.trim())}`); }}>
              <input type="search" aria-label="Search people, policies, assets and records" placeholder="Search people, policies, assets…" value={q} onChange={(e) => setQ(e.target.value)} />
            </form>
            <div className="user">
              <Link to="/notifications" className="bell" aria-label={`Notifications${unread.data?.count ? `, ${unread.data.count} unread` : ''}`}>
                <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 22a2.5 2.5 0 0 0 2.45-2h-4.9A2.5 2.5 0 0 0 12 22Zm7-6V11a7 7 0 0 0-5.5-6.84V3.5a1.5 1.5 0 0 0-3 0v.66A7 7 0 0 0 5 11v5l-2 2v1h18v-1l-2-2Z" /></svg>
                {unread.data?.count ? <span className="count">{unread.data.count}</span> : null}
              </Link>
              <span className="avatar" aria-hidden="true">{initials}</span>
              <span className="who">{me?.displayName}</span>
              <a className="link" href="/guide/" target="_blank" rel="noopener">Help</a>
              <button className="link" onClick={signOutSafely}>Sign out</button>
            </div>
          </header>
          <OfflineBar />
          {(() => { try { return !!sessionStorage.getItem('erp.return-token'); } catch { return false; } })() && (
            <div className="banner" role="status" style={{ padding: '8px 16px', background: 'var(--watch-bg, #fff4d6)', display: 'flex', gap: 12, alignItems: 'center' }}>
              <strong>Practice copy.</strong> <span>Nothing you do here touches the real company.</span>
              <button onClick={() => { const t = sessionStorage.getItem('erp.return-token'); sessionStorage.removeItem('erp.return-token'); setToken(t || null); window.location.assign('/implementation'); }}>Back to the real company</button>
            </div>)}
          <main className="page" id="main" tabIndex={-1}>{isHidden(pathname) ? <FeatureOff /> : <Outlet />}<FormAutosave /></main>
        </div>
      </div>
    </>
  );
}

/** Connection and outbox state: offline (saved copies shown), changes waiting, syncing, or changes the server refused. */
function OfflineBar() {
  const { items, syncing, online } = useOutbox();
  const failed = items.filter((q) => q.error).length;
  const waiting = items.length - failed;
  if (online && !items.length) return null;
  return (
    <div className={`offline-bar${failed ? ' bad' : ''}`} role="status">
      {!online ? <>Offline: showing copies saved on this device.{waiting ? ` ${waiting} change${waiting === 1 ? '' : 's'} will be sent when you are back online.` : ''}</>
        : syncing ? <>Sending {waiting} change{waiting === 1 ? '' : 's'} made offline…</>
          : waiting ? <>{waiting} change{waiting === 1 ? '' : 's'} waiting to be sent. <button className="link" onClick={() => void syncOutbox()}>Send now</button></> : null}
      {failed > 0 && <> {failed} change{failed === 1 ? '' : 's'} could not be saved. <Link to="/outbox">Review</Link></>}
    </div>
  );
}

/** A page whose feature is turned off for this user's role (D-149). */
function FeatureOff() {
  return (
    <section className="card stack" style={{ maxWidth: 640 }}>
      <h1>Not available</h1>
      <p className="muted">This part of the platform is turned off for your role. An administrator can turn it on under Admin → Features.</p>
      <div><Link className="btn" to="/">Home</Link></div>
    </section>
  );
}
