/**
 * Records that need a periodic review (D-154). For each kind, the company sets how often (months), how far ahead the
 * reminder warns, how often it repeats, and after how many days overdue it escalates. Each record may use its own
 * frequency instead. A review is recorded with its outcome; the next one counts from it.
 *
 * `sql` returns one row per record due for review, with: id, number, title, facility_id, owners (uuid[], may be
 * empty), base (date the period counts from when no review has been recorded: approval, publication or creation),
 * fixed_due (a date already set on the record, used until the first review here), link. `$1` is the company.
 */
export interface ReviewDef {
  key: string;
  label: string;
  group: string;
  description: string;
  months: { default: number; min: number; max: number };
  /** Manages the area: may record reviews, change the frequency (unless an administrator named roles), and is reminded when the record has no owner. */
  permission: string;
  feature?: string;
  /** Who is reminded, in words. */
  recipients: string;
  sql: string;
  /** The record keeps its own frequency and review (continuity plans): shown here, reviewed through its own service, reminded by its own reminder. */
  own?: boolean;
}

export const REVIEWS: ReviewDef[] = [
  { key: 'fmea', label: 'FMEAs', group: 'Quality', months: { default: 12, min: 1, max: 60 }, permission: 'quality.manage', feature: 'fmea', recipients: 'The FMEA’s owner',
    description: 'Approved FMEAs are re-read against field failures, nonconformances and process changes. A change means a new revision through review.',
    sql: `SELECT f.id, f.number, f.title, f.facility_id, ARRAY[f.owner_user_id]::uuid[] AS owners, f.approved_at::date AS base, f.review_due AS fixed_due, '/quality/fmea/' || f.id AS link
      FROM fmea f WHERE f.tenant_id = $1 AND f.status = 'approved'` },
  { key: 'spc', label: 'SPC characteristics and control limits', group: 'Quality', months: { default: 6, min: 1, max: 36 }, permission: 'quality.manage', feature: 'spc', recipients: 'Quality staff at the site',
    description: 'Whether each characteristic is still measured as planned and its control limits still reflect the process.',
    sql: `SELECT c.id, c.code AS number, c.name AS title, c.facility_id, '{}'::uuid[] AS owners, c.created_at::date AS base, NULL::date AS fixed_due, '/quality/spc/' || c.id AS link
      FROM spc_characteristic c WHERE c.tenant_id = $1 AND c.active` },
  { key: 'document', label: 'Controlled documents', group: 'Documents and policies', months: { default: 24, min: 1, max: 60 }, permission: 'documents.manage', recipients: 'The document’s owner',
    description: 'Procedures, work instructions and manuals are confirmed current, or revised. Counts from the approval of the current version.',
    sql: `SELECT d.id, d.doc_number AS number, d.title, d.facility_id, CASE WHEN d.owner_user_id IS NULL THEN '{}'::uuid[] ELSE ARRAY[d.owner_user_id] END AS owners,
        v.approved_at::date AS base, NULL::date AS fixed_due, '/documents/' || d.id AS link
      FROM document d JOIN document_version v ON v.id = d.current_version_id WHERE d.tenant_id = $1 AND v.status = 'approved'` },
  { key: 'policy', label: 'Policies and handbook', group: 'Documents and policies', months: { default: 12, min: 1, max: 60 }, permission: 'policies.manage', feature: 'policies', recipients: 'The policy’s owner',
    description: 'Each published policy is confirmed current, or revised (a revision can ask everyone to acknowledge it again).',
    sql: `SELECT p.id, p.number, p.title, p.facility_id, CASE WHEN p.owner_user_id IS NULL THEN '{}'::uuid[] ELSE ARRAY[p.owner_user_id] END AS owners,
        v.published_at::date AS base, NULL::date AS fixed_due, '/policies/' || p.id AS link
      FROM policy p JOIN policy_version v ON v.id = p.current_version_id WHERE p.tenant_id = $1 AND p.archived_at IS NULL AND v.status = 'published'` },
  { key: 'expense_policy', label: 'Expense policy', group: 'Documents and policies', months: { default: 12, min: 1, max: 36 }, permission: 'expenses.manage', feature: 'expenses', recipients: 'Expense administrators',
    description: 'Mileage rate, receipt threshold and submission deadline, and the approval rules.',
    sql: `SELECT e.tenant_id AS id, 'EXPENSES' AS number, 'Expense policy and approval rules' AS title, NULL::uuid AS facility_id, '{}'::uuid[] AS owners, e.updated_at::date AS base, NULL::date AS fixed_due, '/expenses' AS link
      FROM expense_policy e WHERE e.tenant_id = $1` },
  { key: 'course', label: 'Training course content', group: 'People', months: { default: 24, min: 1, max: 60 }, permission: 'learning.manage', feature: 'training', recipients: 'The course’s owner',
    description: 'Course material and quizzes are checked against current procedures. Counts from publication of the current version.',
    sql: `SELECT c.id, c.code AS number, c.title, c.facility_id, CASE WHEN c.owner_user_id IS NULL THEN '{}'::uuid[] ELSE ARRAY[c.owner_user_id] END AS owners,
        v.published_at::date AS base, v.review_due_on AS fixed_due, '/training' AS link
      FROM course c JOIN LATERAL (SELECT * FROM course_version x WHERE x.course_id = c.id AND x.status = 'published' ORDER BY x.version_no DESC LIMIT 1) v ON true
      WHERE c.tenant_id = $1 AND c.active` },
  { key: 'access', label: 'User access', group: 'People', months: { default: 6, min: 1, max: 24 }, permission: 'tenant.admin', recipients: 'Administrators',
    description: 'Who holds which roles at which sites: leavers removed, roles still needed. Kept for audits (SOX, ISO 27001).',
    sql: `SELECT t.id, 'ACCESS' AS number, 'Who has access, and with which roles' AS title, NULL::uuid AS facility_id, '{}'::uuid[] AS owners, t.created_at::date AS base, NULL::date AS fixed_due, '/sites' AS link
      FROM tenant t WHERE t.id = $1` },
  { key: 'supplier', label: 'Approved suppliers', group: 'Purchasing', months: { default: 12, min: 1, max: 36 }, permission: 'purchasing.manage', feature: 'purchasing', recipients: 'Buyers',
    description: 'Re-evaluation of suppliers used in the last two years: performance, certificates, and whether they stay approved (ISO 9001 8.4).',
    sql: `SELECT s.id, s.code AS number, s.name AS title, NULL::uuid AS facility_id, '{}'::uuid[] AS owners, s.created_at::date AS base, NULL::date AS fixed_due, '/purchasing/suppliers/' || s.id AS link
      FROM supplier s WHERE s.tenant_id = $1 AND s.active AND EXISTS (SELECT 1 FROM purchase_order o WHERE o.supplier_id = s.id AND o.created_at > now() - interval '24 months')` },
  { key: 'pm_plan', label: 'PM plans', group: 'Maintenance', months: { default: 12, min: 1, max: 60 }, permission: 'work_orders.manage', feature: 'pm', recipients: 'Maintenance planners at the site',
    description: 'Tasks, interval and parts still right for the machine, judged against its failures since.',
    sql: `SELECT p.id, p.code AS number, p.title, p.facility_id, '{}'::uuid[] AS owners, p.created_at::date AS base, NULL::date AS fixed_due, '/pm/' || p.id AS link
      FROM pm_plan p WHERE p.tenant_id = $1 AND p.active` },
  { key: 'spares', label: 'Critical spares lists', group: 'Maintenance', months: { default: 12, min: 1, max: 60 }, permission: 'assets.manage', feature: 'assets', recipients: 'Asset managers at the site',
    description: 'For each machine with a spares list: critical parts and minimum stock still right.',
    sql: `SELECT a.id, a.asset_tag AS number, a.name AS title, a.facility_id, '{}'::uuid[] AS owners, min(x.created_at)::date AS base, NULL::date AS fixed_due, '/assets/' || a.id AS link
      FROM asset a JOIN asset_part x ON x.asset_id = a.id WHERE a.tenant_id = $1 AND a.lifecycle_status = 'active' GROUP BY a.id` },
  { key: 'repair_template', label: 'Repair templates', group: 'Maintenance', months: { default: 24, min: 1, max: 60 }, permission: 'work_orders.manage', feature: 'work_orders', recipients: 'Maintenance planners',
    description: 'Standard repairs: parts, labor estimate and procedure still match what the job takes.',
    sql: `SELECT r.id, r.code AS number, r.title, a.facility_id, '{}'::uuid[] AS owners, r.created_at::date AS base, NULL::date AS fixed_due,
        CASE WHEN r.asset_id IS NULL THEN '/assets' ELSE '/assets/' || r.asset_id END AS link
      FROM repair_template r LEFT JOIN asset a ON a.id = r.asset_id WHERE r.tenant_id = $1 AND r.active` },
  { key: 'visit_template', label: 'Store walk checklists', group: 'Sites', months: { default: 12, min: 1, max: 36 }, permission: 'visits.conduct', feature: 'visits', recipients: 'People who conduct walks',
    description: 'Checklist items still match the standards stores are held to.',
    sql: `SELECT t.id, t.code AS number, t.name AS title, NULL::uuid AS facility_id, '{}'::uuid[] AS owners, t.created_at::date AS base, NULL::date AS fixed_due, '/stores' AS link
      FROM visit_template t WHERE t.tenant_id = $1 AND t.active` },
  { key: 'continuity', label: 'Business continuity plans', group: 'Safety', months: { default: 12, min: 1, max: 60 }, permission: 'continuity.manage', feature: 'continuity', recipients: 'The plan’s owner and alternate', own: true,
    description: 'Each plan keeps its own review and exercise frequencies; this sets the default for new plans. Reminders come from “Continuity plan reviews and exercises”.',
    sql: `SELECT p.id, p.number, p.title, p.facility_id, array_remove(ARRAY[p.owner_user_id, p.alternate_user_id], NULL)::uuid[] AS owners,
        p.approved_at::date AS base, p.review_due AS fixed_due, '/continuity/' || p.id AS link, p.review_interval_months AS own_months
      FROM continuity_plan p WHERE p.tenant_id = $1 AND p.status = 'approved'` },
];

export const REVIEW_BY_KEY = new Map(REVIEWS.map((r) => [r.key, r]));
