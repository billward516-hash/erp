import type { Tx } from '../../platform/db/tx.js';
import { many } from '../../platform/db/tx.js';
import { notify, usersWithPermission } from '../../platform/notify/notify.js';
import { BREACHED_SQL, RISK_FIRST, RISK_RES } from './service.js';

/*
 * Ticket alerts from the daily reminder sweep. The sweep runs once a day (the product has no shorter timer), so an alert can be up to a day
 * after the moment a target slipped; the queue itself always shows the live state, computed from the stored due times when it is read.
 *
 * - Breach: the assignee and the people who manage tickets at the site, once for each timer (first response, resolution) of a ticket.
 * - At risk: the same people, once for each timer, when it has used its at-risk share (80% unless the service level says otherwise).
 * - Waiting too long: the assignee when a ticket has waited on the customer or a third party for the lead days (the repeat is the company's).
 * Each notice carries a dedupe key, so running the sweep again sends nothing twice.
 */
interface Settings { on(key: string): boolean; lead(key: string): number; period(key: string): string }

export const TICKET_WAITING_DEFAULT_DAYS = 7;

export async function remindTickets(tx: Tx, tenantId: string, R: Settings) {
  const counts = { breached: 0, atRisk: 0, waiting: 0 };
  const managers = new Map<string, string[]>();
  const managersAt = async (facilityId: string) => {
    if (!managers.has(facilityId)) managers.set(facilityId, await usersWithPermission(tx, 'tickets.manage', facilityId));
    return managers.get(facilityId)!;
  };
  const recipients = async (t: { facility_id: string; assignee_user_id: string | null }) => [...new Set([...(t.assignee_user_id ? [t.assignee_user_id] : []), ...(await managersAt(t.facility_id))])];

  if (R.on('ticket_breach')) {
    const rows = await many(tx, `SELECT t.id, t.number, t.subject, t.facility_id, t.assignee_user_id, t.reopened_count, c.name AS customer,
        ${'(t.first_responded_at IS NULL AND t.first_response_due_at < now())'} AS first_late, (t.resolution_due_at < now()) AS resolution_late
      FROM ticket t JOIN customer c ON c.id = t.customer_id WHERE ${BREACHED_SQL}`);
    for (const t of rows) {
      for (const [timer, late, what] of [['first', t.first_late, 'first response'], ['resolution', t.resolution_late, 'resolution']] as const) {
        if (!late) continue;
        counts.breached += await notify(tx, tenantId, await recipients(t), { kind: 'ticket.breach', title: `Service level breached: ${t.number} ${what}`,
          body: `${t.customer}: ${t.subject}${t.assignee_user_id ? '' : ' (nobody is assigned)'}`, link: `/tickets/${t.id}`, subjectType: 'ticket', subjectId: t.id,
          dedupeKey: `ticket-breach:${t.id}:${timer}:${t.reopened_count}:${R.period('ticket_breach')}` });
      }
    }
  }

  if (R.on('ticket_at_risk')) {
    const rows = await many(tx, `SELECT t.id, t.number, t.subject, t.facility_id, t.assignee_user_id, t.reopened_count, t.at_risk_pct, c.name AS customer,
        ${RISK_FIRST} AS first_risk, ${RISK_RES} AS resolution_risk
      FROM ticket t JOIN customer c ON c.id = t.customer_id WHERE t.status NOT IN ('resolved', 'closed') AND (${RISK_FIRST} OR ${RISK_RES})`);
    for (const t of rows) {
      for (const [timer, risk, what] of [['first', t.first_risk, 'first response'], ['resolution', t.resolution_risk, 'resolution']] as const) {
        if (!risk) continue;
        counts.atRisk += await notify(tx, tenantId, await recipients(t), { kind: 'ticket.at_risk', title: `At risk: ${t.number} ${what} has used ${t.at_risk_pct}% of its time`,
          body: `${t.customer}: ${t.subject}`, link: `/tickets/${t.id}`, subjectType: 'ticket', subjectId: t.id,
          dedupeKey: `ticket-risk:${t.id}:${timer}:${t.reopened_count}:${R.period('ticket_at_risk')}` });
      }
    }
  }

  if (R.on('ticket_waiting')) {
    const rows = await many(tx, `SELECT t.id, t.number, t.subject, t.status, t.facility_id, t.assignee_user_id, c.name AS customer, (now()::date - t.status_changed_at::date) AS days
      FROM ticket t JOIN customer c ON c.id = t.customer_id
      WHERE t.status IN ('waiting_customer', 'waiting_third_party') AND t.assignee_user_id IS NOT NULL AND t.status_changed_at < now() - make_interval(days => $1)`, [R.lead('ticket_waiting')]);
    for (const t of rows) {
      counts.waiting += await notify(tx, tenantId, [t.assignee_user_id], { kind: 'ticket.waiting', title: `${t.number} has waited ${t.days} days on ${t.status === 'waiting_customer' ? 'the customer' : 'a third party'}`,
        body: `${t.customer}: ${t.subject}. Chase it, or resolve it if nothing more is needed.`, link: `/tickets/${t.id}`, subjectType: 'ticket', subjectId: t.id,
        dedupeKey: `ticket-waiting:${t.id}:${t.status}:${R.period('ticket_waiting')}` });
    }
  }
  return counts;
}

/** For What is late: tickets past a target, and tickets that have waited too long. */
export async function lateTickets(tx: Tx, facilityIds: string[], waitingDays: number) {
  const breached = await many(tx, `SELECT t.id, t.number, t.subject, c.name AS customer, u.display_name AS owner, t.first_responded_at, t.first_response_due_at, t.resolution_due_at,
      ((t.first_responded_at IS NULL AND t.first_response_due_at < now())) AS first_late
    FROM ticket t JOIN customer c ON c.id = t.customer_id LEFT JOIN app_user u ON u.id = t.assignee_user_id
    WHERE t.facility_id = ANY ($1) AND ${BREACHED_SQL}
    ORDER BY LEAST(CASE WHEN t.first_responded_at IS NULL THEN t.first_response_due_at END, t.resolution_due_at)`, [facilityIds]);
  const waiting = await many(tx, `SELECT t.id, t.number, t.subject, t.status, c.name AS customer, u.display_name AS owner, (now()::date - t.status_changed_at::date) AS days
    FROM ticket t JOIN customer c ON c.id = t.customer_id LEFT JOIN app_user u ON u.id = t.assignee_user_id
    WHERE t.facility_id = ANY ($1) AND t.status IN ('waiting_customer', 'waiting_third_party') AND t.status_changed_at < now() - make_interval(days => $2) ORDER BY t.status_changed_at`, [facilityIds, waitingDays]);
  return { breached, waiting };
}
