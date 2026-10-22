
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
    // Sales follow-up tasks due today or overdue → their owner, daily.
    const tasks = await many(tx, `SELECT a.id, a.summary, a.due_on, a.owner_user_id, a.invoice_id, c.name, c.id AS customer_id FROM activity a JOIN customer c ON c.id = a.customer_id
      WHERE a.kind = 'task' AND a.done_at IS NULL AND a.due_on <= $1::date`, [today]);
    for (const a of tasks) {
      add('crm_task_due', await notify(tx, tenantId, [a.owner_user_id], { kind: 'reminder.crm_task_due', title: `${a.due_on < today ? 'Overdue follow-up' : 'Follow-up due today'}: ${a.name}`,
        body: a.summary, link: a.invoice_id ? `/receivables/${a.invoice_id}` : `/crm/customers/${a.customer_id}`, subjectType: 'activity', subjectId: a.id, dedupeKey: `crm-task:${a.id}:${today}` }));
    }

    // Sent quotes expiring within 7 days with no decision → whoever prepared them, once.
    const expiring = await many(tx, `SELECT q.id, q.number, q.valid_until, q.created_by, c.name FROM quote q JOIN customer c ON c.id = q.customer_id
      WHERE q.status = 'sent' AND q.valid_until BETWEEN $1::date AND $1::date + 7`, [today]);
    for (const q of expiring) {
      add('quote_expiring', await notify(tx, tenantId, [q.created_by], { kind: 'reminder.quote_expiring', title: `${q.number} for ${q.name} expires ${q.valid_until}`,
        body: 'Follow up with the customer, or revise the quote to extend it.', link: `/sales/quotes/${q.id}`, subjectType: 'quote', subjectId: q.id, dedupeKey: `quote-expiring:${q.id}:${q.valid_until}` }));
    }

    // Overdue actions (corrective and safety) → their owner, daily.
    const lateActions = await many(tx, `SELECT a.id, a.title, a.owner_user_id, a.subject_type, a.subject_id, a.due_date, coalesce(c.number, i.number, qa.number) AS number
      FROM action_item a LEFT JOIN corrective_action c ON a.subject_type = 'corrective_action' AND c.id = a.subject_id
      LEFT JOIN safety_incident i ON a.subject_type = 'safety_incident' AND i.id = a.subject_id
      LEFT JOIN quality_audit qa ON a.subject_type = 'quality_audit' AND qa.id = a.subject_id WHERE a.status = 'open' AND a.due_date < $1::date`, [today]);
    const ACTION_LINK: Record<string, string> = { corrective_action: '/quality/capa/', safety_incident: '/safety/', quality_audit: '/quality/audits/' };
    for (const a of lateActions) {
      add('action_overdue', await notify(tx, tenantId, [a.owner_user_id], { kind: 'reminder.action_overdue', title: `Overdue since ${a.due_date}: ${a.title} (${a.number})`,
        link: `${ACTION_LINK[a.subject_type]}${a.subject_id}`, subjectType: a.subject_type, subjectId: a.subject_id, dedupeKey: `action-late:${a.id}:${today}` }));
    }
    // Corrective actions due for their effectiveness check → quality staff other than the owner, weekly.
    const verify = await many(tx, `SELECT id, number, title, facility_id, owner_user_id FROM corrective_action WHERE status = 'verification' AND (verify_after IS NULL OR verify_after <= $1::date)`, [today]);
    for (const c of verify) {
      const who = (await usersWithPermission(tx, 'quality.manage', c.facility_id)).filter((u) => u !== c.owner_user_id);
      add('capa_verification_due', await notify(tx, tenantId, who, { kind: 'reminder.capa_verification_due', title: `${c.number} is ready for its effectiveness check: ${c.title}`,
        link: `/quality/capa/${c.id}`, subjectType: 'corrective_action', subjectId: c.id, dedupeKey: `capa-verify:${c.id}:${week}` }));
    }
    // Incidents still unclassified a day after being reported → safety staff, daily.
    const unclassified = await many(tx, `SELECT id, number, facility_id FROM safety_incident WHERE status = 'reported' AND created_at < $1::date`, [today]);
    for (const i of unclassified) {
      add('incident_unclassified', await notify(tx, tenantId, await usersWithPermission(tx, 'safety.manage', i.facility_id), { kind: 'reminder.incident_unclassified',
        title: `${i.number} has not been classified yet`, link: `/safety/${i.id}`, subjectType: 'safety_incident', subjectId: i.id, dedupeKey: `inc-unclassified:${i.id}:${today}` }));
    }

    // Calibration: overdue instruments daily, due within 14 days weekly → quality staff at the site.
    for (const f of facilities) {
      const cal = await many(tx, `SELECT a.asset_tag, p.next_due FROM calibration_plan p JOIN asset a ON a.id = p.asset_id WHERE p.facility_id = $1 AND p.active AND p.next_due <= $2::date + 14 ORDER BY p.next_due`, [f.id, today]);
      if (!cal.length) continue;
      const over = cal.filter((c) => c.next_due < today);
      const who = await usersWithPermission(tx, 'quality.manage', f.id);
      if (over.length) {
        add('calibration_overdue', await notify(tx, tenantId, who, { kind: 'reminder.calibration_due', title: `${over.length} instrument${over.length === 1 ? '' : 's'} at ${f.code} overdue for calibration: ${over.slice(0, 4).map((c) => c.asset_tag).join(', ')}`,
          body: 'Overdue instruments cannot be used for production runs.', link: '/quality?tab=calibration', dedupeKey: `cal-overdue:${f.id}:${today}` }));
      }
      const soon = cal.filter((c) => c.next_due >= today);
      if (soon.length) {
        add('calibration_due', await notify(tx, tenantId, who, { kind: 'reminder.calibration_due', title: `${soon.length} instrument${soon.length === 1 ? '' : 's'} at ${f.code} due for calibration within 14 days`,
          body: soon.slice(0, 6).map((c) => `${c.asset_tag} ${c.next_due}`).join(', '), link: '/quality?tab=calibration', dedupeKey: `cal-soon:${f.id}:${week}` }));
      }
    }

    // Kits short of parts for work due within 7 days → storeroom and maintenance planners at the site, daily.
    for (const f of facilities) {
      const shortKits = await many(tx, `SELECT k.number, w.number AS wo FROM kit k JOIN work_order w ON w.id = k.work_order_id
        WHERE k.facility_id = $1 AND k.status = 'reserved' AND w.due_at < $2::date + 8
          AND EXISTS (SELECT 1 FROM kit_line l WHERE l.kit_id = k.id AND l.qty_reserved < l.qty_needed)`, [f.id, today]);
      if (!shortKits.length) continue;
      const who = [...new Set([...(await usersWithPermission(tx, 'inventory.manage', f.id)), ...(await usersWithPermission(tx, 'work_orders.manage', f.id))])];
      add('kits_short', await notify(tx, tenantId, who, { kind: 'reminder.kits_short', title: `${shortKits.length} kit${shortKits.length === 1 ? '' : 's'} at ${f.code} short of parts for work due within 7 days`,
        body: shortKits.slice(0, 6).map((k) => `${k.number} (${k.wo})`).join(', '), link: '/inventory?tab=kits', dedupeKey: `kits-short:${f.id}:${today}` }));
    }

    // Overdue customer invoices → receivables staff at the site, weekly summary.
    for (const f of facilities) {
      const late = (await many(tx, `SELECT count(*)::int AS n, coalesce(sum((SELECT coalesce(sum(l.qty * l.unit_price), 0) FROM customer_invoice_line l WHERE l.invoice_id = i.id)
          + i.freight_amount + i.tax_amount - (SELECT coalesce(sum(a.amount), 0) FROM payment_allocation a WHERE a.invoice_id = i.id)), 0)::float AS owed
        FROM customer_invoice i WHERE i.facility_id = $1 AND i.status IN ('issued', 'partially_paid') AND i.due_date < $2::date`, [f.id, today]))[0]!;
      if (!late.n) continue;
      add('receivables_overdue', await notify(tx, tenantId, await usersWithPermission(tx, 'ar.manage', f.id), { kind: 'reminder.receivables_overdue',
        title: `${late.n} customer invoice${late.n === 1 ? '' : 's'} at ${f.code} overdue, ${late.owed.toFixed(2)} USD`, body: 'Work the collections queue: call, log what was said, or send a reminder.',
        link: '/receivables?tab=collections', dedupeKey: `ar-overdue:${f.id}:${week}` }));
    }
    return counts;
  });
}

