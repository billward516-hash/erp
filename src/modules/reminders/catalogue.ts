/**
 * Every reminder the daily sweep sends (D-153), with its defaults. Each company can turn a reminder off, change how far
 * ahead it warns and how often it repeats, within the limits here. `permission` names who manages that area: holders
 * of it may change the reminder unless an administrator has named specific roles instead.
 */
export type Repeat = 'daily' | 'weekly' | 'once';

export interface ReminderDef {
  key: string;
  label: string;
  group: string;
  /** Who receives it. */
  recipients: string;
  /** What triggers it, with {lead} for the lead setting. */
  when: string;
  /** How far ahead (or, for `leadKind: 'every'`, how often the thing is expected), in days. Absent: no lead setting. */
  lead?: { default: number; min: number; max: number };
  leadKind?: 'ahead' | 'every' | 'after' | 'idle' | 'waited';
  repeat: Repeat;
  repeats: Repeat[];
  permission: string;
  /** Feature (D-149): the reminder stops while the feature is off for everyone. */
  feature?: string;
  /** Added by D-153 (no reminder existed before). */
  added?: boolean;
}

const summary: Repeat[] = ['daily', 'weekly'];
const item: Repeat[] = ['daily', 'weekly', 'once'];

export const REMINDERS: ReminderDef[] = [
  // Maintenance and assets
  { key: 'pm_due', label: 'PM plans due without a work order', group: 'Maintenance', recipients: 'Maintenance planners at the site',
    when: "A PM plan is inside its own lead window and has no open work order", repeat: 'daily', repeats: summary, permission: 'work_orders.manage', feature: 'pm' },
  { key: 'wo_overdue', label: 'Overdue work orders', group: 'Maintenance', recipients: 'The assigned technicians',
    when: 'A work order is past its due date', repeat: 'weekly', repeats: item, permission: 'work_orders.manage', feature: 'work_orders' },
  { key: 'kits_short', label: 'Kits short of parts', group: 'Maintenance', recipients: 'Storeroom staff and maintenance planners at the site',
    when: 'Work due within {lead} days has a kit still short of parts', lead: { default: 7, min: 1, max: 60 }, repeat: 'daily', repeats: summary, permission: 'inventory.manage', feature: 'storerooms' },
  { key: 'readings_missed', label: 'Missed condition readings', group: 'Maintenance', recipients: 'People who record readings at the site',
    when: 'No reading within one and a half times the point’s interval', repeat: 'daily', repeats: summary, permission: 'assets.manage', feature: 'assets' },
  { key: 'warranty_expiring', label: 'Equipment warranties expiring', group: 'Maintenance', recipients: 'Asset managers at the site', added: true,
    when: 'An asset’s warranty ends within {lead} days', lead: { default: 60, min: 7, max: 365 }, repeat: 'once', repeats: item, permission: 'assets.manage', feature: 'assets' },
  { key: 'spc_summary', label: 'SPC alarm summary', group: 'Quality', recipients: 'Quality staff at the site', added: true,
    when: 'One message per site: new alarms against the rules that are on, by rule and characteristic; alarms still open and the oldest; characteristics not measured in {lead} days',
    lead: { default: 7, min: 1, max: 90 }, leadKind: 'idle', repeat: 'daily', repeats: summary, permission: 'quality.manage', feature: 'spc' },
  { key: 'calibration_due', label: 'Calibration due soon', group: 'Quality', recipients: 'Quality staff at the site',
    when: 'An instrument is due for calibration within {lead} days', lead: { default: 14, min: 1, max: 120 }, repeat: 'weekly', repeats: summary, permission: 'quality.manage', feature: 'quality' },
  { key: 'calibration_overdue', label: 'Calibration overdue', group: 'Quality', recipients: 'Quality staff at the site',
    when: 'An instrument is past its calibration date (it cannot be used for production)', repeat: 'daily', repeats: summary, permission: 'quality.manage', feature: 'quality' },
  // Quality and safety
  { key: 'action_overdue', label: 'Overdue actions', group: 'Quality', recipients: 'The action’s owner',
    when: 'A corrective, safety, audit, FMEA, continuity, store walk or improvement action is past its due date', repeat: 'daily', repeats: item, permission: 'quality.manage', feature: 'quality' },
  { key: 'capa_verification_due', label: 'Effectiveness checks due', group: 'Quality', recipients: 'Quality staff other than the owner',
    when: 'A corrective action has reached its effectiveness check', repeat: 'weekly', repeats: item, permission: 'quality.manage', feature: 'quality' },
  { key: 'scar_overdue', label: 'Supplier corrective action requests unanswered', group: 'Quality', recipients: 'The request’s owner',
    when: 'A supplier has not answered by the response date', repeat: 'daily', repeats: item, permission: 'quality.manage', feature: 'quality' },
  { key: 'audit_planned', label: 'Audits coming up or not started', group: 'Quality', recipients: 'The lead auditor and the auditee', added: true,
    when: 'An audit is planned within {lead} days, or its date has passed and it has not started', lead: { default: 14, min: 1, max: 90 }, repeat: 'weekly', repeats: item, permission: 'quality.manage', feature: 'quality' },
  { key: 'cleanroom_sampling', label: 'Cleanroom sampling overdue', group: 'Quality', recipients: 'People who record cleanroom readings at the site, and the room’s owner', added: true,
    when: 'A monitoring point has had no reading within its sampling frequency (one message per site)', repeat: 'daily', repeats: summary, permission: 'cleanroom.manage', feature: 'cleanroom' },
  { key: 'incident_unclassified', label: 'Incidents not yet classified', group: 'Safety', recipients: 'Safety staff at the site',
    when: 'An incident is still unclassified a day after it was reported', repeat: 'daily', repeats: item, permission: 'safety.manage', feature: 'safety' },
  { key: 'temporary_change_ending', label: 'Temporary changes ending', group: 'Safety', recipients: 'The change’s owner',
    when: 'A change record marked temporary (one that has no temporary procedure change of its own, which sends its own alerts at 14, 7, 3, 1 and 0 days) ends within {lead} days, or has passed its end date', lead: { default: 14, min: 1, max: 90 }, repeat: 'weekly', repeats: item, permission: 'moc.manage', feature: 'changes' },
  { key: 'continuity_review_due', label: 'Continuity plan reviews and exercises', group: 'Safety', recipients: 'The plan’s owner and alternate',
    when: 'A plan’s review, or its exercise with none scheduled, is due within {lead} days', lead: { default: 30, min: 7, max: 180 }, repeat: 'weekly', repeats: item, permission: 'continuity.manage', feature: 'continuity' },
  { key: 'qualification_due', label: 'Equipment requalification due', group: 'Maintenance', recipients: 'People who manage qualification at the site',
    when: 'A tool under qualification control is due for requalification within {lead} days, or past its date', lead: { default: 30, min: 7, max: 180 }, repeat: 'weekly', repeats: summary, permission: 'qualification.manage', feature: 'qualification' },
  // People
  { key: 'training_due', label: 'Training due', group: 'People', recipients: 'The learner',
    when: 'Assigned training is due within {lead} days or overdue', lead: { default: 7, min: 0, max: 90 }, repeat: 'weekly', repeats: item, permission: 'learning.manage', feature: 'training' },
  { key: 'qualification_expiring', label: 'Qualifications expiring', group: 'People', recipients: 'The holder',
    when: 'A qualification expires within {lead} days', lead: { default: 30, min: 7, max: 365 }, repeat: 'weekly', repeats: item, permission: 'learning.manage', feature: 'training' },
  { key: 'credential_expiring', label: 'External certificates expiring', group: 'People', recipients: 'The holder and training administrators', added: true,
    when: 'A licence or certificate from an outside body expires within {lead} days', lead: { default: 30, min: 7, max: 365 }, repeat: 'weekly', repeats: item, permission: 'learning.manage', feature: 'training' },
  { key: 'performance_due', label: 'Performance reviews and check-ins due', group: 'People', recipients: 'The reviewer (HR when none is assigned)', added: true,
    when: 'A review or check-in is due within {lead} days, or overdue, and not yet shared', lead: { default: 14, min: 0, max: 60 }, repeat: 'weekly', repeats: item, permission: 'performance.manage', feature: 'performance' },
  { key: 'performance_overdue', label: 'Performance reviews well overdue', group: 'People', recipients: 'HR', added: true,
    when: 'Reviews or check-ins are more than {lead} days overdue (one summary)', lead: { default: 14, min: 1, max: 120 }, leadKind: 'after', repeat: 'weekly', repeats: summary, permission: 'performance.manage', feature: 'performance' },
  { key: 'timesheet_missing', label: 'Timesheets not submitted', group: 'People', recipients: 'The employee',
    when: 'Last week’s timesheet has not been submitted (once per week)', repeat: 'weekly', repeats: ['weekly'], permission: 'time.approve', feature: 'time' },
  { key: 'timesheets_waiting', label: 'Timesheets waiting for approval', group: 'People', recipients: 'Approvers at the site',
    when: 'Submitted timesheets are waiting', repeat: 'daily', repeats: summary, permission: 'time.approve', feature: 'time' },
  // Buying and selling
  { key: 'po_late', label: 'Late purchase orders', group: 'Purchasing and finance', recipients: 'Buyers',
    when: 'An order is past its expected delivery date', repeat: 'weekly', repeats: item, permission: 'purchasing.manage', feature: 'purchasing' },
  { key: 'insurance_expiring', label: 'Contractor insurance expiring', group: 'Purchasing and finance', recipients: 'Buyers', added: true,
    when: 'A contractor’s certificate of insurance expires within {lead} days (work cannot be sent to them after it lapses)', lead: { default: 30, min: 7, max: 180 }, repeat: 'weekly', repeats: item, permission: 'purchasing.manage', feature: 'purchasing' },
  { key: 'invoices_waiting', label: 'Supplier invoices waiting for approval', group: 'Purchasing and finance', recipients: 'Payables approvers at the site',
    when: 'Captured supplier invoices are waiting for a second person', repeat: 'daily', repeats: summary, permission: 'ap.manage', feature: 'payables' },
  { key: 'receivables_overdue', label: 'Overdue customer invoices', group: 'Purchasing and finance', recipients: 'Receivables staff at the site',
    when: 'Customer invoices are past their due date', repeat: 'weekly', repeats: summary, permission: 'ar.manage', feature: 'receivables' },
  { key: 'sync_failed', label: 'Accounting sync problems', group: 'Purchasing and finance', recipients: 'Integration administrators',
    when: 'Items sent to the accounting system failed and are parked', repeat: 'daily', repeats: summary, permission: 'integrations.manage' },
  { key: 'budget_due', label: 'Next year’s budget not started', group: 'Purchasing and finance', recipients: 'Budget managers', added: true,
    when: 'The next fiscal year starts within {lead} days and has no budget yet', lead: { default: 60, min: 14, max: 180 }, repeat: 'weekly', repeats: summary, permission: 'budgets.manage', feature: 'budgets' },
  { key: 'crm_task_due', label: 'Follow-up tasks due', group: 'Purchasing and finance', recipients: 'The task’s owner',
    when: 'A sales or collections follow-up is due today or overdue', repeat: 'daily', repeats: item, permission: 'crm.manage', feature: 'crm' },
  { key: 'quote_expiring', label: 'Quotes about to expire', group: 'Purchasing and finance', recipients: 'Whoever prepared the quote',
    when: 'A sent quote with no decision is {lead} days from expiring, 2 days from expiring, or lapsed yesterday (one notice each; the same series the daily job has always sent)', lead: { default: 7, min: 1, max: 60 }, repeat: 'once', repeats: ['once'], permission: 'crm.manage', feature: 'sales' },
  // Projects (SC-009)
  { key: 'project_budget', label: 'Projects near or over their hours budget', group: 'Projects', recipients: 'The project owner (project managers at the site when there is no owner)', added: true,
    when: 'An active project has used the company’s alert share of its hours budget (default 90%, set on the Projects page), and again once it is over; one notice for each level', repeat: 'once', repeats: ['once', 'weekly'], permission: 'projects.manage', feature: 'projects' },
  // Stock, sites and property
  { key: 'lot_expiring', label: 'Lots expiring', group: 'Stock and sites', recipients: 'Storeroom staff at the site', added: true,
    when: 'Usable stock in a lot expires within {lead} days', lead: { default: 30, min: 1, max: 365 }, repeat: 'weekly', repeats: summary, permission: 'inventory.manage', feature: 'storerooms' },
  { key: 'visit_overdue', label: 'Store walks not done', group: 'Stock and sites', recipients: 'People who conduct walks at the site', added: true,
    when: 'A site that has store walks has had none completed in {lead} days', lead: { default: 31, min: 7, max: 365 }, leadKind: 'every', repeat: 'weekly', repeats: summary, permission: 'visits.conduct', feature: 'visits' },
  { key: 'leasing_due', label: 'Leases ending and unit turns late', group: 'Stock and sites', recipients: 'Leasing managers at the site',
    when: 'Leases end within {lead} days without renewal, or unit turns are past their target', lead: { default: 60, min: 14, max: 180 }, repeat: 'weekly', repeats: summary, permission: 'leasing.manage', feature: 'leasing' },
  { key: 'lab_sample_due', label: 'Lab samples due or late', group: 'Quality', recipients: 'Laboratory staff at the site', added: true,
    when: 'A sample not yet released or disposed of is due within {lead} days or past its turnaround target (one summary per site)', lead: { default: 2, min: 0, max: 30 }, repeat: 'daily', repeats: summary, permission: 'lab.manage', feature: 'lab_samples' },
  { key: 'lab_retention_due', label: 'Lab samples reaching the end of retention', group: 'Quality', recipients: 'Laboratory managers at the site', added: true,
    when: 'A retained sample reaches its retention date within {lead} days, or has passed it, and has not been disposed of (one summary per site)', lead: { default: 14, min: 0, max: 180 }, repeat: 'weekly', repeats: summary, permission: 'lab.manage', feature: 'lab_samples' },
  { key: 'chemical_expiring', label: 'Chemicals reaching their use-by date', group: 'Stock and sites', recipients: 'Chemical managers at the site', added: true,
    when: 'A container in storage or in use, or a prepared reagent, passes its expiry or beyond-use date or reaches it within {lead} days (one summary per site)', lead: { default: 14, min: 1, max: 365 }, repeat: 'weekly', repeats: summary, permission: 'chemicals.manage', feature: 'chemicals' },
  { key: 'chemical_exceptions', label: 'Chemicals without a current safety data sheet', group: 'Stock and sites', recipients: 'Chemical managers at the site', added: true,
    when: 'A stored chemical has no safety data sheet, or one older than the company limit (set on the Chemicals page; one summary per site)', repeat: 'weekly', repeats: summary, permission: 'chemicals.manage', feature: 'chemicals' },
  // Service companies (D-188C)
  { key: 'staffing_overbooked', label: 'People over-allocated next week', group: 'Service companies', recipients: 'Staffing managers at the site', added: true,
    when: 'One message per site: people whose bookings next week exceed their available hours', repeat: 'weekly', repeats: summary, permission: 'staffing.manage', feature: 'utilization' },
  { key: 'staffing_unbooked', label: 'People with nothing booked', group: 'Service companies', recipients: 'Staffing managers at the site', added: true,
    when: 'One message per site: people with working hours and no project booking in the next two weeks', repeat: 'weekly', repeats: summary, permission: 'staffing.manage', feature: 'utilization' },
  { key: 'utilization_low', label: 'Utilization below target at month end', group: 'Service companies', recipients: 'Staffing managers at the site', added: true,
    when: 'On the last day of the month: people whose billable share of available hours for the month is below their target (approved timesheets only)', repeat: 'once', repeats: ['once'], permission: 'staffing.manage', feature: 'utilization' },
  // Support tickets (SC-009 P4)
  { key: 'ticket_breach', label: 'Tickets past a service-level target', group: 'Service companies', recipients: 'The ticket’s assignee and the people who manage tickets at the site', added: true,
    when: 'A ticket is still open after its first-response or resolution time (once for each target; the daily job runs once a day, so the alert can come up to a day after the moment)', repeat: 'once', repeats: item, permission: 'tickets.manage', feature: 'tickets' },
  { key: 'ticket_at_risk', label: 'Tickets at risk of missing a target', group: 'Service companies', recipients: 'The ticket’s assignee and the people who manage tickets at the site', added: true,
    when: 'A ticket has used its at-risk share of a target (80% unless the service level says otherwise) and the target has not yet passed', repeat: 'once', repeats: item, permission: 'tickets.manage', feature: 'tickets' },
  { key: 'ticket_waiting', label: 'Tickets waiting a long time', group: 'Service companies', recipients: 'The ticket’s assignee', added: true,
    when: 'A ticket has waited on the customer or a third party for {lead} days', lead: { default: 7, min: 1, max: 60 }, leadKind: 'waited', repeat: 'weekly', repeats: item, permission: 'tickets.manage', feature: 'tickets' },
  // Service companies (SC-009)
  { key: 'unbilled_time', label: 'Approved work waiting to be billed', group: 'Service companies', recipients: 'Billing staff at the site', added: true,
    when: 'Approved billable time, expenses or reached milestones have waited more than {lead} days without being billed (one summary per site)', lead: { default: 30, min: 7, max: 180 }, leadKind: 'after', repeat: 'weekly', repeats: summary, permission: 'billing.manage', feature: 'billing_runs' },
  { key: 'retainer_renewal', label: 'Retainers and subscriptions reaching renewal', group: 'Service companies', recipients: 'Retainer managers at the site', added: true,
    when: 'A plan with an end date is inside its own notice period (the notice days set on the plan)', repeat: 'once', repeats: ['once'], permission: 'retainers.manage', feature: 'retainers' },
  { key: 'retainer_failed', label: 'Scheduled retainer invoices that failed', group: 'Service companies', recipients: 'Retainer managers at the site', added: true,
    when: 'The daily job could not make a plan’s invoice (the reason is shown on the plan)', repeat: 'daily', repeats: item, permission: 'retainers.manage', feature: 'retainers' },
];

export const REMINDER_BY_KEY = new Map(REMINDERS.map((r) => [r.key, r]));
