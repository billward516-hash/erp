import type { Actor } from '../../platform/auth/actor.js';
import { requirePermission } from '../../platform/auth/actor.js';
import { audit } from '../../platform/audit/audit.js';
import type { Tx } from '../../platform/db/tx.js';
import { many, one } from '../../platform/db/tx.js';
import { conflict, invalid, notFound } from '../../platform/errors.js';

export interface CustomerInput {
  code: string; name: string; kind?: 'prospect' | 'customer'; industry?: string | null; website?: string | null; phone?: string | null;
  billingAddress?: string | null; shippingAddress?: string | null; paymentTerms?: string | null; creditLimit?: number | null; taxExempt?: boolean;
  ownerUserId?: string | null; customFields?: Record<string, unknown>;
}
const COLS: Record<string, string> = {
  name: 'name', kind: 'kind', industry: 'industry', website: 'website', phone: 'phone', billingAddress: 'billing_address', shippingAddress: 'shipping_address',
  paymentTerms: 'payment_terms', creditLimit: 'credit_limit', taxExempt: 'tax_exempt', ownerUserId: 'owner_user_id', active: 'active',
};

export async function createCustomer(tx: Tx, actor: Actor, input: CustomerInput) {
  requirePermission(actor, 'crm.manage');
  if (await one(tx, 'SELECT 1 FROM customer WHERE lower(code) = lower($1)', [input.code])) throw conflict(`customer ${input.code} already exists`);
  const c = await one(tx, `INSERT INTO customer (tenant_id, code, name, kind, industry, website, phone, billing_address, shipping_address, payment_terms, credit_limit, tax_exempt, owner_user_id, custom_fields)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING *`,
  [actor.tenantId, input.code, input.name, input.kind ?? 'prospect', input.industry ?? null, input.website ?? null, input.phone ?? null, input.billingAddress ?? null,
    input.shippingAddress ?? null, input.paymentTerms ?? null, input.creditLimit ?? null, input.taxExempt ?? false, input.ownerUserId ?? actor.userId, input.customFields ?? {}]);
  await audit(tx, actor, { action: 'customer.created', entityType: 'customer', entityId: c.id, data: { code: c.code, name: c.name } });
  return c;
}

export async function updateCustomer(tx: Tx, actor: Actor, id: string, patch: Partial<CustomerInput> & { active?: boolean }) {
  requirePermission(actor, 'crm.manage');
  const cur = await one(tx, 'SELECT * FROM customer WHERE id = $1 FOR UPDATE', [id]);
  if (!cur) throw notFound('customer');
  const sets: string[] = []; const vals: unknown[] = [id];
  for (const [k, col] of Object.entries(COLS)) {
    const v = (patch as Record<string, unknown>)[k];
    if (v !== undefined) { vals.push(v); sets.push(`${col} = $${vals.length}`); }
  }
  if (patch.customFields) { vals.push({ ...cur.custom_fields, ...patch.customFields }); sets.push(`custom_fields = $${vals.length}`); }
  if (!sets.length) return cur;
  const c = await one(tx, `UPDATE customer SET ${sets.join(', ')} WHERE id = $1 RETURNING *`, vals);
  await audit(tx, actor, { action: 'customer.updated', entityType: 'customer', entityId: id, data: { changed: Object.keys(patch) } });
  return c;
}

export async function listCustomers(tx: Tx, actor: Actor, q: { q?: string; kind?: string; mine?: boolean } = {}) {
  requirePermission(actor, 'crm.view');
  return many(tx, `SELECT c.id, c.code, c.name, c.kind, c.industry, c.phone, c.active, u.display_name AS owner,
      (SELECT count(*)::int FROM opportunity o WHERE o.customer_id = c.id AND o.stage NOT IN ('won', 'lost')) AS open_opportunities,
      (SELECT max(a.created_at) FROM activity a WHERE a.customer_id = c.id) AS last_activity
    FROM customer c LEFT JOIN app_user u ON u.id = c.owner_user_id
    WHERE ($1::text IS NULL OR c.code ILIKE '%' || $1 || '%' OR c.name ILIKE '%' || $1 || '%') AND ($2::text IS NULL OR c.kind = $2) AND (NOT $3 OR c.owner_user_id = $4)
    ORDER BY c.name LIMIT 500`, [q.q ?? null, q.kind ?? null, q.mine ?? false, actor.userId]);
}

export async function getCustomer(tx: Tx, actor: Actor, id: string) {
  requirePermission(actor, 'crm.view');
  const c = await one(tx, `SELECT c.*, u.display_name AS owner FROM customer c LEFT JOIN app_user u ON u.id = c.owner_user_id WHERE c.id = $1`, [id]);
  if (!c) throw notFound('customer');
  const contacts = await many(tx, 'SELECT * FROM contact WHERE customer_id = $1 AND active ORDER BY is_primary DESC, name', [id]);
  const opportunities = await many(tx, `SELECT o.*, u.display_name AS owner FROM opportunity o LEFT JOIN app_user u ON u.id = o.owner_user_id
    WHERE o.customer_id = $1 ORDER BY (o.stage IN ('won', 'lost')), o.expected_close NULLS LAST`, [id]);
  const activities = await listActivities(tx, actor, { customerId: id });
  return { ...c, contacts, opportunities, activities };
}

export async function saveContact(tx: Tx, actor: Actor, input: { id?: string; customerId: string; name: string; title?: string | null; email?: string | null; phone?: string | null; isPrimary?: boolean; active?: boolean }) {
  requirePermission(actor, 'crm.manage');
  if (!(await one(tx, 'SELECT 1 FROM customer WHERE id = $1', [input.customerId]))) throw notFound('customer');
  if (input.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(input.email)) throw invalid('that email address does not look right');
  if (input.isPrimary) await tx.query('UPDATE contact SET is_primary = false WHERE customer_id = $1 AND is_primary AND id IS DISTINCT FROM $2', [input.customerId, input.id ?? null]);
  const vals = [input.name, input.title ?? null, input.email ?? null, input.phone ?? null, input.isPrimary ?? false, input.active ?? true];
  const c = input.id
    ? await one(tx, `UPDATE contact SET name = $2, title = $3, email = $4, phone = $5, is_primary = $6, active = $7 WHERE id = $1 AND customer_id = $8 RETURNING *`, [input.id, ...vals, input.customerId])
    : await one(tx, `INSERT INTO contact (tenant_id, customer_id, name, title, email, phone, is_primary, active) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`, [actor.tenantId, input.customerId, ...vals]);
  if (!c) throw notFound('contact');
  await audit(tx, actor, { action: input.id ? 'contact.updated' : 'contact.created', entityType: 'customer', entityId: input.customerId, data: { contactId: c.id, name: c.name } });
  return c;
}

/** Default win probability by stage (editable per opportunity). */
export const STAGE_PROBABILITY: Record<string, number> = { lead: 10, qualified: 25, proposal: 50, negotiation: 75, won: 100, lost: 0 };
const STAGES = Object.keys(STAGE_PROBABILITY);

export async function saveOpportunity(tx: Tx, actor: Actor, input: {
  id?: string; customerId: string; title: string; stage?: string; amount?: number | null; probability?: number | null; expectedClose?: string | null;
  source?: string | null; ownerUserId?: string | null; lostReason?: string | null;
}) {
  requirePermission(actor, 'crm.manage');
  const stage = input.stage ?? 'lead';
  if (!STAGES.includes(stage)) throw invalid(`unknown stage ${stage}`);
  if (stage === 'lost' && !input.lostReason?.trim()) throw invalid('say why the opportunity was lost (helps the win/loss review)');
  const prob = input.probability ?? STAGE_PROBABILITY[stage];
  const closed = ['won', 'lost'].includes(stage);
  const vals = [input.customerId, input.title, stage, input.amount ?? null, prob, input.expectedClose ?? null, input.source ?? null, input.ownerUserId ?? actor.userId, input.lostReason ?? null, closed];
  const o = input.id
    ? await one(tx, `UPDATE opportunity SET customer_id = $2, title = $3, stage = $4, amount = $5, probability = $6, expected_close = $7, source = $8, owner_user_id = $9, lost_reason = $10,
        closed_at = CASE WHEN $11 THEN coalesce(closed_at, now()) END WHERE id = $1 RETURNING *`, [input.id, ...vals])
    : await one(tx, `INSERT INTO opportunity (tenant_id, customer_id, title, stage, amount, probability, expected_close, source, owner_user_id, lost_reason, closed_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, CASE WHEN $11 THEN now() END) RETURNING *`, [actor.tenantId, ...vals]);
  if (!o) throw notFound('opportunity');
  await audit(tx, actor, { action: input.id ? 'opportunity.updated' : 'opportunity.created', entityType: 'customer', entityId: input.customerId, data: { opportunityId: o.id, stage, amount: o.amount } });
  return o;
}

/** Moves an opportunity forward automatically (never backwards) as its quote progresses. */
export async function advanceOpportunity(tx: Tx, opportunityId: string | null, stage: 'proposal' | 'won', amount?: number) {
  if (!opportunityId) return;
  const order = ['lead', 'qualified', 'proposal', 'negotiation', 'won'];
  const o = await one(tx, 'SELECT stage FROM opportunity WHERE id = $1', [opportunityId]);
  if (!o || o.stage === 'lost' || order.indexOf(o.stage) >= order.indexOf(stage)) return;
  await tx.query(`UPDATE opportunity SET stage = $2, probability = $3, amount = coalesce($4, amount), closed_at = CASE WHEN $2 = 'won' THEN now() END WHERE id = $1`,
    [opportunityId, stage, STAGE_PROBABILITY[stage], amount ?? null]);
}

export async function logActivity(tx: Tx, actor: Actor, input: {
  customerId: string; opportunityId?: string | null; quoteId?: string | null; kind: 'call' | 'email' | 'meeting' | 'note' | 'task'; summary: string; dueOn?: string | null; ownerUserId?: string | null;
}) {
  requirePermission(actor, 'crm.manage');
  if (!input.summary?.trim()) throw invalid('write what happened or what needs doing');
  if (input.kind === 'task' && !input.dueOn) throw invalid('a follow-up task needs a due date');
  const a = await one(tx, `INSERT INTO activity (tenant_id, customer_id, opportunity_id, quote_id, kind, summary, due_on, done_at, owner_user_id, created_by)
    VALUES ($1, $2, $3, $4, $5, $6, $7, CASE WHEN $5 = 'task' THEN NULL ELSE now() END, $8, $9) RETURNING *`,
  [actor.tenantId, input.customerId, input.opportunityId ?? null, input.quoteId ?? null, input.kind, input.summary.trim(), input.dueOn ?? null, input.ownerUserId ?? actor.userId, actor.userId]);
  return a;
}

export async function completeTask(tx: Tx, actor: Actor, id: string) {
  requirePermission(actor, 'crm.manage');
  const a = await one(tx, `UPDATE activity SET done_at = now() WHERE id = $1 AND kind = 'task' AND done_at IS NULL RETURNING id`, [id]);
  if (!a) throw conflict('not an open task');
}

export async function listActivities(tx: Tx, actor: Actor, q: { customerId?: string; openTasksFor?: string }) {
  requirePermission(actor, 'crm.view');
  return many(tx, `SELECT a.*, c.name AS customer_name, c.id AS customer_id, o.title AS opportunity_title, u.display_name AS owner, cu.display_name AS created_by_name
    FROM activity a JOIN customer c ON c.id = a.customer_id LEFT JOIN opportunity o ON o.id = a.opportunity_id
    LEFT JOIN app_user u ON u.id = a.owner_user_id JOIN app_user cu ON cu.id = a.created_by
    WHERE ($1::uuid IS NULL OR a.customer_id = $1) AND ($2::uuid IS NULL OR (a.kind = 'task' AND a.done_at IS NULL AND a.owner_user_id = $2))
    ORDER BY CASE WHEN $2::uuid IS NOT NULL THEN a.due_on END, a.created_at DESC LIMIT 200`, [q.customerId ?? null, q.openTasksFor ?? null]);
}

export async function pipeline(tx: Tx, actor: Actor, q: { ownerUserId?: string } = {}) {
  requirePermission(actor, 'crm.view');
  return many(tx, `SELECT o.*, c.name AS customer_name, u.display_name AS owner, (coalesce(o.amount, 0) * o.probability / 100.0)::float AS weighted
    FROM opportunity o JOIN customer c ON c.id = o.customer_id LEFT JOIN app_user u ON u.id = o.owner_user_id
    WHERE o.stage NOT IN ('won', 'lost') AND ($1::uuid IS NULL OR o.owner_user_id = $1) ORDER BY o.expected_close NULLS LAST`, [q.ownerUserId ?? null]);
}
