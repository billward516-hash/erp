import { useEffect } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '../auth';
import { useApi } from '../hooks';

export function Layout() {
  const { me, can, signOut } = useAuth();
  const queue = useApi<any[]>('/api/approvals/queue');
  const { pathname } = useLocation();
  // Refresh the sign-off badge on navigation, so it does not show items already decided.
  const reloadQueue = queue.reload;
  useEffect(() => { void reloadQueue(); }, [pathname, reloadQueue]);
  const links: [string, string, boolean][] = [
    ['/', 'Home', true],
    ['/assets', 'Assets', can('assets.view')],
    ['/work-orders', 'Work orders', can('work_orders.view')],
    ['/pm', 'PM', can('work_orders.view')],
    ['/inventory', 'Storerooms', can('inventory.view')],
    ['/purchasing', 'Purchasing', can('purchasing.view')],
    ['/ap', 'Payables', can('ap.view')],
    ['/changes', 'Changes', can('moc.view')],
    ['/approvals', 'Approvals', true],
    ['/training', 'Training', can('learning.view')],
    ['/time', 'Time', !!me?.employeeId || can('time.approve') || can('time.view_all') || can('time.export')],
    ['/reports', 'Reports', can('reports.view') || can('qualifications.view') || can('moc.view') || can('purchasing.view')],
    ['/imports', 'Data import', can('imports.run')],
    ['/integrations', 'Accounting', can('integrations.manage')],
  ];
  return (
    <>
      <header className="topbar">
        <div className="topbar-row">
          <span className="brand">Ops Platform<small>pilot</small></span>
          <nav className="nav" aria-label="Main">
            {links.filter(([, , show]) => show).map(([to, label]) => (
              <NavLink key={to} to={to} end={to === '/'}>
                {label}{to === '/approvals' && queue.data?.length ? <span className="count" aria-label={`${queue.data.length} waiting`}>{queue.data.length}</span> : null}
              </NavLink>
            ))}
          </nav>
          <div className="user"><span>{me?.displayName}</span><button className="link" onClick={signOut}>Sign out</button></div>
        </div>
      </header>
      <main className="page"><Outlet /></main>
    </>
  );
}
