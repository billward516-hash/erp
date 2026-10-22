import { useEffect, useRef, useState } from 'react';
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '../auth';
import { useApi } from '../hooks';

type Item = { to: string; label: string; show: boolean };
type Entry = Item | { group: string; items: Item[] };

/** A menu group: a button that opens a small list of links; closes on navigation, Escape or an outside click. */
function Group({ label, items, pathname }: { label: string; items: Item[]; pathname: string }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 });
  const btn = useRef<HTMLButtonElement>(null);
  const active = items.some((i) => pathname === i.to || pathname.startsWith(`${i.to}/`));
  useEffect(() => { setOpen(false); }, [pathname]);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !btn.current?.parentElement?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', close);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', close); };
  }, [open]);
  const toggle = () => {
    const r = btn.current!.getBoundingClientRect();
    // Fixed positioning keeps the menu visible even when the bar scrolls sideways on phones.
    setPos({ top: r.bottom, left: Math.min(r.left, window.innerWidth - 200) });
    setOpen(!open);
  };
  return (
    <span className="nav-group">
      <button ref={btn} className={`nav-button ${active ? 'active' : ''}`} aria-haspopup="true" aria-expanded={open} onClick={toggle}>{label} ▾</button>
      {open && (
        <span className="nav-menu" role="menu" style={{ top: pos.top, left: pos.left }}>
          {items.map((i) => <NavLink key={i.to} to={i.to} role="menuitem">{i.label}</NavLink>)}
        </span>
      )}
    </span>
  );
}

export function Layout() {
  const { me, can, signOut } = useAuth();
  const queue = useApi<any[]>('/api/approvals/queue');
  const unread = useApi<{ count: number }>('/api/notifications/unread-count');
  const { pathname } = useLocation();
  // Refresh the badges on navigation, so they do not show items already handled.
  const reloadQueue = queue.reload;
  const reloadUnread = unread.reload;
  useEffect(() => { void reloadQueue(); void reloadUnread(); }, [pathname, reloadQueue, reloadUnread]);
  const entries: Entry[] = [
    { to: '/', label: 'Home', show: true },
    { group: 'Maintenance', items: [
      { to: '/assets', label: 'Assets', show: can('assets.view') },
      { to: '/work-orders', label: 'Work orders', show: can('work_orders.view') },
      { to: '/pm', label: 'PM', show: can('work_orders.view') },
      { to: '/inventory', label: 'Storerooms', show: can('inventory.view') },
    ] },
    { group: 'Production', items: [
      { to: '/production', label: 'Production orders', show: can('production.view') },
      { to: '/production/floor', label: 'Shop floor', show: can('production.execute') || can('production.manage') },
    ] },
    { group: 'Sales', items: [
      { to: '/crm', label: 'Customers', show: can('crm.view') },
      { to: '/sales', label: 'Quotes & orders', show: can('sales.view') },
      { to: '/receivables', label: 'Receivables', show: can('ar.view') },
    ] },
    { group: 'Supply', items: [
      { to: '/purchasing', label: 'Purchasing', show: can('purchasing.view') },
      { to: '/ap', label: 'Payables', show: can('ap.view') },
    ] },
    { group: 'People', items: [
      { to: '/training', label: 'Training', show: can('learning.view') },
      { to: '/time', label: 'Time', show: !!me?.employeeId || can('time.approve') || can('time.view_all') || can('time.export') },
    ] },
    { group: 'Property', items: [
      { to: '/leasing', label: 'Leasing', show: can('leasing.view') },
    ] },
    { group: 'Quality & safety', items: [
      { to: '/quality', label: 'Quality', show: can('quality.view') || can('quality.report') },
      { to: '/safety', label: 'Safety', show: can('safety.view') || can('safety.report') },
      { to: '/continuity', label: 'Continuity', show: can('continuity.view') },
      { to: '/stores', label: 'Conditions & visits', show: can('visits.view') },
      { to: '/changes', label: 'Changes', show: can('moc.view') },
    ] },
    { to: '/approvals', label: 'Approvals', show: true },
    { to: '/reports', label: 'Reports', show: can('reports.view') || can('qualifications.view') || can('moc.view') || can('purchasing.view') || can('crm.view') || can('ar.view') || can('production.view') || can('quality.view') || can('safety.view') || can('continuity.view') || can('leasing.view') || can('visits.view') },
    { group: 'Admin', items: [
      { to: '/sites', label: 'Sites', show: can('tenant.admin') || can('work_orders.manage') },
      { to: '/imports', label: 'Data import', show: can('imports.run') },
      { to: '/integrations', label: 'Accounting', show: can('integrations.manage') },
    ] },
  ];
  const count = queue.data?.length ?? 0;
  const link = (i: Item) => (
    <NavLink key={i.to} to={i.to} end={i.to === '/'}>
      {i.label}{i.to === '/approvals' && count ? <span className="count" aria-label={`${count} waiting`}>{count}</span> : null}
    </NavLink>
  );
  return (
    <>
      <header className="topbar">
        <div className="topbar-row">
          <span className="brand">Ops Platform<small>pilot</small></span>
          <nav className="nav" aria-label="Main">
            {entries.map((e) => {
              if ('to' in e) return e.show ? link(e) : null;
              const visible = e.items.filter((i) => i.show);
              // A group with one visible item is shown as a plain link.
              return visible.length > 1 ? <Group key={e.group} label={e.group} items={visible} pathname={pathname} /> : visible.map(link);
            })}
          </nav>
          <div className="user">
            <Link to="/notifications" className="bell" aria-label={`Notifications${unread.data?.count ? `, ${unread.data.count} unread` : ''}`}>
              <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 22a2.5 2.5 0 0 0 2.45-2h-4.9A2.5 2.5 0 0 0 12 22Zm7-6V11a7 7 0 0 0-5.5-6.84V3.5a1.5 1.5 0 0 0-3 0v.66A7 7 0 0 0 5 11v5l-2 2v1h18v-1l-2-2Z" /></svg>
              {unread.data?.count ? <span className="count">{unread.data.count}</span> : null}
            </Link>
            <span>{me?.displayName}</span><button className="link" onClick={signOut}>Sign out</button>
          </div>
        </div>
      </header>
      <main className="page"><Outlet /></main>
    </>
  );
}
