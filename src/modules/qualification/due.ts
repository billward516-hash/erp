import type { Tx } from '../../platform/db/tx.js';
import { many } from '../../platform/db/tx.js';
import { notify, usersWithPermission } from '../../platform/notify/notify.js';

/**
 * Requalification due dates in the reminder sweep and in What is late (SC-007 B, D-184B). A date is set when a protocol with an
 * interval is approved. Only tools under qualification control that are qualified, or already need requalification, count.
 */
export async function lateRequalification(tx: Tx, facilityIds: string[]) {
  const rows = await many(tx, `SELECT a.id, a.asset_tag, a.name, (current_date - x.requal_due_on) AS late FROM asset_qualification x JOIN asset a ON a.id = x.asset_id
    WHERE x.enabled AND x.status IN ('qualified', 'requalification_required') AND x.requal_due_on < current_date AND x.facility_id = ANY ($1) ORDER BY x.requal_due_on`, [facilityIds]);
  return rows.map((r) => ({ label: `${r.asset_tag} · ${r.name}`, detail: 'Periodic requalification is past its due date', owner: null as string | null, daysLate: r.late as number, amount: null as number | null, href: `/qualification/assets/${r.id}` }));
}

/** Weekly (by default) summary per site to the people who manage qualification there. Returns how many notices were created. */
export async function remindQualificationDue(tx: Tx, tenantId: string, opts: { lead: number; today: string; period: string }) {
  const rows = await many(tx, `SELECT x.facility_id, f.code, a.asset_tag, x.requal_due_on FROM asset_qualification x JOIN asset a ON a.id = x.asset_id JOIN facility f ON f.id = x.facility_id
    WHERE x.enabled AND x.status IN ('qualified', 'requalification_required') AND x.requal_due_on <= $1::date + $2::int ORDER BY x.requal_due_on`, [opts.today, opts.lead]);
  let created = 0;
  for (const facilityId of [...new Set(rows.map((r) => r.facility_id as string))]) {
    const mine = rows.filter((r) => r.facility_id === facilityId);
    const overdue = mine.filter((r) => String(new Date(r.requal_due_on).toISOString().slice(0, 10)) < opts.today);
    const d = (x: any) => new Date(x.requal_due_on).toISOString().slice(0, 10);
    created += await notify(tx, tenantId, await usersWithPermission(tx, 'qualification.manage', facilityId), {
      kind: 'reminder.qualification_due',
      title: `${mine[0]!.code}: ${mine.length} tool${mine.length === 1 ? '' : 's'} due for requalification${overdue.length ? `, ${overdue.length} overdue` : ''}`,
      body: mine.slice(0, 8).map((r) => `${r.asset_tag} ${d(r)}`).join(', '), link: '/qualification', dedupeKey: `qual-due:${facilityId}:${opts.period}`,
    });
  }
  return created;
}
