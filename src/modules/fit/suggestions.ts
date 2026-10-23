import type { Actor } from '../../platform/auth/actor.js';
import { requirePermission } from '../../platform/auth/actor.js';
import type { Tx } from '../../platform/db/tx.js';
import { one } from '../../platform/db/tx.js';
import { notFound } from '../../platform/errors.js';
import { featureSettings } from '../../platform/features.js';

/**
 * Gentle suggestions (SC-004 B): "worth a look" cards for an administrator, from counts over the company's own records. No outside data,
 * nothing leaves the system. At most one a week per person; never a modal and never blocking; a dismissed suggestion stays away for 90
 * days; a card stays up (unchanged) until it is dismissed or opened, so it is not replaced by a new one the next day. Off per company and
 * per person. A rule names a feature the person can see; features an administrator hid are not suggested.
 */
interface Rule { key: string; feature: string; title: string; body: string; link: string; detect: (tx: Tx) => Promise<string | null> }
const n = async (tx: Tx, sql: string) => Number((await one(tx, sql))?.n ?? 0);
const plural = (c: number, w: string) => `${c} ${w}${c === 1 ? '' : 's'}`;

export const RULES: Rule[] = [
  { key: 'reorder_points', feature: 'storerooms', title: 'Parts are issued often, with no reorder point', link: '/inventory',
    body: 'Setting a reorder point and quantity on the parts you use most puts them on the reorder list before you run out, and lets the plan suggest purchase requests.',
    detect: async (tx) => { const c = await n(tx, `SELECT count(DISTINCT t.part_id)::int AS n FROM inventory_txn t JOIN inventory_balance b ON b.part_id = t.part_id AND b.location_id = t.location_id WHERE t.txn_type = 'issue' AND t.created_at > now() - interval '60 days' AND b.reorder_point IS NULL`); return c >= 5 ? `${plural(c, 'part')} issued in the last 60 days ${c === 1 ? 'has' : 'have'} no reorder point.` : null; } },
  { key: 'pm_compliance', feature: 'pm', title: 'Preventive maintenance is finishing late', link: '/reports/pm-compliance',
    body: 'The PM compliance report shows which plans slip and by how much, so the schedule or the staffing can be fixed instead of the symptoms.',
    detect: async (tx) => { const c = await n(tx, `SELECT count(*)::int AS n FROM work_order WHERE wo_type = 'preventive' AND completed_at > now() - interval '60 days' AND due_at IS NOT NULL AND completed_at > due_at`); return c >= 5 ? `${plural(c, 'preventive work order')} finished after ${c === 1 ? 'its' : 'their'} due date in the last 60 days.` : null; } },
  { key: 'capa', feature: 'capa', title: 'Nonconformances are logged without a corrective action', link: '/capa',
    body: 'Corrective action with 8D problem solving gives a recurring problem an owner, a root cause and a check that the fix worked.',
    detect: async (tx) => { const c = await n(tx, `SELECT count(*)::int AS n FROM nonconformance WHERE created_at > now() - interval '90 days' AND capa_id IS NULL`); const k = await n(tx, `SELECT count(*)::int AS n FROM corrective_action WHERE created_at > now() - interval '90 days'`); return c >= 5 && k === 0 ? `${plural(c, 'nonconformance')} in the last 90 days, none with a corrective action.` : null; } },
  { key: 'rfq', feature: 'purchasing', title: 'Compare supplier prices side by side', link: '/purchasing',
    body: 'A request for quote goes to several suppliers with a reply date; their answers line up by price, landed cost and lead time, and the award becomes a purchase request.',
    detect: async (tx) => { const c = await n(tx, `SELECT count(*)::int AS n FROM purchase_request WHERE created_at > now() - interval '60 days'`); const r = await n(tx, 'SELECT count(*)::int AS n FROM rfq'); return c >= 8 && r === 0 ? `${plural(c, 'purchase request')} in the last 60 days and no request for quote yet.` : null; } },
  { key: 'cycle_counts', feature: 'storerooms', title: 'Count stock on a schedule', link: '/scan',
    body: 'Give each part a count interval and the storeroom gets a list of what is due; blind counts on a tablet keep the figure honest.',
    detect: async (tx) => { const a = await n(tx, `SELECT count(*)::int AS n FROM inventory_txn WHERE txn_type = 'adjustment' AND created_at > now() - interval '90 days'`); const s = await n(tx, 'SELECT count(*)::int AS n FROM inventory_balance WHERE cycle_count_days IS NOT NULL'); const p = await n(tx, `SELECT count(*)::int AS n FROM inventory_count WHERE status = 'posted' AND created_at > now() - interval '120 days'`); return a >= 8 && s === 0 && p === 0 ? `${plural(a, 'stock adjustment')} in 90 days and no counts on a schedule.` : null; } },
  { key: 'scanning', feature: 'storerooms', title: 'Receive stock with a scanner', link: '/scan',
    body: 'The scan station receives against a purchase order, issues to work orders and counts with a tablet and a barcode scanner. Labels print from the system.',
    detect: async (tx) => { const c = await n(tx, `SELECT count(*)::int AS n FROM inventory_txn WHERE txn_type = 'receipt' AND created_at > now() - interval '30 days'`); const b = await n(tx, 'SELECT count(*)::int AS n FROM part_barcode'); return c >= 25 && b === 0 ? `${plural(c, 'receipt')} typed in over the last 30 days.` : null; } },
  { key: 'quote_expiry', feature: 'sales', title: 'Quotes are expiring without an answer', link: '/reports/quote-outcomes',
    body: 'The quote outcomes report shows what happened to every quote sent; extending a quote needs a reason, so the date means something.',
    detect: async (tx) => { const c = await n(tx, `SELECT count(*)::int AS n FROM quote WHERE status = 'sent' AND valid_until < current_date`); return c >= 3 ? `${plural(c, 'sent quote')} past ${c === 1 ? 'its' : 'their'} valid-until date with no decision.` : null; } },
  { key: 'collections', feature: 'receivables', title: 'Several invoices are overdue', link: '/reports/payment-behavior',
    body: 'The payment behavior report shows who pays late and by how much; the collections queue lists whom to call first.',
    detect: async (tx) => { const c = await n(tx, `SELECT count(*)::int AS n FROM customer_invoice WHERE status IN ('issued', 'partially_paid') AND due_date < current_date - 7`); return c >= 5 ? `${plural(c, 'invoice')} more than a week overdue.` : null; } },
  { key: 'training', feature: 'training', title: 'Track who is qualified for what', link: '/training',
    body: 'Qualifications with expiry dates, tied to equipment, stop an unqualified person being assigned and warn before a certificate lapses.',
    detect: async (tx) => { const e = await n(tx, `SELECT count(*)::int AS n FROM employee WHERE status = 'active'`); const q = await n(tx, 'SELECT count(*)::int AS n FROM employee_qualification'); return e >= 15 && q === 0 ? `${plural(e, 'employee')} and no qualifications recorded.` : null; } },
  { key: 'change_notices', feature: 'changes', title: 'Keep a record of who was told about a change', link: '/changes',
    body: 'A change notice lists who must be told (colleagues, customers, suppliers) and tracks who has acknowledged it.',
    detect: async (tx) => { const c = await n(tx, `SELECT count(*)::int AS n FROM moc_change WHERE customer_impact <> 'none' AND created_at > now() - interval '120 days'`); const k = await n(tx, 'SELECT count(*)::int AS n FROM change_notice'); return c >= 1 && k === 0 ? `${plural(c, 'change')} affecting customers in the last 120 days and no change notices.` : null; } },
];

const FREQUENCY_DAYS = 7, QUIET_DAYS = 90;

export async function suggestionsEnabled(tx: Tx, actor: Actor) {
  const s = await one(tx, 'SELECT enabled FROM suggestion_settings');
  const p = await one(tx, 'SELECT suggestions FROM user_preference WHERE user_id = $1', [actor.userId]);
  return { company: s?.enabled ?? true, person: p?.suggestions ?? true };
}

/** The card to show this administrator now, or null. */
export async function nextSuggestion(tx: Tx, actor: Actor) {
  if (!actor.grants.some((g) => g.permissions.has('tenant.admin'))) return null;
  const on = await suggestionsEnabled(tx, actor);
  if (!on.company || !on.person) return null;
  const last = await one(tx, `SELECT * FROM suggestion_log WHERE user_id = $1 ORDER BY shown_at DESC LIMIT 1`, [actor.userId]);
  const card = (r: any, rule: Rule) => ({ id: r.id as string, key: r.rule_key as string, title: rule.title, body: rule.body, evidence: r.evidence as string, link: rule.link });
  if (last) {
    const rule = RULES.find((r) => r.key === last.rule_key);
    // A card stays until it is dismissed or opened.
    if (rule && !last.dismissed_at && !last.opened_at) return card(last, rule);
    if (Date.now() - new Date(last.shown_at).getTime() < FREQUENCY_DAYS * 86_400_000) return null;
  }
  const hidden = await featureSettings(tx, actor.tenantId);
  for (const rule of RULES) {
    if (hidden.get(rule.feature)?.mode === 'off') continue;
    const recent = await one(tx, `SELECT 1 FROM suggestion_log WHERE user_id = $1 AND rule_key = $2 AND (coalesce(snoozed_until, dismissed_at + make_interval(days => $3)) > now() OR opened_at IS NOT NULL)`, [actor.userId, rule.key, QUIET_DAYS]);
    if (recent) continue;
    const evidence = await rule.detect(tx);
    if (!evidence) continue;
    const r = await one(tx, 'INSERT INTO suggestion_log (tenant_id, user_id, rule_key, evidence) VALUES ($1, $2, $3, $4) RETURNING *', [actor.tenantId, actor.userId, rule.key, evidence]);
    return card(r, rule);
  }
  return null;
}

export async function dismissSuggestion(tx: Tx, actor: Actor, id: string, input: { snoozeDays?: number } = {}) {
  const r = await one(tx, `UPDATE suggestion_log SET dismissed_at = now(), snoozed_until = CASE WHEN $3::int IS NULL THEN NULL ELSE now() + make_interval(days => $3) END WHERE id = $1 AND user_id = $2 RETURNING id`, [id, actor.userId, input.snoozeDays ?? null]);
  if (!r) throw notFound('suggestion');
}
export async function openSuggestion(tx: Tx, actor: Actor, id: string) {
  const r = await one(tx, 'UPDATE suggestion_log SET opened_at = now() WHERE id = $1 AND user_id = $2 RETURNING id', [id, actor.userId]);
  if (!r) throw notFound('suggestion');
}
export async function setCompanySuggestions(tx: Tx, actor: Actor, enabled: boolean) {
  requirePermission(actor, 'tenant.admin');
  await tx.query(`INSERT INTO suggestion_settings (tenant_id, enabled, updated_by) VALUES ($1, $2, $3) ON CONFLICT (tenant_id) DO UPDATE SET enabled = EXCLUDED.enabled, updated_by = EXCLUDED.updated_by, updated_at = now()`, [actor.tenantId, enabled, actor.userId]);
  return { enabled };
}
export async function suggestionHistory(tx: Tx, actor: Actor) {
  requirePermission(actor, 'tenant.admin');
  const { many } = await import('../../platform/db/tx.js');
  return many(tx, `SELECT l.rule_key, l.evidence, l.shown_at, l.dismissed_at, l.opened_at, u.display_name FROM suggestion_log l JOIN app_user u ON u.id = l.user_id ORDER BY l.shown_at DESC LIMIT 100`);
}
