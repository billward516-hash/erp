import type { Actor } from '../../platform/auth/actor.js';
import { can } from '../../platform/auth/actor.js';
import type { Tx } from '../../platform/db/tx.js';
import { many } from '../../platform/db/tx.js';
import { reportScope } from '../reporting/definitions.js';
import type { LateRow } from '../late/service.js';
import { milestoneAmount } from './engine.js';
import { projectsHidden } from './service.js';

/** What is late: planned milestones past their due date on active projects, at the sites where the person may see projects. */
export async function overdueMilestones(tx: Tx, actor: Actor): Promise<(LateRow & { amt?: number })[]> {
  if (projectsHidden(actor) || !can(actor, 'projects.view')) return [];
  const sites = (await reportScope(tx, actor, 'projects.view')).ids;
  if (!sites.length) return [];
  const rows = await many(tx, `SELECT m.id, m.name, m.amount::float AS amount, m.percent::float AS percent, (current_date - m.due_date) AS late, p.id AS project_id, p.number, p.name AS project, u.display_name AS owner,
      p.contract_amount::float + coalesce((SELECT sum(c.amount)::float FROM project_change_order c WHERE c.project_id = p.id AND c.status = 'approved'), 0) AS contract
    FROM project_milestone m JOIN project p ON p.id = m.project_id LEFT JOIN app_user u ON u.id = p.owner_user_id
    WHERE p.facility_id = ANY ($1) AND p.status = 'active' AND m.status = 'planned' AND m.due_date < current_date ORDER BY m.due_date`, [sites]);
  return rows.map((r) => ({ label: `${r.number} · ${r.project}`, detail: `Milestone “${r.name}” not reached`, owner: r.owner, daysLate: r.late,
    amount: milestoneAmount({ amount: r.amount, percent: r.percent }, r.contract), href: `/projects/${r.project_id}` }));
}
