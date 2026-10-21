import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth';
import { Async, Kpis, PageHead, Pill, Table } from '../components/ui';
import { fmtDate } from '../format';
import { useApi } from '../hooks';

export function Home() {
  const { me, can } = useAuth();
  const nav = useNavigate();
  const mine = useApi<any[]>(me?.employeeId && can('work_orders.view') ? '/api/work-orders?assigned=me&openOnly=true' : null);
  const open = useApi<any[]>(can('work_orders.view') ? '/api/work-orders?openOnly=true' : null);
  const queue = useApi<any[]>('/api/approvals/queue');
  const training = useApi<any[]>(me?.employeeId && can('learning.view') ? '/api/enrollments?mine=true' : null);
  const changes = useApi<any[]>(can('moc.view') ? '/api/moc?open=true' : null);
  const myTraining = (training.data ?? []).filter((e) => e.status !== 'completed');
  const overdueWo = (open.data ?? []).filter((w) => w.overdue).length;
  return (
    <>
      <PageHead eyebrow="Today" title={`Hello, ${me?.displayName.split(' ')[0]}`} sub="Your work, sign-offs and training in one place." />
      <Kpis items={[
        ...(me?.employeeId ? [{ label: 'My open work orders', value: mine.data?.length ?? '…' }] : []),
        ...(can('work_orders.view') ? [{ label: 'Overdue work orders', value: open.data ? overdueWo : '…', tone: overdueWo ? 'bad' as const : 'good' as const, note: 'your facilities' }] : []),
        { label: 'Waiting for my sign-off', value: queue.data?.length ?? '…', tone: queue.data?.length ? 'watch' : undefined },
        ...(me?.employeeId && can('learning.view') ? [{ label: 'My training to do', value: training.data ? myTraining.length : '…', tone: myTraining.some((e) => e.overdue) ? 'bad' as const : undefined }] : []),
        ...(can('moc.view') ? [{ label: 'Open changes', value: changes.data?.length ?? '…' }] : []),
      ]} />
      <div className="grid two">
        {me?.employeeId && can('work_orders.view') && (
          <section className="card">
            <div className="spread"><h2>My work orders</h2><Link to="/work-orders">All work orders</Link></div>
            <Async loading={mine.loading} error={mine.error}>{() => (
              <Table rows={mine.data ?? []} onRow={(w) => nav(`/work-orders/${w.id}`)} empty="Nothing assigned to you." exception={(w) => w.overdue}
                columns={[{ key: 'number', label: 'WO' }, { key: 'asset_tag', label: 'Asset' }, { key: 'title', label: 'Title' },
                  { key: 'status', label: 'Status', render: (w) => <Pill value={w.status} /> }, { key: 'due_at', label: 'Due', render: (w) => fmtDate(w.due_at) }]} />
            )}</Async>
          </section>
        )}
        <section className="card">
          <div className="spread"><h2>Waiting for my sign-off</h2><Link to="/approvals">Approvals</Link></div>
          <Async loading={queue.loading} error={queue.error}>{() => (
            <Table rows={queue.data ?? []} rowKey={(q) => q.stepId} empty="Nothing waiting for you." onRow={(q) => q.subjectType === 'moc_change' && nav(`/changes/${q.subjectId}`)}
              columns={[{ key: 'subject', label: 'Item', render: (q) => q.subject ? `${q.subject.number} ${q.subject.title}` : q.subjectType },
                { key: 'label', label: 'Your step' }]} />
          )}</Async>
        </section>
        {me?.employeeId && can('learning.view') && (
          <section className="card">
            <div className="spread"><h2>My training</h2><Link to="/training">Training</Link></div>
            <Async loading={training.loading} error={training.error}>{() => (
              <Table rows={myTraining} onRow={(e) => nav(`/training/enrollments/${e.id}`)} empty="No training assigned." exception={(e) => e.overdue}
                columns={[{ key: 'code', label: 'Course' }, { key: 'title', label: 'Title' }, { key: 'status', label: 'Status', render: (e) => <Pill value={e.status} /> },
                  { key: 'due_on', label: 'Due', render: (e) => fmtDate(e.due_on) }]} />
            )}</Async>
          </section>
        )}
        {!me?.employeeId && can('work_orders.view') && (
          <section className="card">
            <div className="spread"><h2>Open work orders</h2><Link to="/work-orders">All</Link></div>
            <Async loading={open.loading} error={open.error}>{() => (
              <Table rows={(open.data ?? []).slice(0, 8)} onRow={(w) => nav(`/work-orders/${w.id}`)} exception={(w) => w.overdue}
                columns={[{ key: 'number', label: 'WO' }, { key: 'asset_tag', label: 'Asset' }, { key: 'title', label: 'Title' },
                  { key: 'status', label: 'Status', render: (w) => <Pill value={w.status} /> }]} />
            )}</Async>
          </section>
        )}
      </div>
    </>
  );
}
