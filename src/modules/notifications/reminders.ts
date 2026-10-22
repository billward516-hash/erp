import { many, withTx } from '../../platform/db/tx.js';
import { notify, usersForEmployees, usersWithPermission } from '../../platform/notify/notify.js';
import { dueState, latestMeter } from '../pm/schedule.js';
import { addDays, weekStartOf } from '../time/service.js';
import { sweepSettings } from '../reminders/settings.js';
import { fiscalMonths } from '../budgets/engine.js';

/**
 * Daily reminder sweep for one tenant (run by scripts/run-reminders.ts). What each reminder does, its defaults and
 * the company's settings are in modules/reminders (D-153); repeat chooses the dedupe period (day, week, or once). It reads across modules and only
 * creates notifications; it changes no business records. Each reminder carries a dedupe key, so running
 * the sweep again the same day (or the same week, for per-item reminders) does not repeat it.
 */
export async function runReminders(tenantId: string, today = new Date().toISOString().slice(0, 10)) {
  return withTx({ tenantId, userId: null, facilityIds: [], allFacilities: true }, async (tx) => {
    const week = weekStartOf(today);
    const counts: Record<string, number> = {};
    const add = (k: string, n: number) => { counts[k] = (counts[k] ?? 0) + n; };
    const facilities = await many(tx, 'SELECT id, code FROM facility');
    // Each company's settings (D-153): which reminders are on, how far ahead, and how often they repeat.
    const R = await sweepSettings(tx, tenantId, today, week);

    // PM plans due (inside their lead window) with no open work order → planners at the facility, one summary a day.
    if (R.on('pm_due')) {
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
            dedupeKey: `pm-due:${f.id}:${R.period('pm_due')}` }));
        }
      }
    }

    // Overdue work orders → their assigned technicians, once a week per work order.
    if (R.on('wo_overdue')) {
      const overdue = await many(tx, `SELECT w.id, w.number, w.title, w.due_at, a.employee_id FROM work_order w JOIN work_order_assignment a ON a.work_order_id = w.id
        WHERE w.status IN ('planned','scheduled','in_progress','on_hold') AND w.due_at < $1::date`, [today]);
      const users = await usersForEmployees(tx, [...new Set(overdue.map((o) => o.employee_id))]);
      for (const o of overdue) {
        add('wo_overdue', await notify(tx, tenantId, [users.get(o.employee_id)], { kind: 'reminder.wo_overdue', title: `Overdue: ${o.number} ${o.title}`,
          body: `Was due ${new Date(o.due_at).toISOString().slice(0, 10)}`, link: `/work-orders/${o.id}`, subjectType: 'work_order', subjectId: o.id, dedupeKey: `wo-overdue:${o.id}:${R.period('wo_overdue')}` }));
      }
    }

    // Training due within the lead days (default 7) or overdue → the learner, weekly.
    if (R.on('training_due')) {
      const training = await many(tx, `SELECT en.id, en.employee_id, en.due_on, c.code, c.title FROM enrollment en JOIN course_version v ON v.id = en.course_version_id JOIN course c ON c.id = v.course_id
        WHERE en.status IN ('assigned', 'in_progress') AND en.due_on IS NOT NULL AND en.due_on <= $1::date + $2::int`, [today, R.lead('training_due')]);
      const tUsers = await usersForEmployees(tx, [...new Set(training.map((t) => t.employee_id))]);
      for (const t of training) {
        add('training_due', await notify(tx, tenantId, [tUsers.get(t.employee_id)], { kind: 'reminder.training_due',
          title: `${t.due_on < today ? 'Overdue' : 'Due soon'}: ${t.code} ${t.title}`, body: `Due ${t.due_on}`, link: `/training/enrollments/${t.id}`,
          subjectType: 'enrollment', subjectId: t.id, dedupeKey: `training-due:${t.id}:${R.period('training_due')}` }));
      }
    }

    // Qualifications expiring within the lead days (default 30) (latest grant only) → the holder, weekly.
    if (R.on('qualification_expiring')) {
      const quals = await many(tx, `SELECT g.id, g.employee_id, g.expires_on, q.code, q.name FROM employee_qualification g JOIN qualification q ON q.id = g.qualification_id
        WHERE g.revoked_at IS NULL AND g.expires_on BETWEEN $1::date AND $1::date + $2::int
          AND NOT EXISTS (SELECT 1 FROM employee_qualification n WHERE n.employee_id = g.employee_id AND n.qualification_id = g.qualification_id
                          AND n.revoked_at IS NULL AND n.expires_on > g.expires_on)`, [today, R.lead('qualification_expiring')]);
      const qUsers = await usersForEmployees(tx, [...new Set(quals.map((q) => q.employee_id))]);
      for (const q of quals) {
        add('qualification_expiring', await notify(tx, tenantId, [qUsers.get(q.employee_id)], { kind: 'reminder.qualification_expiring',
          title: `Your ${q.name} qualification expires ${q.expires_on}`, body: 'Ask your supervisor about renewal training.', link: '/training',
          subjectType: 'employee_qualification', subjectId: q.id, dedupeKey: `qual-expiring:${q.id}:${R.period('qualification_expiring')}` }));
      }
    }

    // Late purchase orders → buyers, weekly per order.
    if (R.on('po_late')) {
      const late = await many(tx, `SELECT o.id, o.number, o.facility_id, o.expected_on, s.name FROM purchase_order o JOIN supplier s ON s.id = o.supplier_id
        WHERE o.status IN ('open', 'partially_received') AND o.expected_on < $1::date`, [today]);
      for (const o of late) {
        add('po_late', await notify(tx, tenantId, await usersWithPermission(tx, 'purchasing.manage', o.facility_id), { kind: 'reminder.po_late',
          title: `Late delivery: ${o.number} from ${o.name}`, body: `Expected ${o.expected_on}`, link: `/purchasing/orders/${o.id}`,
          subjectType: 'purchase_order', subjectId: o.id, dedupeKey: `po-late:${o.id}:${R.period('po_late')}` }));
      }
    }

    // Supplier invoices waiting for approval → AP approvers other than the capturer, one summary a day per facility.
    if (R.on('invoices_waiting')) {
      for (const f of facilities) {
        const inv = await many(tx, `SELECT captured_by FROM supplier_invoice WHERE facility_id = $1 AND status = 'captured'`, [f.id]);
        if (!inv.length) continue;
        const approvers = (await usersWithPermission(tx, 'ap.manage', f.id)).filter((u) => inv.some((i) => i.captured_by !== u));
        add('invoices_waiting', await notify(tx, tenantId, approvers, { kind: 'reminder.invoices_waiting', title: `${inv.length} supplier invoice${inv.length === 1 ? '' : 's'} at ${f.code} waiting for approval`,
          link: '/ap', dedupeKey: `invoices-waiting:${f.id}:${R.period('invoices_waiting')}` }));
      }
    }

    // Last week's timesheet not submitted → the employee; submitted and waiting → approvers (daily summary).
    const lastWeek = addDays(week, -7);
    if (R.on('timesheet_missing')) {
      const missing = await many(tx, `SELECT e.id FROM employee e WHERE e.status = 'active' AND e.facility_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM timesheet t WHERE t.employee_id = e.id AND t.week_start = $1 AND t.status IN ('submitted', 'approved', 'exported'))`, [lastWeek]);
      const mUsers = await usersForEmployees(tx, missing.map((m) => m.id));
      for (const m of missing) {
        add('timesheet_missing', await notify(tx, tenantId, [mUsers.get(m.id)], { kind: 'reminder.timesheet_missing', title: `Submit your timesheet for the week of ${lastWeek}`,
          link: '/time', dedupeKey: `timesheet-missing:${m.id}:${lastWeek}` }));
      }
    }
    if (R.on('timesheets_waiting')) {
      for (const f of facilities) {
        const waiting = await many(tx, `SELECT employee_id, submitted_by FROM timesheet WHERE facility_id = $1 AND status = 'submitted'`, [f.id]);
        if (!waiting.length) continue;
        const own = await usersForEmployees(tx, waiting.map((w) => w.employee_id));
        const approvers = (await usersWithPermission(tx, 'time.approve', f.id)).filter((u) => waiting.some((w) => own.get(w.employee_id) !== u && w.submitted_by !== u));
        add('timesheets_waiting', await notify(tx, tenantId, approvers, { kind: 'reminder.timesheets_waiting', title: `${waiting.length} timesheet${waiting.length === 1 ? '' : 's'} at ${f.code} waiting for approval`,
          link: '/time', dedupeKey: `timesheets-waiting:${f.id}:${R.period('timesheets_waiting')}` }));
      }
    }

    // Accounting deliveries parked as failed → integration admins, daily.
    if (R.on('sync_failed')) {
      const dead = (await many(tx, `SELECT count(*)::int AS n FROM sync_delivery d JOIN integration_connection c ON c.id = d.connection_id WHERE c.active AND d.status = 'dead'`))[0]!.n;
      if (dead) {
        add('sync_failed', await notify(tx, tenantId, await usersWithPermission(tx, 'integrations.manage', null), { kind: 'reminder.sync_failed',
          title: `${dead} accounting sync item${dead === 1 ? '' : 's'} need attention`, link: '/integrations', dedupeKey: `sync-failed:${R.period('sync_failed')}` }));
      }
    }

    // Temporary changes ending within the lead days (default 14) → their owner, weekly.
    if (R.on('temporary_change_ending')) {
      const temp = await many(tx, `SELECT id, number, title, owner_user_id, temporary_until FROM moc_change
        WHERE is_temporary AND status NOT IN ('closed', 'cancelled', 'rejected') AND temporary_until <= $1::date + $2::int`, [today, R.lead('temporary_change_ending')]);
      for (const c of temp) {
        add('temporary_change_ending', await notify(tx, tenantId, [c.owner_user_id], { kind: 'reminder.temporary_change_ending',
          title: `${c.temporary_until < today ? 'Past its end date' : `Ends ${c.temporary_until}`}: ${c.number} ${c.title}`, body: 'Restore the original condition or extend through a change.',
          link: `/changes/${c.id}`, subjectType: 'moc_change', subjectId: c.id, dedupeKey: `temp-ending:${c.id}:${R.period('temporary_change_ending')}` }));
      }
    }

    // Sales follow-up tasks due today or overdue → their owner, daily.
    if (R.on('crm_task_due')) {
      const tasks = await many(tx, `SELECT a.id, a.summary, a.due_on, a.owner_user_id, a.invoice_id, c.name, c.id AS customer_id FROM activity a JOIN customer c ON c.id = a.customer_id
        WHERE a.kind = 'task' AND a.done_at IS NULL AND a.due_on <= $1::date`, [today]);
      for (const a of tasks) {
        add('crm_task_due', await notify(tx, tenantId, [a.owner_user_id], { kind: 'reminder.crm_task_due', title: `${a.due_on < today ? 'Overdue follow-up' : 'Follow-up due today'}: ${a.name}`,
          body: a.summary, link: a.invoice_id ? `/receivables/${a.invoice_id}` : `/crm/customers/${a.customer_id}`, subjectType: 'activity', subjectId: a.id, dedupeKey: `crm-task:${a.id}:${R.period('crm_task_due')}` }));
      }
    }

    // Sent quotes expiring within the lead days (default 7) with no decision → whoever prepared them, once.
    if (R.on('quote_expiring')) {
      const expiring = await many(tx, `SELECT q.id, q.number, q.valid_until, q.created_by, c.name FROM quote q JOIN customer c ON c.id = q.customer_id
        WHERE q.status = 'sent' AND q.valid_until BETWEEN $1::date AND $1::date + $2::int`, [today, R.lead('quote_expiring')]);
      for (const q of expiring) {
        add('quote_expiring', await notify(tx, tenantId, [q.created_by], { kind: 'reminder.quote_expiring', title: `${q.number} for ${q.name} expires ${q.valid_until}`,
          body: 'Follow up with the customer, or revise the quote to extend it.', link: `/sales/quotes/${q.id}`, subjectType: 'quote', subjectId: q.id, dedupeKey: `quote-expiring:${q.id}:${q.valid_until}:${R.period('quote_expiring')}` }));
      }
    }

    // Continuity plans whose review is due within the lead days (default 30), or whose exercise is due with none scheduled → owner and alternate, weekly.
    if (R.on('continuity_review_due')) {
      const bcp = await many(tx, `SELECT p.id, p.number, p.title, p.owner_user_id, p.alternate_user_id, p.review_due,
          (coalesce((SELECT max(e.conducted_on) FROM continuity_exercise e JOIN continuity_plan x ON x.id = e.plan_id WHERE x.tenant_id = p.tenant_id AND x.number = p.number AND e.status = 'completed'),
            p.approved_at::date) + make_interval(months => p.exercise_interval_months))::date AS exercise_due,
          EXISTS (SELECT 1 FROM continuity_exercise e WHERE e.plan_id = p.id AND e.status = 'scheduled') AS scheduled
        FROM continuity_plan p WHERE p.status = 'approved'`);
      for (const p of bcp) {
        const d = (x: any) => (x ? new Date(x).toISOString().slice(0, 10) : null);
        const soon = addDays(today, R.lead('continuity_review_due'));
        const parts = [];
        if (d(p.review_due) && d(p.review_due)! <= soon) parts.push(`review ${d(p.review_due)! < today ? 'overdue since' : 'due'} ${d(p.review_due)}`);
        if (!p.scheduled && d(p.exercise_due) && d(p.exercise_due)! <= soon) parts.push(`exercise ${d(p.exercise_due)! < today ? 'overdue since' : 'due'} ${d(p.exercise_due)}, none scheduled`);
        if (!parts.length) continue;
        add('continuity_review_due', await notify(tx, tenantId, [p.owner_user_id, p.alternate_user_id].filter(Boolean), { kind: 'reminder.continuity_review_due',
          title: `${p.number} ${p.title}: ${parts.join('; ')}`, link: `/continuity/${p.id}`, subjectType: 'continuity_plan', subjectId: p.id, dedupeKey: `bcp-due:${p.id}:${R.period('continuity_review_due')}` }));
      }
    }

    // Condition readings overdue (no reading within 1.5 × the interval) → people who log readings at the site, daily.
    if (R.on('readings_missed')) {
      for (const f of facilities) {
        const late = await many(tx, `SELECT a.asset_tag FROM condition_point p JOIN asset a ON a.id = p.asset_id WHERE p.facility_id = $1 AND p.active AND p.interval_hours IS NOT NULL
          AND coalesce((SELECT max(r.read_at) FROM condition_reading r WHERE r.point_id = p.id), p.created_at) < now() - make_interval(hours => (p.interval_hours * 1.5)::int)`, [f.id]);
        if (!late.length) continue;
        add('readings_missed', await notify(tx, tenantId, await usersWithPermission(tx, 'assets.record_state', f.id), { kind: 'reminder.readings_missed',
          title: `${f.code}: ${late.length} condition reading${late.length === 1 ? '' : 's'} overdue`, body: late.slice(0, 8).map((x) => x.asset_tag).join(', '), link: '/stores', dedupeKey: `readings-missed:${f.id}:${R.period('readings_missed')}` }));
      }
    }

    // Leasing: leases ending within the lead days (default 60) with no renewal or notice, and unit turns past their target → leasing managers per site, weekly.
    if (R.on('leasing_due')) {
      for (const f of facilities) {
        const ending = await many(tx, `SELECT l.number FROM lease l WHERE l.facility_id = $1 AND l.status = 'active' AND l.end_date BETWEEN $2::date AND $2::date + $3::int
          AND NOT EXISTS (SELECT 1 FROM lease n WHERE n.renewed_from_id = l.id)`, [f.id, today, R.lead('leasing_due')]);
        const late = await many(tx, `SELECT a.asset_tag FROM unit_turn t JOIN rental_unit r ON r.id = t.unit_id JOIN asset a ON a.id = r.asset_id
          WHERE t.facility_id = $1 AND t.status = 'open' AND t.target_ready_on < $2::date`, [f.id, today]);
        if (!ending.length && !late.length) continue;
        const parts = [ending.length ? `${ending.length} lease${ending.length === 1 ? '' : 's'} ending within ${R.lead('leasing_due')} days without renewal` : '', late.length ? `${late.length} unit turn${late.length === 1 ? '' : 's'} past target (${late.slice(0, 4).map((x) => x.asset_tag).join(', ')})` : ''].filter(Boolean);
        add('leasing_due', await notify(tx, tenantId, await usersWithPermission(tx, 'leasing.manage', f.id), { kind: 'reminder.leasing_due',
          title: `${f.code}: ${parts.join('; ')}`, link: '/leasing', dedupeKey: `leasing-due:${f.id}:${R.period('leasing_due')}` }));
      }
    }

    // Overdue actions (corrective and safety) → their owner, daily.
    if (R.on('action_overdue')) {
      const lateActions = await many(tx, `SELECT a.id, a.title, a.owner_user_id, a.subject_type, a.subject_id, a.due_date, coalesce(c.number, i.number, qa.number, fm.number, cp.number, sv.number, im.number) AS number
        FROM action_item a LEFT JOIN corrective_action c ON a.subject_type = 'corrective_action' AND c.id = a.subject_id
        LEFT JOIN safety_incident i ON a.subject_type = 'safety_incident' AND i.id = a.subject_id
        LEFT JOIN quality_audit qa ON a.subject_type = 'quality_audit' AND qa.id = a.subject_id
        LEFT JOIN fmea fm ON a.subject_type = 'fmea' AND fm.id = a.subject_id
        LEFT JOIN continuity_plan cp ON a.subject_type = 'continuity_plan' AND cp.id = a.subject_id
        LEFT JOIN site_visit sv ON a.subject_type = 'site_visit' AND sv.id = a.subject_id
        LEFT JOIN improvement im ON a.subject_type = 'improvement' AND im.id = a.subject_id WHERE a.status = 'open' AND a.due_date < $1::date`, [today]);
      const ACTION_LINK: Record<string, string> = { corrective_action: '/quality/capa/', safety_incident: '/safety/', quality_audit: '/quality/audits/', fmea: '/quality/fmea/', continuity_plan: '/continuity/', site_visit: '/stores/visits/', improvement: '/improvements/' };
      for (const a of lateActions) {
        add('action_overdue', await notify(tx, tenantId, [a.owner_user_id], { kind: 'reminder.action_overdue', title: `Overdue since ${a.due_date}: ${a.title} (${a.number})`,
          link: `${ACTION_LINK[a.subject_type]}${a.subject_id}`, subjectType: a.subject_type, subjectId: a.subject_id, dedupeKey: `action-late:${a.id}:${R.period('action_overdue')}` }));
      }
    }

    // Corrective actions due for their effectiveness check → quality staff other than the owner, weekly.
    if (R.on('capa_verification_due')) {
      const verify = await many(tx, `SELECT id, number, title, facility_id, owner_user_id FROM corrective_action WHERE status = 'verification' AND (verify_after IS NULL OR verify_after <= $1::date)`, [today]);
      for (const c of verify) {
        const who = (await usersWithPermission(tx, 'quality.manage', c.facility_id)).filter((u) => u !== c.owner_user_id);
        add('capa_verification_due', await notify(tx, tenantId, who, { kind: 'reminder.capa_verification_due', title: `${c.number} is ready for its effectiveness check: ${c.title}`,
          link: `/quality/capa/${c.id}`, subjectType: 'corrective_action', subjectId: c.id, dedupeKey: `capa-verify:${c.id}:${R.period('capa_verification_due')}` }));
      }
    }

    // Supplier corrective action requests past their response date with no response → the owner, daily.
    if (R.on('scar_overdue')) {
      const scarLate = await many(tx, `SELECT c.id, c.number, c.title, c.owner_user_id, c.supplier_response_due, s.name AS supplier FROM corrective_action c JOIN supplier s ON s.id = c.supplier_id
        WHERE c.supplier_responded_at IS NULL AND c.status NOT IN ('closed', 'cancelled') AND c.supplier_response_due < $1::date`, [today]);
      for (const c of scarLate) {
        add('scar_overdue', await notify(tx, tenantId, [c.owner_user_id], { kind: 'reminder.scar_overdue', title: `${c.supplier} has not answered ${c.number} (due ${String(c.supplier_response_due instanceof Date ? c.supplier_response_due.toISOString() : c.supplier_response_due).slice(0, 10)})`,
          link: `/quality/capa/${c.id}`, subjectType: 'corrective_action', subjectId: c.id, dedupeKey: `scar-late:${c.id}:${R.period('scar_overdue')}` }));
      }
    }

    // Incidents still unclassified a day after being reported → safety staff, daily.
    if (R.on('incident_unclassified')) {
      const unclassified = await many(tx, `SELECT id, number, facility_id FROM safety_incident WHERE status = 'reported' AND created_at < $1::date`, [today]);
      for (const i of unclassified) {
        add('incident_unclassified', await notify(tx, tenantId, await usersWithPermission(tx, 'safety.manage', i.facility_id), { kind: 'reminder.incident_unclassified',
          title: `${i.number} has not been classified yet`, link: `/safety/${i.id}`, subjectType: 'safety_incident', subjectId: i.id, dedupeKey: `inc-unclassified:${i.id}:${R.period('incident_unclassified')}` }));
      }
    }

    // Calibration: overdue instruments daily, due within the lead days (default 14) weekly → quality staff at the site.
    if (R.on('calibration_due') || R.on('calibration_overdue')) {
      for (const f of facilities) {
        const cal = await many(tx, `SELECT a.asset_tag, p.next_due FROM calibration_plan p JOIN asset a ON a.id = p.asset_id WHERE p.facility_id = $1 AND p.active AND p.next_due <= $2::date + $3::int ORDER BY p.next_due`, [f.id, today, R.on('calibration_due') ? R.lead('calibration_due') : 0]);
        if (!cal.length) continue;
        const over = cal.filter((c) => c.next_due < today);
        const who = await usersWithPermission(tx, 'quality.manage', f.id);
        if (over.length && R.on('calibration_overdue')) {
          add('calibration_overdue', await notify(tx, tenantId, who, { kind: 'reminder.calibration_due', title: `${over.length} instrument${over.length === 1 ? '' : 's'} at ${f.code} overdue for calibration: ${over.slice(0, 4).map((c) => c.asset_tag).join(', ')}`,
            body: 'Overdue instruments cannot be used for production runs.', link: '/quality?tab=calibration', dedupeKey: `cal-overdue:${f.id}:${R.period('calibration_overdue')}` }));
        }
        const soon = cal.filter((c) => c.next_due >= today);
        if (soon.length && R.on('calibration_due')) {
          add('calibration_due', await notify(tx, tenantId, who, { kind: 'reminder.calibration_due', title: `${soon.length} instrument${soon.length === 1 ? '' : 's'} at ${f.code} due for calibration within ${R.lead('calibration_due')} days`,
            body: soon.slice(0, 6).map((c) => `${c.asset_tag} ${c.next_due}`).join(', '), link: '/quality?tab=calibration', dedupeKey: `cal-soon:${f.id}:${R.period('calibration_due')}` }));
        }
      }
    }

    // Kits short of parts for work due within the lead days (default 7) → storeroom and maintenance planners at the site, daily.
    if (R.on('kits_short')) {
      for (const f of facilities) {
        const shortKits = await many(tx, `SELECT k.number, w.number AS wo FROM kit k JOIN work_order w ON w.id = k.work_order_id
          WHERE k.facility_id = $1 AND k.status = 'reserved' AND w.due_at < $2::date + $3::int + 1
            AND EXISTS (SELECT 1 FROM kit_line l WHERE l.kit_id = k.id AND l.qty_reserved < l.qty_needed)`, [f.id, today, R.lead('kits_short')]);
        if (!shortKits.length) continue;
        const who = [...new Set([...(await usersWithPermission(tx, 'inventory.manage', f.id)), ...(await usersWithPermission(tx, 'work_orders.manage', f.id))])];
        add('kits_short', await notify(tx, tenantId, who, { kind: 'reminder.kits_short', title: `${shortKits.length} kit${shortKits.length === 1 ? '' : 's'} at ${f.code} short of parts for work due within ${R.lead('kits_short')} days`,
          body: shortKits.slice(0, 6).map((k) => `${k.number} (${k.wo})`).join(', '), link: '/inventory?tab=kits', dedupeKey: `kits-short:${f.id}:${R.period('kits_short')}` }));
      }
    }

    // Overdue customer invoices → receivables staff at the site, weekly summary.
    if (R.on('receivables_overdue')) {
      for (const f of facilities) {
        const late = (await many(tx, `SELECT count(*)::int AS n, coalesce(sum((SELECT coalesce(sum(l.qty * l.unit_price), 0) FROM customer_invoice_line l WHERE l.invoice_id = i.id)
            + i.freight_amount + i.tax_amount - (SELECT coalesce(sum(a.amount), 0) FROM payment_allocation a WHERE a.invoice_id = i.id)), 0)::float AS owed
          FROM customer_invoice i WHERE i.facility_id = $1 AND i.status IN ('issued', 'partially_paid') AND i.due_date < $2::date`, [f.id, today]))[0]!;
        if (!late.n) continue;
        add('receivables_overdue', await notify(tx, tenantId, await usersWithPermission(tx, 'ar.manage', f.id), { kind: 'reminder.receivables_overdue',
          title: `${late.n} customer invoice${late.n === 1 ? '' : 's'} at ${f.code} overdue, ${late.owed.toFixed(2)} USD`, body: 'Work the collections queue: call, log what was said, or send a reminder.',
          link: '/receivables?tab=collections', dedupeKey: `ar-overdue:${f.id}:${R.period('receivables_overdue')}` }));
      }
    }
    // Added by D-153: things nothing watched before.
    // Asset warranties ending within the lead days → asset managers at the site, once per asset and end date.
    if (R.on('warranty_expiring')) {
      const ending = await many(tx, `SELECT id, asset_tag, name, facility_id, warranty_expires_on FROM asset
        WHERE lifecycle_status IN ('planned', 'active') AND warranty_expires_on BETWEEN $1::date AND $1::date + $2::int`, [today, R.lead('warranty_expiring')]);
      for (const a of ending) {
        add('warranty_expiring', await notify(tx, tenantId, await usersWithPermission(tx, 'assets.manage', a.facility_id), { kind: 'reminder.warranty_expiring',
          title: `Warranty on ${a.asset_tag} ${a.name} ends ${a.warranty_expires_on}`, body: 'Raise any warranty claims before it ends.', link: `/assets/${a.id}`,
          subjectType: 'asset', subjectId: a.id, dedupeKey: `warranty:${a.id}:${a.warranty_expires_on}:${R.period('warranty_expiring')}` }));
      }
    }

    // External licences and certificates expiring (latest of each name per person) → the holder and training administrators at their site.
    if (R.on('credential_expiring')) {
      const creds = await many(tx, `SELECT c.id, c.employee_id, c.name, c.issuer, c.expires_on, e.facility_id, e.first_name || ' ' || e.last_name AS display_name FROM external_credential c JOIN employee e ON e.id = c.employee_id
        WHERE e.status = 'active' AND c.expires_on <= $1::date + $2::int AND c.expires_on >= $1::date - 30
          AND NOT EXISTS (SELECT 1 FROM external_credential n WHERE n.employee_id = c.employee_id AND lower(n.name) = lower(c.name) AND n.expires_on > c.expires_on)`, [today, R.lead('credential_expiring')]);
      const holders = await usersForEmployees(tx, [...new Set(creds.map((c) => c.employee_id))]);
      for (const c of creds) {
        const who = [holders.get(c.employee_id), ...(await usersWithPermission(tx, 'learning.manage', c.facility_id))];
        add('credential_expiring', await notify(tx, tenantId, who, { kind: 'reminder.credential_expiring',
          title: `${c.display_name}: ${c.name} (${c.issuer}) ${c.expires_on < today ? 'expired' : 'expires'} ${c.expires_on}`, body: 'Renew it with the issuer and record the new certificate.',
          link: '/training', subjectType: 'external_credential', subjectId: c.id, dedupeKey: `credential:${c.id}:${R.period('credential_expiring')}` }));
      }
    }

    // Contractors' certificates of insurance expiring or lapsed → buyers.
    if (R.on('insurance_expiring')) {
      const coi = await many(tx, `SELECT id, name, insurance_expires_on FROM supplier WHERE active AND cardinality(trades) > 0 AND insurance_expires_on IS NOT NULL
        AND insurance_expires_on <= $1::date + $2::int`, [today, R.lead('insurance_expiring')]);
      const buyers = coi.length ? await usersWithPermission(tx, 'purchasing.manage', null) : [];
      for (const c of coi) {
        add('insurance_expiring', await notify(tx, tenantId, buyers, { kind: 'reminder.insurance_expiring',
          title: `${c.name}: certificate of insurance ${c.insurance_expires_on < today ? 'lapsed' : 'expires'} ${c.insurance_expires_on}`,
          body: 'Ask the contractor for a current certificate; work cannot be sent to them once it lapses.', link: `/purchasing/suppliers/${c.id}`,
          subjectType: 'supplier', subjectId: c.id, dedupeKey: `insurance:${c.id}:${c.insurance_expires_on}:${R.period('insurance_expiring')}` }));
      }
    }

    // Audits planned within the lead days, or past their date and not started → the lead auditor and the auditee.
    if (R.on('audit_planned')) {
      const audits = await many(tx, `SELECT id, number, title, planned_on, lead_auditor_id, auditee_user_id FROM quality_audit WHERE status = 'planned' AND planned_on <= $1::date + $2::int`,
        [today, R.lead('audit_planned')]);
      for (const a of audits) {
        add('audit_planned', await notify(tx, tenantId, [a.lead_auditor_id, a.auditee_user_id].filter(Boolean), { kind: 'reminder.audit_planned',
          title: `${a.number} ${a.title}: ${a.planned_on < today ? `planned for ${a.planned_on} and not started` : `planned for ${a.planned_on}`}`,
          link: `/quality/audits/${a.id}`, subjectType: 'quality_audit', subjectId: a.id, dedupeKey: `audit:${a.id}:${a.planned_on}:${R.period('audit_planned')}` }));
      }
    }

    // Usable lots expiring within the lead days → storeroom staff at the site, one summary.
    if (R.on('lot_expiring')) {
      for (const f of facilities) {
        const lots = await many(tx, `SELECT l.number, p.part_number, min(l.expires_on) AS expires_on FROM lot_balance b JOIN stock_lot l ON l.id = b.lot_id JOIN part p ON p.id = l.part_id
          WHERE b.facility_id = $1 AND b.qty > 0 AND l.status = 'available' AND l.expires_on BETWEEN $2::date AND $2::date + $3::int
          GROUP BY l.number, p.part_number ORDER BY 3`, [f.id, today, R.lead('lot_expiring')]);
        if (!lots.length) continue;
        add('lot_expiring', await notify(tx, tenantId, await usersWithPermission(tx, 'inventory.manage', f.id), { kind: 'reminder.lot_expiring',
          title: `${f.code}: ${lots.length} lot${lots.length === 1 ? '' : 's'} expiring within ${R.lead('lot_expiring')} days`,
          body: lots.slice(0, 6).map((l) => `${l.part_number} ${l.number} ${l.expires_on}`).join(', '), link: '/reports/lot-status', dedupeKey: `lots-expiring:${f.id}:${R.period('lot_expiring')}` }));
      }
    }

    // Sites that have store walks but none completed within the set number of days → people who conduct walks there.
    if (R.on('visit_overdue')) {
      const every = R.lead('visit_overdue');
      const sites = await many(tx, `SELECT f.id, f.code, max(v.visited_on) FILTER (WHERE v.status = 'completed') AS last FROM site_visit v JOIN facility f ON f.id = v.facility_id
        GROUP BY f.id, f.code HAVING coalesce(max(v.visited_on) FILTER (WHERE v.status = 'completed'), '1900-01-01') < $1::date - $2::int`, [today, every]);
      for (const f of sites) {
        add('visit_overdue', await notify(tx, tenantId, await usersWithPermission(tx, 'visits.conduct', f.id), { kind: 'reminder.visit_overdue',
          title: `${f.code}: no store walk completed in ${every} days${f.last ? ` (last ${f.last})` : ''}`, link: '/stores', dedupeKey: `visit-overdue:${f.id}:${R.period('visit_overdue')}` }));
      }
    }

    // The next fiscal year starts within the lead days and has no budget → budget managers (only while the latest budget is current).
    if (R.on('budget_due')) {
      const latest = (await many(tx, 'SELECT fiscal_year, start_month FROM budget ORDER BY fiscal_year DESC LIMIT 1'))[0];
      if (latest) {
        const next = latest.fiscal_year + 1;
        const start = fiscalMonths(next, latest.start_month)[0]!;
        if (today >= addDays(start, -R.lead('budget_due')) && today < addDays(start, 90)) {
          add('budget_due', await notify(tx, tenantId, await usersWithPermission(tx, 'budgets.manage', null), { kind: 'reminder.budget_due',
            title: `Fiscal year ${next} ${today < start ? 'starts' : 'started'} ${start} and has no budget yet`, body: 'Start it from last year’s spend, or copy the current budget.',
            link: '/budgets', dedupeKey: `budget-due:${next}:${R.period('budget_due')}` }));
        }
      }
    }
    return counts;
  });
}

