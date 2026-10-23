import type { Actor } from '../../platform/auth/actor.js';
import { can, facilitiesWith } from '../../platform/auth/actor.js';
import type { Tx } from '../../platform/db/tx.js';
import { many, one } from '../../platform/db/tx.js';
import { forbidden } from '../../platform/errors.js';

/**
 * The CAPA and 8D module's dashboard (D-160): open corrective and preventive actions by step, source and age; overdue
 * work; how often the fix held when checked; time to close; 8Ds by discipline; and repeat problems (the same part or
 * supplier coming back within a year).
 */
export const STEP_LABEL: Record<string, string> = { open: 'Containment', root_cause: 'Root cause', actions: 'Actions', verification: 'Effectiveness check' };
export const SOURCE_LABEL: Record<string, string> = {
  nonconformance: 'Nonconformance', incident: 'Safety incident', customer_complaint: 'Customer complaint', audit: 'Audit', internal: 'Internal', fmea: 'FMEA',
  supplier: 'Supplier', spc: 'SPC alarm', change: 'Change', management_review: 'Management review', risk: 'Risk or trend',
};

export async function capaDashboard(tx: Tx, actor: Actor, q: { facilityId?: string | null } = {}) {
  const scope = facilitiesWith(actor, 'quality.view');
  if (!scope.all && !scope.ids.length) throw forbidden('quality.view');
  if (q.facilityId && !can(actor, 'quality.view', q.facilityId)) throw forbidden('quality.view');
  const where = `c.facility_id = ANY ($1)`;
  const ids = q.facilityId ? [q.facilityId] : scope.all ? (await many(tx, 'SELECT id FROM facility')).map((f) => f.id) : scope.ids;
  const open = await many(tx, `SELECT c.id, c.number, c.title, c.status, c.source, c.action_type, c.format, c.priority, c.due_date, f.code AS facility_code, u.display_name AS owner_name,
      (current_date - c.created_at::date) AS age_days, (c.due_date < current_date) AS overdue
    FROM corrective_action c JOIN facility f ON f.id = c.facility_id JOIN app_user u ON u.id = c.owner_user_id
    WHERE ${where} AND c.status NOT IN ('closed', 'cancelled') ORDER BY c.due_date NULLS LAST`, [ids]);
  const year = await one(tx, `SELECT count(*) FILTER (WHERE c.status = 'closed')::int AS closed,
      count(*) FILTER (WHERE c.status = 'closed' AND c.effective)::int AS effective,
      count(*) FILTER (WHERE c.status = 'closed' AND c.effective = false)::int AS not_effective,
      round(avg(EXTRACT(EPOCH FROM c.closed_at - c.created_at) / 86400) FILTER (WHERE c.status = 'closed'))::int AS avg_days_to_close,
      count(*) FILTER (WHERE c.action_type = 'preventive')::int AS preventive
    FROM corrective_action c WHERE ${where} AND c.created_at > now() - interval '12 months'`, [ids]);
  const overdueActions = Number((await one(tx, `SELECT count(*)::int AS n FROM action_item a JOIN corrective_action c ON a.subject_type = 'corrective_action' AND c.id = a.subject_id
    WHERE ${where} AND a.status = 'open' AND a.due_date < current_date`, [ids])).n);
  // The same part (through nonconformances) or supplier with more than one corrective action in a year.
  const repeats = await many(tx, `SELECT 'part' AS kind, p.part_number AS key, p.description AS name, count(DISTINCT c.id)::int AS n, array_agg(DISTINCT c.number) AS numbers
      FROM corrective_action c JOIN nonconformance n ON n.capa_id = c.id JOIN part p ON p.id = n.part_id
      WHERE ${where} AND c.created_at > now() - interval '12 months' GROUP BY p.part_number, p.description HAVING count(DISTINCT c.id) > 1
    UNION ALL
    SELECT 'supplier', s.code, s.name, count(*)::int, array_agg(c.number) FROM corrective_action c JOIN supplier s ON s.id = c.supplier_id
      WHERE ${where} AND c.created_at > now() - interval '12 months' GROUP BY s.code, s.name HAVING count(*) > 1
    ORDER BY 4 DESC LIMIT 10`, [ids]);
  const count = (f: (r: any) => boolean) => open.filter(f).length;
  const bucket = (r: any) => (r.age_days <= 30 ? '0–30 days' : r.age_days <= 60 ? '31–60 days' : r.age_days <= 90 ? '61–90 days' : 'Over 90 days');
  const tally = (key: (r: any) => string) => {
    const m = new Map<string, number>();
    for (const r of open) m.set(key(r), (m.get(key(r)) ?? 0) + 1);
    return [...m].map(([label, n]) => ({ label, n })).sort((a, b) => b.n - a.n);
  };
  const verified = (year.effective ?? 0) + (year.not_effective ?? 0);
  const overdue = count((r) => r.overdue);
  return {
    answer: open.length
      ? `${open.length} open (${count((r) => r.action_type === 'preventive')} preventive)${overdue ? `, ${overdue} overdue` : ', none overdue'}; ${verified ? `${Math.round((100 * year.effective) / verified)}% of fixes checked in the last year held` : 'no effectiveness checks in the last year yet'}.`
      : `No open corrective or preventive actions${verified ? `; ${Math.round((100 * year.effective) / verified)}% of fixes checked in the last year held` : ''}.`,
    kpis: {
      open: open.length, corrective: count((r) => r.action_type === 'corrective'), preventive: count((r) => r.action_type === 'preventive'), overdue, overdueActions,
      inVerification: count((r) => r.status === 'verification'), eightD: count((r) => r.format === 'eight_d'),
      effectivenessRate: verified ? Math.round((100 * year.effective) / verified) : null, avgDaysToClose: year.avg_days_to_close ?? null, closedLastYear: year.closed ?? 0,
    },
    byStep: ['open', 'root_cause', 'actions', 'verification'].map((s) => ({ step: s, label: STEP_LABEL[s], n: count((r) => r.status === s) })),
    bySource: tally((r) => SOURCE_LABEL[r.source] ?? r.source),
    byAge: ['0–30 days', '31–60 days', '61–90 days', 'Over 90 days'].map((label) => ({ label, n: count((r) => bucket(r) === label) })),
    repeats, open,
  };
}
