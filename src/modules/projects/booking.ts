import type { Actor } from '../../platform/auth/actor.js';
import type { Tx } from '../../platform/db/tx.js';
import { many, one } from '../../platform/db/tx.js';
import { invalid } from '../../platform/errors.js';
import { projectsHidden } from './service.js';

/**
 * Booking hours and expenses to a project (SC-009 P1): which projects a person may book to, and the billable flag.
 * Used by the timesheet (modules/time) and the expense report (modules/expenses); neither reads the project tables itself.
 */
export interface Booking { projectId: string; taskId: string | null; billable: boolean }

/**
 * Checks a booking and settles the billable flag.
 * - the project must be visible to the person entering it, and active;
 * - the person the hours belong to must be on the team, unless the project is open to all staff;
 * - a task, if named, belongs to the project and is active;
 * - billable defaults from the task, then the project; a non-billable project or task cannot be marked billable. Anyone can mark billable work
 *   non-billable (a write-off), never the other way round.
 */
export async function resolveBooking(tx: Tx, actor: Actor, input: { employeeId: string | null; projectId: string; taskId?: string | null; billable?: boolean | null; defaultBillable?: boolean }): Promise<Booking> {
  if (projectsHidden(actor)) throw invalid('projects are turned off for your role');
  const p = await one(tx, 'SELECT id, number, name, status, billing_type, open_to_all FROM project WHERE id = $1', [input.projectId]);
  if (!p) throw invalid('that project was not found, or you cannot book to it');
  if (p.status !== 'active') throw invalid(`${p.number} is ${String(p.status).replace('_', ' ')}; hours and expenses can be booked only to active projects`);
  if (!p.open_to_all) {
    const member = input.employeeId && (await one(tx, 'SELECT 1 FROM project_member WHERE project_id = $1 AND employee_id = $2 AND active', [p.id, input.employeeId]));
    if (!member) throw invalid(`you are not on the team of ${p.number} ${p.name}; ask the project owner to add you`);
  }
  let task: { id: string; billable: boolean } | null = null;
  if (input.taskId) {
    task = (await one(tx, 'SELECT id, billable, active FROM project_task WHERE id = $1 AND project_id = $2', [input.taskId, p.id])) ?? null;
    if (!task || !(task as any).active) throw invalid('choose an active task of that project');
  }
  const allowed = p.billing_type !== 'non_billable' && (task ? task.billable : true);
  const wanted = input.billable ?? (input.defaultBillable ?? true);
  return { projectId: p.id, taskId: task?.id ?? null, billable: allowed && wanted };
}

/** Active projects the person (the employee a timesheet belongs to) may book hours to, each with its active tasks. */
export async function projectOptions(tx: Tx, actor: Actor, employeeId: string | null) {
  if (projectsHidden(actor)) return [];
  const projects = await many(tx, `SELECT p.id, p.number, p.name, p.billing_type, c.name AS customer_name, p.open_to_all FROM project p LEFT JOIN customer c ON c.id = p.customer_id
    WHERE p.status = 'active' AND (p.open_to_all OR EXISTS (SELECT 1 FROM project_member m WHERE m.project_id = p.id AND m.employee_id = $1 AND m.active)) ORDER BY p.number`, [employeeId]);
  if (!projects.length) return [];
  const tasks = await many(tx, `SELECT id, project_id, name, billable FROM project_task WHERE project_id = ANY ($1) AND active ORDER BY sort_no, name`, [projects.map((p) => p.id)]);
  return projects.map((p) => ({ ...p, billable: p.billing_type !== 'non_billable', tasks: tasks.filter((t) => t.project_id === p.id).map(({ project_id, ...t }) => t) }));
}
