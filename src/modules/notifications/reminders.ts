
import { many, withTx } from '../../platform/db/tx.js';
import { notify, usersForEmployees, usersWithPermission } from '../../platform/notify/notify.js';
import { dueState, latestMeter } from '../pm/schedule.js';
import { addDays, weekStartOf } from '../time/service.js';

/**
 * Daily reminder sweep for one tenant (run by scripts/run-reminders.ts). It reads across modules and only
 * creates notifications; it changes no business records. Each reminder carries a dedupe key, so running
 * the sweep again the same day (or the same week, for per-item reminders) does not repeat it.
 */
export async function runReminders(tenantId: string, today = new Date().toISOString().slice(0, 10)) {
  return withTx({ tenantId, userId: null, facilityIds: [], allFacilities: true }, async (tx) => {
    const week = weekStartOf(today);
    const counts: Record<string, number> = {};
    const add = (k: string, n: number) => { counts[k] = (counts[k] ?? 0) + n; };
    const facilities = await many(tx, 'SELECT id, code FROM facility');

    // PM plans due (inside their lead window) with no open work order → planners at the facility, one summary a day.
    const plans = await many(tx, `SELECT p.*, (SELECT 1 FROM work_order w WHERE w.pm_plan_id = p.id AND w.status IN ('planned','scheduled','in_progress','on_hold','completed') LIMIT 1) AS has_wo
      FROM pm_plan p WHERE p.active`);
    for (const f of facilities) {
      const due = [];
      for (const p of plans.filter((x) => x.facility_id === f.id && !x.has_wo)) {
        const latest = p.trigger_type === 'meter' ? await latestMeter(tx, p.asset_id, p.meter) : null;
        if (dueState(p, today, latest) !== 'not_due') due.push(p.code);
      }
      if (due.length) {
        add('pm_due', await notify(tx, tenantId, await usersWithPermission(tx, 'work_orders.manage', f.id), { kind: 'reminder.pm_due',
          title: `${due.length} PM plan${due.length === 1 ? '' : 's'} due at ${f.code} without a work order`, body: due.slice(0, 8).join(', '), link: '/pm',
          dedupeKey: `pm-due:${f.id}:${today}` }));
      }
    }

    // Overdue work orders → their assigned technicians, once a week per work order.
    const overdue = await many(tx, `SELECT w.id, w.number, w.title, w.due_at, a.employee_id FROM work_order w JOIN work_order_assignment a ON a.work_order_id = w.id
      WHERE w.status IN ('planned','scheduled','in_progress','on_hold') AND w.due_at < $1::date`, [today]);
    const users = await usersForEmployees(tx, [...new Set(overdue.map((o) => o.employee_id))]);
    for (const o of overdue) {
      add('wo_overdue', await notify(tx, tenantId, [users.get(o.employee_id)], { kind: 'reminder.wo_overdue', title: `Overdue: ${o.number} ${o.title}`,
        body: `Was due ${new Date(o.due_at).toISOString().slice(0, 10)}`, link: `/work-orders/${o.id}`, subjectType: 'work_order', subjectId: o.id, dedupeKey: `wo-overdue:${o.id}:${week}` }));
    }

    // Training due within 7 days or overdue → the learner, weekly.
    const training = await many(tx, `SELECT en.id, en.employee_id, en.due_on, c.code, c.title FROM enrollment en JOIN course_version v ON v.id = en.course_version_id JOIN course c ON c.id = v.course_id
      WHERE en.status IN ('assigned', 'in_progress') AND en.due_on IS NOT NULL AND en.due_on <= $1::date + 7`, [today]);
    const tUsers = await usersForEmployees(tx, [...new Set(training.map((t) => t.employee_id))]);
    for (const t of training) {
      add('training_due', await notify(tx, tenantId, [tUsers.get(t.employee_id)], { kind: 'reminder.training_due',
        title: `${t.due_on < today ? 'Overdue' : 'Due soon'}: ${t.code} ${t.title}`, body: `Due ${t.due_on}`, link: `/training/enrollments/${t.id}`,
        subjectType: 'enrollment', subjectId: t.id, dedupeKey: `training-due:${t.id}:${week}` }));
    }

    // Qualifications expiring within 30 days (latest grant only) → the holder, weekly.
    const quals = await many(tx, `SELECT g.id, g.employee_id, g.expires_on, q.code, q.name FROM employee_qualification g JOIN qualification q ON q.id = g.qualification_id
      WHERE g.revoked_at IS NULL AND g.expires_on BETWEEN $1::date AND $1::date + 30
        AND NOT EXISTS (SELECT 1 FROM employee_qualification n WHERE n.employee_id = g.employee_id AND n.qualification_id = g.qualification_id
                        AND n.revoked_at IS NULL AND n.expires_on > g.expires_on)`, [today]);
    const qUsers = await usersForEmployees(tx, [...new Set(quals.map((q) => q.employee_id))]);
    for (const q of quals) {
      add('qualification_expiring', await notify(tx, tenantId, [qUsers.get(q.employee_id)], { kind: 'reminder.qualification_expiring',
        title: `Your ${q.name} qualification expires ${q.expires_on}`, body: 'Ask your supervisor about renewal training.', link: '/training',
        subjectType: 'employee_qualification', subjectId: q.id, dedupeKey: `qual-expiring:${q.id}:${week}` }));
    }

    // Late purchase orders → buyers, weekly per order.
    const late = await many(tx, `SELECT o.id, o.number, o.facility_id, o.expected_on, s.name FROM purchase_order o JOIN supplier s ON s.id = o.supplier_id
      WHERE o.status IN ('open', 'partially_received') AND o.expected_on < $1::date`, [today]);
    for (const o of late) {
      add('po_late', await notify(tx, tenantId, await usersWithPermission(tx, 'purchasing.manage', o.facility_id), { kind: 'reminder.po_late',
        title: `Late delivery: ${o.number} from ${o.name}`, body: `Expected ${o.expected_on}`, link: `/purchasing/orders/${o.id}`,
        subjectType: 'purchase_order', subjectId: o.id, dedupeKey: `po-late:${o.id}:${week}` }));
    }

    // Supplier invoices waiting for approval → AP approvers other than the capturer, one summary a day per facility.
    for (const f of facilities) {
      const inv = await many(tx, `SELECT captured_by FROM supplier_invoice WHERE facility_id = $1 AND status = 'captured'`, [f.id]);
      if (!inv.length) continue;
      const approvers = (await usersWithPermission(tx, 'ap.manage', f.id)).filter((u) => inv.some((i) => i.captured_by !== u));
      add('invoices_waiting', await notify(tx, tenantId, approvers, { kind: 'reminder.invoices_waiting', title: `${inv.length} supplier invoice${inv.length === 1 ? '' : 's'} at ${f.code} waiting for approval`,
        link: '/ap', dedupeKey: `invoices-waiting:${f.id}:${today}` }));
    }

    // Last week's timesheet not submitted → the employee; submitted and waiting → approvers (daily summary).
    const lastWeek = addDays(week, -7);
    const missing = await many(tx, `SELECT e.id FROM employee e WHERE e.status = 'active' AND e.facility_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM timesheet t WHERE t.employee_id = e.id AND t.week_start = $1 AND t.status IN ('submitted', 'approved', 'exported'))`, [lastWeek]);
    const mUsers = await usersForEmployees(tx, missing.map((m) => m.id));
    for (const m of missing) {
      add('timesheet_missing', await notify(tx, tenantId, [mUsers.get(m.id)], { kind: 'reminder.timesheet_missing', title: `Submit your timesheet for the week of ${lastWeek}`,
        link: '/time', dedupeKey: `timesheet-missing:${m.id}:${lastWeek}` }));
    }
    for (const f of facilities) {
      const waiting = await many(tx, `SELECT employee_id, submitted_by FROM timesheet WHERE facility_id = $1 AND status = 'submitted'`, [f.id]);
      if (!waiting.length) continue;
      const own = await usersForEmployees(tx, waiting.map((w) => w.employee_id));
      const approvers = (await usersWithPermission(tx, 'time.approve', f.id)).filter((u) => waiting.some((w) => own.get(w.employee_id) !== u && w.submitted_by !== u));
      add('timesheets_waiting', await notify(tx, tenantId, approvers, { kind: 'reminder.timesheets_waiting', title: `${waiting.length} timesheet${waiting.length === 1 ? '' : 's'} at ${f.code} waiting for approval`,
        link: '/time', dedupeKey: `timesheets-waiting:${f.id}:${today}` }));
    }

    // Accounting deliveries parked as failed → integration admins, daily.
    const dead = (await many(tx, `SELECT count(*)::int AS n FROM sync_delivery d JOIN integration_connection c ON c.id = d.connection_id WHERE c.active AND d.status = 'dead'`))[0]!.n;
    if (dead) {
      add('sync_failed', await notify(tx, tenantId, await usersWithPermission(tx, 'integrations.manage', null), { kind: 'reminder.sync_failed',
        title: `${dead} accounting sync item${dead === 1 ? '' : 's'} need attention`, link: '/integrations', dedupeKey: `sync-failed:${today}` }));
    }

    // Temporary changes ending within 14 days → their owner, weekly.
    const temp = await many(tx, `SELECT id, number, title, owner_user_id, temporary_until FROM moc_change
      WHERE is_temporary AND status NOT IN ('closed', 'cancelled', 'rejected') AND temporary_until <= $1::date + 14`, [today]);
    for (const c of temp) {
      add('temporary_change_ending', await notify(tx, tenantId, [c.owner_user_id], { kind: 'reminder.temporary_change_ending',
        title: `${c.temporary_until < today ? 'Past its end date' : `Ends ${c.temporary_until}`}: ${c.number} ${c.title}`, body: 'Restore the original condition or extend through a change.',
        link: `/changes/${c.id}`, subjectType: 'moc_change', subjectId: c.id, dedupeKey: `temp-ending:${c.id}:${week}` }));
    }
    return counts;
  });
}

