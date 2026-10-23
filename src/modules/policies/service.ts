import type { Actor } from '../../platform/auth/actor.js';
import { can, requirePermission } from '../../platform/auth/actor.js';
import { audit } from '../../platform/audit/audit.js';
import type { Tx } from '../../platform/db/tx.js';
import { many, nextSequence, one } from '../../platform/db/tx.js';
import { conflict, forbidden, invalid, notFound } from '../../platform/errors.js';
import { notify } from '../../platform/notify/notify.js';
import { POLICY_TEMPLATES, placeholders } from './templates.js';

/**
 * Policies and the employee handbook (docs/ARCHITECTURE.md §12u, D-128). A policy has at most one draft and one
 * published version; publishing supersedes the previous one. People acknowledge the published version; a minor
 * revision (requires_reack = false) keeps acknowledgements given since the last revision that needed them.
 */
const SUBJECT = 'policy';
const today = () => new Date().toISOString().slice(0, 10);
type Category = 'handbook' | 'expense' | 'hr' | 'it' | 'safety' | 'quality' | 'finance' | 'other';

const manages = (actor: Actor) => can(actor, 'policies.manage');
/** A company-wide policy applies to everyone; a site policy to people with a role there (or corporate roles). */
const appliesTo = (actor: Actor, facilityId: string | null) => facilityId == null || actor.grants.some((g) => g.facilityId === null || g.facilityId === facilityId);

/** Active users a policy applies to. */
async function audience(tx: Tx, facilityId: string | null) {
  return (await many(tx, `SELECT DISTINCT u.id FROM app_user u JOIN user_role_scope a ON a.user_id = u.id
    WHERE u.status = 'active' AND ($1::uuid IS NULL OR a.facility_id IS NULL OR a.facility_id = $1)`, [facilityId])).map((r) => r.id as string);
}

/**
 * SQL fragment: for each policy p, whether user $U has acknowledged it. The anchor is the latest published (or
 * superseded) revision that required acknowledgement; any acknowledgement of that revision or a later one counts.
 */
const ACKED = (u: string) => `EXISTS (SELECT 1 FROM policy_acknowledgement k JOIN policy_version kv ON kv.id = k.version_id
  WHERE kv.policy_id = p.id AND k.user_id = ${u} AND kv.revision >= coalesce((SELECT max(av.revision) FROM policy_version av
    WHERE av.policy_id = p.id AND av.status <> 'draft' AND av.requires_reack), 1))`;

export async function listPolicies(tx: Tx, actor: Actor, q: { category?: string } = {}) {
  const rows = await many(tx, `SELECT p.id, p.number, p.title, p.category, p.handbook_order, p.facility_id, f.code AS facility_code, p.requires_acknowledgement, p.archived_at,
      cv.revision AS revision, cv.effective_on, cv.published_at, d.id AS draft_id, d.revision AS draft_revision, d.body AS draft_body,
      ${ACKED('$2')} AS acknowledged
    FROM policy p LEFT JOIN facility f ON f.id = p.facility_id LEFT JOIN policy_version cv ON cv.id = p.current_version_id
    LEFT JOIN policy_version d ON d.policy_id = p.id AND d.status = 'draft'
    WHERE p.archived_at IS NULL AND ($1::text IS NULL OR p.category = $1)
    ORDER BY p.category = 'handbook' DESC, p.handbook_order NULLS LAST, p.title`, [q.category ?? null, actor.userId]);
  const m = manages(actor);
  return rows.filter((r) => appliesTo(actor, r.facility_id) && (r.revision != null || m)).map(({ draft_body, ...r }) => ({
    ...r, pending: r.revision != null && r.requires_acknowledgement && !r.acknowledged,
    draft_placeholders: m && draft_body ? placeholders(draft_body).length : null, draft_id: m ? r.draft_id : null,
  }));
}

/** Published policies the user still has to acknowledge. */
export async function myPendingPolicies(tx: Tx, actor: Actor) {
  return (await listPolicies(tx, actor)).filter((p) => p.pending);
}

export async function getPolicy(tx: Tx, actor: Actor, id: string) {
  const p = await one(tx, `SELECT p.*, f.code AS facility_code, ou.display_name AS owner_name FROM policy p LEFT JOIN facility f ON f.id = p.facility_id
    LEFT JOIN app_user ou ON ou.id = p.owner_user_id WHERE p.id = $1`, [id]);
  if (!p) throw notFound('policy');
  const m = manages(actor);
  if (!appliesTo(actor, p.facility_id) && !m) throw forbidden('this policy applies to another site');
  if (!p.current_version_id && !m) throw notFound('policy');
  const versions = await many(tx, `SELECT v.id, v.revision, v.status, v.change_summary, v.requires_reack, v.effective_on, v.published_at, v.created_at,
      pu.display_name AS published_by_name, cu.display_name AS created_by_name, ${m ? 'v.body' : "CASE WHEN v.status = 'published' THEN v.body END AS body"}
    FROM policy_version v LEFT JOIN app_user pu ON pu.id = v.published_by JOIN app_user cu ON cu.id = v.created_by WHERE v.policy_id = $1 ORDER BY v.revision DESC`, [id]);
  const current = versions.find((v) => v.status === 'published') ?? null;
  const draft = m ? versions.find((v) => v.status === 'draft') ?? null : null;
  const acked = (await one(tx, `SELECT ${ACKED('$2')} AS ok, (SELECT max(k.acknowledged_at) FROM policy_acknowledgement k JOIN policy_version kv ON kv.id = k.version_id
    WHERE kv.policy_id = p.id AND k.user_id = $2) AS at FROM policy p WHERE p.id = $1`, [id, actor.userId]));
  const body = current?.body ?? draft?.body ?? '';
  const rules = /\{\{expense_rules\}\}/.test(body) || p.category === 'expense' ? await expenseRules(tx) : null;
  return {
    ...p, current, draft: draft ? { ...draft, placeholders: placeholders(draft.body) } : null,
    history: versions.filter((v) => v.status !== 'draft').map(({ body: _b, ...v }) => v),
    acknowledged: !!acked?.ok, acknowledgedAt: acked?.at ?? null, canManage: m,
    status: m && current ? await acknowledgementStatus(tx, p) : null, expenseRules: rules,
  };
}

async function acknowledgementStatus(tx: Tx, p: { id: string; facility_id: string | null; requires_acknowledgement: boolean }) {
  if (!p.requires_acknowledgement) return null;
  const people = await many(tx, `SELECT u.id, u.display_name, ${ACKED('u.id')} AS acknowledged FROM app_user u, policy p
    WHERE p.id = $1 AND u.id = ANY ($2) ORDER BY u.display_name`, [p.id, await audience(tx, p.facility_id)]);
  return { total: people.length, acknowledged: people.filter((x) => x.acknowledged).length, outstanding: people.filter((x) => !x.acknowledged).map((x) => ({ id: x.id, name: x.display_name })) };
}

export async function createPolicy(tx: Tx, actor: Actor, input: { title: string; category: Category; facilityId?: string | null; requiresAcknowledgement?: boolean;
  body?: string; handbookOrder?: number | null; templateKey?: string | null }) {
  requirePermission(actor, 'policies.manage');
  if (!input.title?.trim()) throw invalid('a policy needs a title');
  const number = `POL-${String(await nextSequence(tx, actor.tenantId, 'policy')).padStart(4, '0')}`;
  const p = await one(tx, `INSERT INTO policy (tenant_id, facility_id, number, title, category, handbook_order, template_key, requires_acknowledgement, owner_user_id, created_by)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9) RETURNING *`,
  [actor.tenantId, input.facilityId ?? null, number, input.title.trim(), input.category, input.handbookOrder ?? null, input.templateKey ?? null, input.requiresAcknowledgement ?? true, actor.userId]);
  await tx.query(`INSERT INTO policy_version (tenant_id, policy_id, revision, body, created_by) VALUES ($1, $2, 1, $3, $4)`,
    [actor.tenantId, p.id, input.body?.trim() || `## ${input.title.trim()}\n\n[[Write the policy here.]]`, actor.userId]);
  await audit(tx, actor, { action: 'policy.created', entityType: SUBJECT, entityId: p.id, facilityId: p.facility_id, data: { number, title: p.title, category: p.category, template: input.templateKey ?? null } });
  return p;
}

/** Adds the template sections the company does not have yet, as drafts with placeholders to complete. */
export async function installTemplates(tx: Tx, actor: Actor, keys?: string[]) {
  requirePermission(actor, 'policies.manage');
  const have = new Set((await many(tx, 'SELECT template_key FROM policy WHERE template_key IS NOT NULL')).map((r) => r.template_key));
  const created: string[] = [];
  for (const t of POLICY_TEMPLATES) {
    if (have.has(t.key) || (keys && !keys.includes(t.key))) continue;
    const p = await createPolicy(tx, actor, { title: t.title, category: t.category, body: t.body, requiresAcknowledgement: t.requiresAcknowledgement, handbookOrder: t.order ?? null, templateKey: t.key });
    created.push(p.number);
  }
  return { created };
}

async function lockPolicy(tx: Tx, id: string) {
  const p = await one(tx, 'SELECT * FROM policy WHERE id = $1 FOR UPDATE', [id]);
  if (!p) throw notFound('policy');
  if (p.archived_at) throw conflict('the policy is archived');
  return p;
}

/** Edits the draft, starting one from the published text when there is none. */
export async function saveDraft(tx: Tx, actor: Actor, id: string, input: { body?: string; changeSummary?: string | null; requiresReack?: boolean; title?: string;
  requiresAcknowledgement?: boolean; handbookOrder?: number | null }) {
  requirePermission(actor, 'policies.manage');
  const p = await lockPolicy(tx, id);
  let d = await one(tx, `SELECT * FROM policy_version WHERE policy_id = $1 AND status = 'draft'`, [id]);
  if (!d) {
    const cur = await one(tx, `SELECT body, revision FROM policy_version WHERE id = $1`, [p.current_version_id]);
    d = await one(tx, `INSERT INTO policy_version (tenant_id, policy_id, revision, body, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [actor.tenantId, id, (cur?.revision ?? 0) + 1, cur?.body ?? '', actor.userId]);
  }
  if (input.body !== undefined && !input.body.trim()) throw invalid('the policy text is empty');
  await tx.query(`UPDATE policy_version SET body = coalesce($2, body), change_summary = coalesce($3, change_summary), requires_reack = coalesce($4, requires_reack) WHERE id = $1`,
    [d.id, input.body?.trim() ?? null, input.changeSummary ?? null, input.requiresReack ?? null]);
  if (input.title !== undefined || input.requiresAcknowledgement !== undefined || input.handbookOrder !== undefined) {
    if (input.title !== undefined && !input.title.trim()) throw invalid('a policy needs a title');
    await tx.query(`UPDATE policy SET title = coalesce($2, title), requires_acknowledgement = coalesce($3, requires_acknowledgement),
      handbook_order = CASE WHEN $5 THEN $4 ELSE handbook_order END WHERE id = $1`,
    [id, input.title?.trim() ?? null, input.requiresAcknowledgement ?? null, input.handbookOrder ?? null, input.handbookOrder !== undefined]);
  }
  await audit(tx, actor, { action: 'policy.draft_saved', entityType: SUBJECT, entityId: id, data: { revision: d.revision, summary: input.changeSummary ?? null } });
  return one(tx, 'SELECT * FROM policy_version WHERE id = $1', [d.id]);
}

export async function discardDraft(tx: Tx, actor: Actor, id: string) {
  requirePermission(actor, 'policies.manage');
  const p = await lockPolicy(tx, id);
  if (!p.current_version_id) throw conflict('this policy has never been published; archive it instead');
  const r = await tx.query(`DELETE FROM policy_version WHERE policy_id = $1 AND status = 'draft'`, [id]);
  if (!r.rowCount) throw notFound('draft');
  await audit(tx, actor, { action: 'policy.draft_discarded', entityType: SUBJECT, entityId: id, data: {} });
}

/**
 * Publishes the draft: refused while placeholders remain, and from the second revision on without a summary of what
 * changed. The people who must acknowledge it are told.
 */
export async function publishPolicy(tx: Tx, actor: Actor, id: string, input: { effectiveOn?: string | null } = {}) {
  requirePermission(actor, 'policies.manage');
  const p = await lockPolicy(tx, id);
  const d = await one(tx, `SELECT * FROM policy_version WHERE policy_id = $1 AND status = 'draft' FOR UPDATE`, [id]);
  if (!d) throw conflict('there is no draft to publish');
  const left = placeholders(d.body);
  if (left.length) throw invalid(`complete the ${left.length} placeholder${left.length === 1 ? '' : 's'} first: ${left.slice(0, 3).join(', ')}${left.length > 3 ? ', …' : ''}`);
  if (d.revision > 1 && !d.change_summary?.trim()) throw invalid('say what changed in this revision');
  const effective = input.effectiveOn ?? today();
  if (p.current_version_id) await tx.query(`UPDATE policy_version SET status = 'superseded' WHERE id = $1`, [p.current_version_id]);
  await tx.query(`UPDATE policy_version SET status = 'published', published_by = $2, published_at = now(), effective_on = $3 WHERE id = $1`, [d.id, actor.userId, effective]);
  await tx.query('UPDATE policy SET current_version_id = $2 WHERE id = $1', [id, d.id]);
  const needs = p.requires_acknowledgement && (d.revision === 1 || d.requires_reack);
  if (needs) {
    await notify(tx, actor.tenantId, await audience(tx, p.facility_id), { kind: 'policy.published', title: `Please read and acknowledge: ${p.title}${d.revision > 1 ? ` (revision ${d.revision})` : ''}`,
      body: d.change_summary ?? null, link: `/policies/${id}`, subjectType: SUBJECT, subjectId: id, dedupeKey: `policy:${d.id}` }, actor.userId);
  }
  await audit(tx, actor, { action: 'policy.published', entityType: SUBJECT, entityId: id, facilityId: p.facility_id, data: { revision: d.revision, effectiveOn: effective, acknowledgementRequested: needs } });
  return { revision: d.revision, acknowledgementRequested: needs };
}

export async function acknowledgePolicy(tx: Tx, actor: Actor, id: string) {
  const p = await one(tx, 'SELECT * FROM policy WHERE id = $1', [id]);
  if (!p || !p.current_version_id || p.archived_at) throw notFound('policy');
  if (!appliesTo(actor, p.facility_id)) throw forbidden('this policy applies to another site');
  await tx.query(`INSERT INTO policy_acknowledgement (tenant_id, version_id, user_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, [actor.tenantId, p.current_version_id, actor.userId]);
  await tx.query(`UPDATE notification SET read_at = now() WHERE user_id = $1 AND read_at IS NULL AND kind = 'policy.published' AND subject_id = $2`, [actor.userId, id]);
  await audit(tx, actor, { action: 'policy.acknowledged', entityType: SUBJECT, entityId: id, facilityId: p.facility_id, data: { versionId: p.current_version_id } });
}

/** Acknowledges every handbook section the user has not yet acknowledged ("I have read the handbook"). */
export async function acknowledgeHandbook(tx: Tx, actor: Actor) {
  const pending = (await myPendingPolicies(tx, actor)).filter((p) => p.category === 'handbook');
  for (const p of pending) await acknowledgePolicy(tx, actor, p.id);
  return { acknowledged: pending.length };
}

/** The employee handbook: published handbook sections in order, with what the user still has to acknowledge. */
export async function handbook(tx: Tx, actor: Actor) {
  const sections = await many(tx, `SELECT p.id, p.number, p.title, p.handbook_order, p.facility_id, p.requires_acknowledgement, v.revision, v.effective_on, v.body,
      ${ACKED('$1')} AS acknowledged
    FROM policy p JOIN policy_version v ON v.id = p.current_version_id WHERE p.category = 'handbook' AND p.archived_at IS NULL ORDER BY p.handbook_order NULLS LAST, p.title`, [actor.userId]);
  const mine = sections.filter((s) => appliesTo(actor, s.facility_id));
  const company = await one(tx, 'SELECT name FROM tenant WHERE id = $1', [actor.tenantId]);
  return { company: company?.name, sections: mine, pending: mine.filter((s) => s.requires_acknowledgement && !s.acknowledged).length,
    drafts: manages(actor) ? (await one(tx, `SELECT count(*)::int AS n FROM policy p WHERE p.category = 'handbook' AND p.archived_at IS NULL AND p.current_version_id IS NULL`)).n : null };
}

export async function archivePolicy(tx: Tx, actor: Actor, id: string, reason: string) {
  requirePermission(actor, 'policies.manage');
  const p = await lockPolicy(tx, id);
  if (!reason?.trim()) throw invalid('a reason is required');
  await tx.query('UPDATE policy SET archived_at = now() WHERE id = $1', [id]);
  await audit(tx, actor, { action: 'policy.archived', entityType: SUBJECT, entityId: id, facilityId: p.facility_id, data: { reason } });
}

// ---------------------------------------------------------------------------
// Expense policy rules (enforced by expense reports, shown in the expense policy text)
// ---------------------------------------------------------------------------

export async function expenseRules(tx: Tx) {
  const policy = await one(tx, 'SELECT receipt_required_over::float, mileage_rate::float, submit_within_days, currency, notes, updated_at FROM expense_policy');
  const categories = await many(tx, `SELECT id, code, name, kind, limit_per_item::float, limit_per_day::float, receipt_required_over::float, needs_attendees, account_key, active, sort_order
    FROM expense_category ORDER BY sort_order, name`);
  return { policy: policy ?? { receipt_required_over: 25, mileage_rate: null, submit_within_days: null, currency: 'USD', notes: null }, categories };
}

export async function saveExpensePolicy(tx: Tx, actor: Actor, input: { receiptRequiredOver: number; mileageRate?: number | null; submitWithinDays?: number | null; notes?: string | null }) {
  requirePermission(actor, 'policies.manage');
  await tx.query(`INSERT INTO expense_policy (tenant_id, receipt_required_over, mileage_rate, submit_within_days, notes, updated_by, updated_at) VALUES ($1, $2, $3, $4, $5, $6, now())
    ON CONFLICT (tenant_id) DO UPDATE SET receipt_required_over = EXCLUDED.receipt_required_over, mileage_rate = EXCLUDED.mileage_rate, submit_within_days = EXCLUDED.submit_within_days,
      notes = EXCLUDED.notes, updated_by = EXCLUDED.updated_by, updated_at = now()`,
  [actor.tenantId, input.receiptRequiredOver, input.mileageRate ?? null, input.submitWithinDays ?? null, input.notes ?? null, actor.userId]);
  await audit(tx, actor, { action: 'expense_policy.saved', entityType: 'expense_policy', entityId: actor.tenantId, data: input });
}

export async function saveExpenseCategory(tx: Tx, actor: Actor, input: { id?: string; code: string; name: string; kind?: 'amount' | 'mileage'; limitPerItem?: number | null;
  limitPerDay?: number | null; receiptRequiredOver?: number | null; needsAttendees?: boolean; accountKey?: string; active?: boolean; sortOrder?: number }) {
  requirePermission(actor, 'policies.manage');
  if (!input.code?.trim() || !input.name?.trim()) throw invalid('a category needs a code and a name');
  if (input.limitPerItem != null && input.limitPerDay != null && input.limitPerItem > input.limitPerDay) throw invalid('the per-item limit is above the daily limit');
  const vals = [input.code.trim().toUpperCase(), input.name.trim(), input.kind ?? 'amount', input.limitPerItem ?? null, input.limitPerDay ?? null, input.receiptRequiredOver ?? null,
    input.needsAttendees ?? false, input.accountKey ?? 'travel_expense', input.active ?? true, input.sortOrder ?? 100];
  const c = input.id
    ? await one(tx, `UPDATE expense_category SET code = $2, name = $3, kind = $4, limit_per_item = $5, limit_per_day = $6, receipt_required_over = $7, needs_attendees = $8,
        account_key = $9, active = $10, sort_order = $11 WHERE id = $1 RETURNING *`, [input.id, ...vals])
    : await one(tx, `INSERT INTO expense_category (tenant_id, code, name, kind, limit_per_item, limit_per_day, receipt_required_over, needs_attendees, account_key, active, sort_order)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`, [actor.tenantId, ...vals]);
  if (!c) throw notFound('expense category');
  await audit(tx, actor, { action: 'expense_category.saved', entityType: 'expense_category', entityId: c.id, data: input });
  return c;
}
