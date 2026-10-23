import { Link } from 'react-router-dom';
import { PageHead, Pill, Table } from '../components/ui';
import { fmtDateTime } from '../format';
import { useOutbox } from '../hooks';
import { discard, retry, syncOutbox } from '../offline';

/** Changes made offline on this device: waiting, or refused by the server with the reason, to retry or discard. */
export function Outbox() {
  const { items, online, syncing } = useOutbox();
  const woOf = (path: string) => /\/api\/work-orders\/([0-9a-f-]{36})\//.exec(path)?.[1];
  const visitOf = (path: string) => /\/api\/service-visits\/([0-9a-f-]{36})\//.exec(path)?.[1];
  return (
    <>
      <PageHead eyebrow="This device" title="Changes made offline" sub="Labor, parts used, status changes, visit starts and service reports recorded without a connection. They are sent in order when you are online; anything refused stays here with the reason."
        actions={online && items.some((q) => !q.error) ? <button className="primary" disabled={syncing} onClick={() => void syncOutbox()}>Send now</button> : undefined} />
      <div className="card">
        <Table rows={items} rowKey={(q) => q.id} empty="Nothing waiting: every change has been sent." exception={(q) => !!q.error}
          columns={[{ key: 'createdAt', label: 'Made', render: (q) => fmtDateTime(q.createdAt) }, { key: 'label', label: 'Change' },
            { key: 'wo', label: 'Record', render: (q) => (woOf(q.path) ? <Link to={`/work-orders/${woOf(q.path)}`}>work order</Link> : visitOf(q.path) ? <Link to="/service/my-day">my day</Link> : '—') },
            { key: 'state', label: 'State', render: (q) => (q.error ? <><Pill tone="bad" label="Refused" /> {q.error}</> : <Pill tone="watch" label="Waiting" />) },
            { key: 'x', label: '', render: (q) => <>{q.error && <button className="link" onClick={() => retry(q.id)}>Try again</button>}{' '}
              <button className="link" onClick={() => { if (window.confirm(`Discard "${q.label}"? It will not be recorded.`)) discard(q.id); }}>Discard</button></> }]} />
      </div>
    </>
  );
}
