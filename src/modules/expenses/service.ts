import type { Actor } from '../../platform/auth/actor.js';
import { can, hasRole, requirePermission } from '../../platform/auth/actor.js';
import { approvalHistory, closePendingRequests, createApprovalRequest, registerApprovalSubject, type StageInput } from '../../platform/approvals/engine.js';
import { audit } from '../../platform/audit/audit.js';
import type { Tx } from '../../platform/db/tx.js';
import { many, nextSequence, one } from '../../platform/db/tx.js';
import { conflict, forbidden, invalid, notFound } from '../../platform/errors.js';
import { emit } from '../../platform/integration/outbox.js';
import { notify } from '../../platform/notify/notify.js';
import type { BlobStore } from '../../platform/storage/blob-store.js';
import { expenseRules } from '../policies/service.js';
import { checkLines, lineReady, type Finding, type Line } from './policy-check.js';

/**
 * Expense reports (docs/ARCHITECTURE.md §12w, D-131, D-132). A claimant drafts a report, adds lines with receipts, and
 * submits it once every line passes the expense policy (or explains its exceptions). Approval routes by site,
 * department and total; the department head signs in person. Approval sends the report to accounting through the
 * outbox (as a bill owed to the employee); finance records the reimbursement.
 */
export const SUBJECT = 'expense_report';
const PURPOSE = 'expense.approve';
const RECEIPT_MIME = ['application/pdf', 'image/png', 'image/jpeg', 'image/heic', 'image/webp'];
const money = (n: number) => Math.round(n * 100) / 100;
const today = () => new Date().toISOString().slice(0, 10);

registerApprovalSubject(SUBJECT, {
  link: (id) => `/expenses/${id}`,
  describe: async (tx, id) => {
    const r = await one(tx, `SELECT r.number, r.title, r.total::float AS total, u.display_name FROM expense_report r JOIN app_user u ON u.id = r.user_id WHERE r.id = $1`, [id]);
    return r ? `${r.number} ${r.display_name}: ${r.title} ($${Number(r.total).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })})` : 'expense report';
  },
});

async function lockReport(tx: Tx, id: string) {
  const r = await one(tx, 'SELECT * FROM expense_report WHERE id = $1 FOR UPDATE', [id]);
  if (!r) throw notFound('expense report');
  return r;
}

/** Whether the actor took or may take part in approving the report (so may read it). */
async function isApprover(tx: Tx, actor: Actor, r: { id: string; facility_id: string }) {
  const steps = await many(tx, `SELECT s.role_key, s.assignee_user_id, s.decided_by, s.on_behalf_of FROM approval_step s JOIN approval_request q ON q.id = s.request_id
    WHERE q.subject_type = $1 AND q.subject_id = $2`, [SUBJECT, r.id]);
  return steps.some((s) => s.decided_by === actor.userId || s.on_behalf_of === actor.userId || s.assignee_user_id === actor.userId
    || (!s.assignee_user_id && hasRole(actor, s.role_key, r.facility_id)));
}

async function readable(tx: Tx, actor: Actor, r: any) {
  if (r.user_id === actor.userId || can(actor, 'expenses.view_all', r.facility_id) || (await isApprover(tx, actor, r))) return;
  throw forbidden('expenses.view_all');
}

function editable(actor: Actor, r: any) {
  if (r.user_id !== actor.userId) throw forbidden('only the person claiming can change this report');
  if (r.status !== 'draft') throw conflict(`the report is ${r.status}; ${r.status === 'submitted' ? 'withdraw it to change it' : r.status === 'rejected' ? 'revise it to change it' : 'it cannot change'}`);
}

export async function createReport(tx: Tx, actor: Actor, input: { title: string; purpose?: string | null; facilityId?: string | null }) {
  if (!input.title?.trim()) throw invalid('give the report a title (e.g. "Customer visit, Chicago")');
  const emp = actor.employeeId ? await one(tx, 'SELECT id, facility_id, department_id FROM employee WHERE id = $1', [actor.employeeId]) : null;
  const facilityId = input.facilityId ?? emp?.facility_id ?? actor.grants.find((g) => g.facilityId)?.facilityId ?? (await one(tx, 'SELECT id FROM facility ORDER BY created_at LIMIT 1'))?.id;
  if (!facilityId) throw invalid('choose the site this report belongs to');
  requirePermission(actor, 'expenses.submit', facilityId);
  const number = `EXP-${String(await nextSequence(tx, actor.tenantId, 'expense')).padStart(6, '0')}`;
  const r = await one(tx, `INSERT INTO expense_report (tenant_id, facility_id, department_id, number, user_id, employee_id, title, purpose) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
    [actor.tenantId, facilityId, emp?.department_id ?? null, number, actor.userId, emp?.id ?? null, input.title.trim(), input.purpose?.trim() || null]);
  await audit(tx, actor, { action: 'expense.created', entityType: SUBJECT, entityId: r.id, facilityId, data: { number } });
  return r;
}

async function linesOf(tx: Tx, reportId: string) {
  return many(tx, `SELECT l.id, l.line_no, l.spent_on::text AS spent_on, l.category_id, c.code AS category_code, c.name AS category_name, c.kind AS category_kind, c.account_key,
      l.merchant, l.description, l.amount::float AS amount, l.miles::float AS miles, l.rate::float AS rate, l.attendees, l.explanation, l.receipt_name, l.receipt_mime,
      (l.receipt_blob_key IS NOT NULL) AS has_receipt
    FROM expense_line l JOIN expense_category c ON c.id = l.category_id WHERE l.report_id = $1 ORDER BY l.line_no`, [reportId]);
}

/** Lines with the policy findings for each, and whether the report can be submitted. */
async function evaluate(tx: Tx, r: any) {
  const lines = await linesOf(tx, r.id);
  const rules = await expenseRules(tx);
  const prior = await many(tx, `SELECT x.number AS report_number, l.spent_on::text AS spent_on, l.amount::float AS amount, l.merchant FROM expense_line l JOIN expense_report x ON x.id = l.report_id
    WHERE x.user_id = $1 AND x.id <> $2 AND x.status NOT IN ('cancelled', 'rejected')`, [r.user_id, r.id]);
  const findings = checkLines(lines as unknown as Line[], rules.categories as any, rules.policy as any, today(), prior as any);
  const out = lines.map((l) => { const f = findings.get(l.line_no) ?? []; return { ...l, findings: f, ready: lineReady(f, l.explanation) }; });
  const total = money(out.reduce((s, l) => s + l.amount, 0));
  return { lines: out, total, ready: out.length > 0 && out.every((l) => l.ready), exceptions: out.reduce((n, l) => n + l.findings.filter((f: Finding) => f.severity === 'explain').length, 0) };
}

/**
 * The approval route for a report: every active rule whose site, department and threshold match adds a step. A
 * department-head rule goes to the head of the claimant's department in person; with no head, or when the head is
 * the claimant, it goes to the rule's role instead.
 */
export async function approvalRoute(tx: Tx, r: { facility_id: string; department_id: string | null; user_id: string }, total: number): Promise<StageInput[]> {
  const rules = await many(tx, `SELECT stage, approver, role_key, label FROM expense_approval_rule WHERE active AND min_amount <= $1
      AND (facility_id IS NULL OR facility_id = $2) AND (department_id IS NULL OR department_id = $3::uuid) ORDER BY stage, min_amount DESC, label`,
  [total, r.facility_id, r.department_id]);
  const head = r.department_id ? await one(tx, `SELECT d.head_user_id, d.name, u.display_name FROM department d LEFT JOIN app_user u ON u.id = d.head_user_id AND u.status = 'active' WHERE d.id = $1`, [r.department_id]) : null;
  const stages = new Map<number, Map<string, { roleKey: string; label: string; assigneeUserId: string | null }>>();
  for (const rule of rules) {
    const st = stages.get(rule.stage) ?? new Map();
    const personal = rule.approver === 'department_head' && head?.head_user_id && head.display_name && head.head_user_id !== r.user_id;
    const step = personal ? { roleKey: 'department_head', label: `${rule.label}: ${head!.display_name} (head of ${head!.name})`, assigneeUserId: head!.head_user_id as string }
      : { roleKey: rule.role_key, label: rule.approver === 'department_head' ? `${rule.label} (no department head available)` : rule.label, assigneeUserId: null };
    const key = step.assigneeUserId ? `u:${step.assigneeUserId}` : `r:${step.roleKey}`;
    if (!st.has(key)) st.set(key, step);
    stages.set(rule.stage, st);
  }
  return [...stages.keys()].sort((a, b) => a - b).map((k) => ({ steps: [...stages.get(k)!.values()] }));
}

export async function getReport(tx: Tx, actor: Actor, id: string) {
  const r = await one(tx, `SELECT r.*, r.total::float AS total, r.approved_total::float AS approved_total, u.display_name AS claimant_name, f.code AS facility_code, d.name AS department_name,
      pu.display_name AS paid_by_name FROM expense_report r JOIN app_user u ON u.id = r.user_id JOIN facility f ON f.id = r.facility_id
      LEFT JOIN department d ON d.id = r.department_id LEFT JOIN app_user pu ON pu.id = r.paid_by WHERE r.id = $1`, [id]);
  if (!r) throw notFound('expense report');
  await readable(tx, actor, r);
  const e = await evaluate(tx, r);
  const rules = await expenseRules(tx);
  return {
    ...r, ...e, total: r.status === 'draft' ? e.total : r.total,
    route: r.status === 'draft' ? await approvalRoute(tx, r, e.total) : null,
    approvals: await approvalHistory(tx, SUBJECT, id),
    categories: rules.categories.filter((c: any) => c.active), policy: rules.policy,
    canEdit: r.user_id === actor.userId && r.status === 'draft', canPay: r.status === 'approved' && can(actor, 'expenses.manage', r.facility_id) && r.user_id !== actor.userId,
  };
}

export async function listReports(tx: Tx, actor: Actor, q: { scope?: 'mine' | 'all'; status?: string } = {}) {
  const all = q.scope === 'all';
  if (all && !can(actor, 'expenses.view_all')) throw forbidden('expenses.view_all');
  const rows = await many(tx, `SELECT r.id, r.number, r.title, r.status, r.total::float AS total, r.submitted_at, r.approved_at, r.paid_on, r.created_at, r.facility_id, f.code AS facility_code,
      d.name AS department_name, u.display_name AS claimant_name, (SELECT count(*)::int FROM expense_line l WHERE l.report_id = r.id) AS lines
    FROM expense_report r JOIN app_user u ON u.id = r.user_id JOIN facility f ON f.id = r.facility_id LEFT JOIN department d ON d.id = r.department_id
    WHERE ($1 OR r.user_id = $2) AND ($3::text IS NULL OR r.status = $3) ORDER BY r.created_at DESC LIMIT 500`, [all, actor.userId, q.status ?? null]);
  return all ? rows.filter((x) => can(actor, 'expenses.view_all', x.facility_id)) : rows;
}

export async function saveLine(tx: Tx, actor: Actor, reportId: string, input: { id?: string; spentOn: string; categoryId: string; merchant?: string | null; description?: string | null;
  amount?: number | null; miles?: number | null; attendees?: string | null; explanation?: string | null }) {
  const r = await lockReport(tx, reportId);
  editable(actor, r);
  const c = await one(tx, 'SELECT kind, active FROM expense_category WHERE id = $1', [input.categoryId]);
  if (!c || !c.active) throw invalid('choose an active expense category');
  let amount = input.amount ?? 0; let rate: number | null = null;
  if (c.kind === 'mileage') {
    rate = (await one(tx, 'SELECT mileage_rate::float AS r FROM expense_policy'))?.r ?? null;
    amount = rate && input.miles ? money(input.miles * rate) : 0;
  }
  if (amount < 0) throw invalid('amounts cannot be negative');
  const vals = [input.spentOn, input.categoryId, input.merchant?.trim() || null, input.description?.trim() || null, money(amount), c.kind === 'mileage' ? input.miles ?? null : null, rate,
    input.attendees?.trim() || null, input.explanation?.trim() || null];
  const l = input.id
    ? await one(tx, `UPDATE expense_line SET spent_on = $3, category_id = $4, merchant = $5, description = $6, amount = $7, miles = $8, rate = $9, attendees = $10, explanation = $11
        WHERE id = $1 AND report_id = $2 RETURNING *`, [input.id, reportId, ...vals])
    : await one(tx, `INSERT INTO expense_line (tenant_id, report_id, line_no, spent_on, category_id, merchant, description, amount, miles, rate, attendees, explanation)
        VALUES ($1, $2, (SELECT coalesce(max(line_no), 0) + 1 FROM expense_line WHERE report_id = $2), $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`, [actor.tenantId, reportId, ...vals]);
  if (!l) throw notFound('expense line');
  return l;
}

export async function deleteLine(tx: Tx, actor: Actor, lineId: string) {
  const l = await one(tx, 'SELECT report_id FROM expense_line WHERE id = $1', [lineId]);
  if (!l) throw notFound('expense line');
  editable(actor, await lockReport(tx, l.report_id));
  await tx.query('DELETE FROM expense_line WHERE id = $1', [lineId]);
}

export async function attachReceipt(tx: Tx, actor: Actor, blobs: BlobStore, lineId: string, file: { fileName: string; mime: string; content: Buffer }) {
  const l = await one(tx, 'SELECT report_id FROM expense_line WHERE id = $1', [lineId]);
  if (!l) throw notFound('expense line');
  editable(actor, await lockReport(tx, l.report_id));
  if (!RECEIPT_MIME.includes(file.mime)) throw invalid('receipts must be a photo or a PDF');
  if (!file.content.length || file.content.length > 10 * 1024 * 1024) throw invalid('receipts must be between 1 byte and 10 MB');
  const stored = await blobs.put(actor.tenantId, file.content);
  await tx.query('UPDATE expense_line SET receipt_blob_key = $2, receipt_name = $3, receipt_mime = $4, receipt_sha256 = $5 WHERE id = $1',
    [lineId, stored.key, file.fileName.replace(/[^\w.\- ()]/g, '_').slice(0, 200), file.mime, stored.sha256]);
  return { ok: true };
}

export async function receiptFile(tx: Tx, actor: Actor, blobs: BlobStore, lineId: string) {
  const l = await one(tx, 'SELECT l.*, r.user_id, r.facility_id, r.id AS rid FROM expense_line l JOIN expense_report r ON r.id = l.report_id WHERE l.id = $1', [lineId]);
  if (!l || !l.receipt_blob_key) throw notFound('receipt');
  await readable(tx, actor, { id: l.rid, user_id: l.user_id, facility_id: l.facility_id });
  return { name: l.receipt_name as string, mime: l.receipt_mime as string, content: await blobs.get(l.receipt_blob_key) };
}

export async function submitReport(tx: Tx, actor: Actor, id: string) {
  const r = await lockReport(tx, id);
  editable(actor, r);
  const e = await evaluate(tx, r);
  if (!e.lines.length) throw invalid('add at least one expense');
  const stuck = e.lines.filter((l) => !l.ready);
  if (stuck.length) {
    const first = stuck[0]!;
    throw invalid(`line ${first.line_no}: ${first.findings.map((f: Finding) => f.message).join('; ')}${first.findings.every((f: Finding) => f.severity === 'explain') ? ' (add an explanation)' : ''}`);
  }
  const stages = await approvalRoute(tx, r, e.total);
  if (!stages.length) throw invalid('no approval rule matches this report; ask finance to set the expense approval rules');
  await tx.query(`UPDATE expense_report SET status = 'submitted', submitted_at = now(), total = $2 WHERE id = $1`, [id, e.total]);
  await createApprovalRequest(tx, actor, { facilityId: r.facility_id, subjectType: SUBJECT, subjectId: id, subjectRevision: r.revision, purpose: PURPOSE, stages });
  await audit(tx, actor, { action: 'expense.submitted', entityType: SUBJECT, entityId: id, facilityId: r.facility_id,
    data: { total: e.total, exceptions: e.exceptions, revision: r.revision, route: stages.map((s) => s.steps.map((x) => x.assigneeUserId ?? x.roleKey)) } });
  return { total: e.total, route: stages };
}

/** The claimant takes a submitted report back to change it (pending approvals are cancelled). */
export async function withdrawReport(tx: Tx, actor: Actor, id: string) {
  const r = await lockReport(tx, id);
  if (r.user_id !== actor.userId) throw forbidden('only the person claiming can withdraw this report');
  if (r.status !== 'submitted') throw conflict(`the report is ${r.status}`);
  await closePendingRequests(tx, actor, SUBJECT, id, 'cancelled', 'withdrawn by the claimant');
  await tx.query(`UPDATE expense_report SET status = 'draft', revision = revision + 1 WHERE id = $1`, [id]);
  await audit(tx, actor, { action: 'expense.withdrawn', entityType: SUBJECT, entityId: id, facilityId: r.facility_id, data: {} });
}

/** A rejected report goes back to draft for the claimant to fix and submit again. */
export async function reviseReport(tx: Tx, actor: Actor, id: string) {
  const r = await lockReport(tx, id);
  if (r.user_id !== actor.userId) throw forbidden('only the person claiming can revise this report');
  if (r.status !== 'rejected') throw conflict(`the report is ${r.status}`);
  await tx.query(`UPDATE expense_report SET status = 'draft', revision = revision + 1 WHERE id = $1`, [id]);
  await audit(tx, actor, { action: 'expense.revised', entityType: SUBJECT, entityId: id, facilityId: r.facility_id, data: { revision: r.revision + 1 } });
}

export async function cancelReport(tx: Tx, actor: Actor, id: string, reason: string) {
  const r = await lockReport(tx, id);
  if (r.user_id !== actor.userId && !can(actor, 'expenses.manage', r.facility_id)) throw forbidden('expenses.manage');
  if (!['draft', 'rejected', 'submitted'].includes(r.status)) throw conflict(`the report is ${r.status}`);
  if (!reason?.trim()) throw invalid('a reason is required');
  if (r.status === 'submitted') await closePendingRequests(tx, actor, SUBJECT, id, 'cancelled', reason);
  await tx.query(`UPDATE expense_report SET status = 'cancelled', cancel_reason = $2 WHERE id = $1`, [id, reason]);
  await audit(tx, actor, { action: 'expense.cancelled', entityType: SUBJECT, entityId: id, facilityId: r.facility_id, data: { reason } });
}

/** The report as a bill owed to the employee, for accounting (same shape as supplier bills). */
async function reportPayload(tx: Tx, id: string) {
  const r = await one(tx, `SELECT r.*, u.display_name, u.email, e.employee_number, f.code AS facility_code, f.name AS facility_name FROM expense_report r JOIN app_user u ON u.id = r.user_id
    LEFT JOIN employee e ON e.id = r.employee_id JOIN facility f ON f.id = r.facility_id WHERE r.id = $1`, [id]);
  const lines = await linesOf(tx, id);
  const ls = lines.map((l) => ({ lineNo: l.line_no, description: `${l.category_name}${l.merchant ? `, ${l.merchant}` : ''}${l.description ? `: ${l.description}` : ''} (${l.spent_on})`,
    qty: 1, unitPrice: l.amount, amount: l.amount, accountKey: l.account_key }));
  const total = money(ls.reduce((s, l) => s + l.amount, 0));
  return {
    kind: 'expense_report', invoiceId: r.id, invoiceNumber: r.number, invoiceDate: (r.approved_at ?? new Date()).toISOString().slice(0, 10), dueDate: null, currency: r.currency,
    supplier: { id: r.employee_id ?? r.user_id, code: r.employee_number ? `EMP-${r.employee_number}` : r.email, name: r.display_name, email: r.email, paymentTerms: null },
    facility: { code: r.facility_code, name: r.facility_name }, poNumber: null, lines: ls, taxAmount: 0, freightAmount: 0, subtotal: total, total,
  };
}

/** Approval engine callback (same transaction as the decision). */
export async function onExpenseDecided(tx: Tx, actor: Actor, subjectId: string, purpose: string, status: string) {
  if (purpose !== PURPOSE || status === 'pending') return;
  const r = await lockReport(tx, subjectId);
  if (status === 'approved') {
    await tx.query(`UPDATE expense_report SET status = 'approved', approved_at = now(), approved_total = total WHERE id = $1`, [subjectId]);
    await emit(tx, actor, { topic: 'expense.report.approved', aggregateType: SUBJECT, aggregateId: subjectId, payload: await reportPayload(tx, subjectId),
      idempotencyKey: `expense:${subjectId}:${r.revision}:approved` });
    const finance = (await many(tx, `SELECT DISTINCT a.user_id FROM user_role_scope a JOIN role ro ON ro.id = a.role_id JOIN app_user u ON u.id = a.user_id
      WHERE 'expenses.manage' = ANY (ro.permissions) AND u.status = 'active' AND (a.facility_id IS NULL OR a.facility_id = $1)`, [r.facility_id])).map((x) => x.user_id);
    await notify(tx, actor.tenantId, finance, { kind: 'expense.to_pay', title: `To reimburse: ${r.number} (${r.title})`, link: `/expenses/${subjectId}`, subjectType: SUBJECT, subjectId,
      dedupeKey: `expense-pay:${subjectId}:${r.revision}` }, r.user_id);
    await audit(tx, actor, { action: 'expense.approved', entityType: SUBJECT, entityId: subjectId, facilityId: r.facility_id, data: { total: Number(r.total) } });
  } else if (status === 'rejected') {
    await tx.query(`UPDATE expense_report SET status = 'rejected' WHERE id = $1`, [subjectId]);
    await audit(tx, actor, { action: 'expense.rejected', entityType: SUBJECT, entityId: subjectId, facilityId: r.facility_id, data: {} });
  }
}

/** Finance records the reimbursement (payroll, direct deposit, check); accounting is told it was paid. */
export async function markPaid(tx: Tx, actor: Actor, id: string, input: { paidOn: string; method: 'payroll' | 'direct_deposit' | 'check' | 'other'; reference?: string | null }) {
  const r = await lockReport(tx, id);
  requirePermission(actor, 'expenses.manage', r.facility_id);
  if (r.user_id === actor.userId) throw invalid('someone else records the payment of your own expenses');
  if (r.status !== 'approved') throw conflict(`the report is ${r.status}`);
  if (input.paidOn > today()) throw invalid('the payment date is in the future');
  await tx.query(`UPDATE expense_report SET status = 'paid', paid_on = $2, paid_by = $3, payment_method = $4, payment_reference = $5 WHERE id = $1`,
    [id, input.paidOn, actor.userId, input.method, input.reference?.trim() || null]);
  await emit(tx, actor, { topic: 'expense.report.paid', aggregateType: SUBJECT, aggregateId: id, payload: { ...(await reportPayload(tx, id)), paidOn: input.paidOn, method: input.method, reference: input.reference ?? null },
    idempotencyKey: `expense:${id}:paid` });
  await notify(tx, actor.tenantId, [r.user_id], { kind: 'expense.paid', title: `Reimbursed: ${r.number} (${r.title})`, body: `$${Number(r.total).toFixed(2)} by ${input.method.replace('_', ' ')} on ${input.paidOn}`,
    link: `/expenses/${id}`, subjectType: SUBJECT, subjectId: id, dedupeKey: `expense-paid:${id}` }, actor.userId);
  await audit(tx, actor, { action: 'expense.paid', entityType: SUBJECT, entityId: id, facilityId: r.facility_id, data: input });
}

// ---------------------------------------------------------------------------
// Approval rules (by site, department and amount)
// ---------------------------------------------------------------------------

export async function listRules(tx: Tx) {
  return many(tx, `SELECT r.id, r.facility_id, f.code AS facility_code, r.department_id, d.name AS department_name, r.min_amount::float AS min_amount, r.stage, r.approver, r.role_key, r.label, r.active
    FROM expense_approval_rule r LEFT JOIN facility f ON f.id = r.facility_id LEFT JOIN department d ON d.id = r.department_id ORDER BY r.stage, r.min_amount, r.label`);
}

export async function saveRule(tx: Tx, actor: Actor, input: { id?: string; facilityId?: string | null; departmentId?: string | null; minAmount: number; stage: number;
  approver: 'department_head' | 'role'; roleKey: string; label: string; active?: boolean }) {
  requirePermission(actor, 'expenses.manage');
  if (!(await one(tx, 'SELECT 1 FROM role WHERE key = $1', [input.roleKey]))) throw invalid(`no role ${input.roleKey}`);
  if (!input.label?.trim()) throw invalid('name the step (e.g. "Finance review")');
  const vals = [input.facilityId ?? null, input.departmentId ?? null, input.minAmount, input.stage, input.approver, input.roleKey, input.label.trim(), input.active ?? true];
  const r = input.id
    ? await one(tx, `UPDATE expense_approval_rule SET facility_id = $2, department_id = $3, min_amount = $4, stage = $5, approver = $6, role_key = $7, label = $8, active = $9 WHERE id = $1 RETURNING *`, [input.id, ...vals])
    : await one(tx, `INSERT INTO expense_approval_rule (tenant_id, facility_id, department_id, min_amount, stage, approver, role_key, label, active) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`, [actor.tenantId, ...vals]);
  if (!r) throw notFound('rule');
  await audit(tx, actor, { action: 'expense.rule_saved', entityType: 'expense_approval_rule', entityId: r.id, data: input });
  return r;
}

export async function setDepartmentHead(tx: Tx, actor: Actor, departmentId: string, userId: string | null) {
  if (!can(actor, 'expenses.manage') && !can(actor, 'employees.manage')) throw forbidden('employees.manage');
  const d = await one(tx, 'UPDATE department SET head_user_id = $2 WHERE id = $1 RETURNING id, name', [departmentId, userId]);
  if (!d) throw notFound('department');
  await audit(tx, actor, { action: 'department.head_set', entityType: 'department', entityId: departmentId, data: { head: userId } });
}

export async function listDepartments(tx: Tx) {
  return many(tx, `SELECT d.id, d.code, d.name, d.facility_id, f.code AS facility_code, d.head_user_id, u.display_name AS head_name,
      (SELECT count(*)::int FROM employee e WHERE e.department_id = d.id AND e.status = 'active') AS people
    FROM department d LEFT JOIN facility f ON f.id = d.facility_id LEFT JOIN app_user u ON u.id = d.head_user_id ORDER BY d.name`);
}
