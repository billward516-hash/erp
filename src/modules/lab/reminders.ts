import type { Tx } from '../../platform/db/tx.js';
import { many } from '../../platform/db/tx.js';
import { notify, usersWithPermission } from '../../platform/notify/notify.js';
import type { sweepSettings } from '../reminders/settings.js';

type Settings = Awaited<ReturnType<typeof sweepSettings>>;
const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const d = (v: unknown) => String(v instanceof Date ? v.toISOString() : v).slice(0, 10);

/**
 * Laboratory reminders for the daily sweep (D-184D), one summary per site: samples due within the lead days or already past their
 * turnaround target (to laboratory staff), and samples whose retention date is near or passed and that have not been disposed of (to the laboratory manager).
 */
export async function remindLab(tx: Tx, tenantId: string, R: Settings, today: string): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  const facilities = await many(tx, 'SELECT id, code FROM facility');
  if (R.on('lab_sample_due')) {
    const soon = addDays(today, R.lead('lab_sample_due'));
    for (const f of facilities) {
      const rows = await many(tx, `SELECT number, due_on FROM lab_sample WHERE facility_id = $1 AND status NOT IN ('released', 'disposed') AND due_on <= $2::date ORDER BY due_on, number`, [f.id, soon]);
      if (!rows.length) continue;
      const late = rows.filter((r) => d(r.due_on) < today).length;
      counts.lab_sample_due = (counts.lab_sample_due ?? 0) + await notify(tx, tenantId, await usersWithPermission(tx, 'lab.analyze', f.id), { kind: 'reminder.lab_sample_due',
        title: `${f.code}: ${rows.length} lab sample${rows.length === 1 ? '' : 's'} due or past the turnaround target${late ? ` (${late} late)` : ''}`,
        body: rows.slice(0, 8).map((r) => `${r.number} ${d(r.due_on)}`).join(', '), link: '/lab', dedupeKey: `lab-due:${f.id}:${R.period('lab_sample_due')}` });
    }
  }
  if (R.on('lab_retention_due')) {
    const soon = addDays(today, R.lead('lab_retention_due'));
    for (const f of facilities) {
      const rows = await many(tx, `SELECT number, retention_until FROM lab_sample WHERE facility_id = $1 AND status <> 'disposed' AND retention_until IS NOT NULL AND retention_until <= $2::date
        AND NOT EXISTS (SELECT 1 FROM lab_investigation i WHERE i.sample_id = lab_sample.id AND i.status = 'open') ORDER BY retention_until, number`, [f.id, soon]);
      if (!rows.length) continue;
      const over = rows.filter((r) => d(r.retention_until) <= today).length;
      counts.lab_retention_due = (counts.lab_retention_due ?? 0) + await notify(tx, tenantId, await usersWithPermission(tx, 'lab.manage', f.id), { kind: 'reminder.lab_retention_due',
        title: `${f.code}: ${rows.length} lab sample${rows.length === 1 ? '' : 's'} reach the end of retention${over ? ` (${over} already past it)` : ''}`,
        body: `Dispose of them or extend retention. ${rows.slice(0, 8).map((r) => `${r.number} ${d(r.retention_until)}`).join(', ')}`, link: '/lab', dedupeKey: `lab-retention:${f.id}:${R.period('lab_retention_due')}` });
    }
  }
  return counts;
}
