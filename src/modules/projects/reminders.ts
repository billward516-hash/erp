import type { Tx } from '../../platform/db/tx.js';
import { many } from '../../platform/db/tx.js';
import { notify, usersWithPermission } from '../../platform/notify/notify.js';
import { timeRows } from './costing.js';
import { budgetLevel, round2, variance } from './engine.js';
import { alertPct } from './service.js';

/**
 * Projects at or over their hours budget (SC-009 P1): tells the project owner (or, with no owner, the project managers at the site) once for
 * "close to the budget" (the company's alert share, default 90%) and once for "over". The sweep's repeat setting decides whether it says it
 * again (weekly) or never (once).
 */
export async function remindProjectBudgets(tx: Tx, tenantId: string, R: { on(key: string): boolean; period(key: string): string }) {
  const counts: Record<string, number> = {};
  if (!R.on('project_budget')) return counts;
  const alert = await alertPct(tx);
  const projects = await many(tx, `SELECT p.id, p.facility_id, p.number, p.name, p.owner_user_id, p.hours_budget::float AS hours_budget, (SELECT sum(t.hours_budget)::float FROM project_task t WHERE t.project_id = p.id) AS task_hours
    FROM project p WHERE p.status = 'active'`);
  const budgeted = projects.filter((p) => (p.hours_budget ?? p.task_hours) != null && (p.hours_budget ?? p.task_hours) > 0);
  const time = await timeRows(tx, budgeted.map((p) => p.id));
  for (const p of budgeted) {
    const actual = round2(time.filter((t) => t.project_id === p.id && t.approved).reduce((s, t) => s + t.hours, 0));
    const v = variance(p.hours_budget ?? p.task_hours, actual);
    const level = budgetLevel(v.used, alert);
    if (level === 'ok') continue;
    const users = p.owner_user_id ? [p.owner_user_id] : await usersWithPermission(tx, 'projects.manage', p.facility_id);
    const title = level === 'over' ? `${p.number} ${p.name} is over its hours budget (${actual} of ${v.budget} h)` : `${p.number} ${p.name} has used ${Math.round((v.used ?? 0) * 100)}% of its hours budget (${v.remaining} h left)`;
    const n = await notify(tx, tenantId, users, { kind: 'reminder.project_budget', title, link: `/projects/${p.id}`, subjectType: 'project', subjectId: p.id, dedupeKey: `project-budget:${p.id}:${level}:${R.period('project_budget')}` });
    const key = level === 'over' ? 'project_over_budget' : 'project_near_budget';
    counts[key] = (counts[key] ?? 0) + n;
  }
  return counts;
}
