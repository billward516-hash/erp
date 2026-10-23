import type { Actor } from '../../platform/auth/actor.js';
import { can } from '../../platform/auth/actor.js';
import { audit } from '../../platform/audit/audit.js';
import type { Tx } from '../../platform/db/tx.js';
import { many } from '../../platform/db/tx.js';
import { forbidden, invalid, notFound } from '../../platform/errors.js';
import { featureSettings } from '../../platform/features.js';
import { notify, usersWithPermission } from '../../platform/notify/notify.js';
import type { Repeat } from '../reminders/catalogue.js';
import type { ReviewDef } from './catalogue.js';
import { REVIEW_BY_KEY, REVIEWS } from './catalogue.js';

/**
 * Periodic reviews (D-154): when each record is next due, recording a review, a record's own frequency, the company's
 * settings per kind, and the daily reminders with escalation.
 */
export const REVIEW_DEFAULTS = { leadDays: 30, repeat: 'weekly' as Repeat, escalateDays: 14 };
export const reviewSettingKey = (key: string) => `review:${key}`;

export interface ReviewSetting { enabled: boolean; months: number; leadDays: number; repeat: Repeat; escalateDays: number; editorRoles: string[] | null; updatedAt?: string | null; updatedBy?: string | null }

export async function reviewSettings(tx: Tx): Promise<Map<string, ReviewSetting>> {
  const rows = new Map((await many(tx, `SELECT t.*, u.display_name AS updated_by_name FROM tenant_reminder t JOIN app_user u ON u.id = t.updated_by WHERE t.reminder_key LIKE 'review:%'`))
    .map((r) => [String(r.reminder_key).slice(7), r]));
  return new Map(REVIEWS.map((d) => {
    const r = rows.get(d.key);
    return [d.key, { enabled: r?.enabled ?? true, months: r?.interval_months ?? d.months.default, leadDays: r?.lead_days ?? REVIEW_DEFAULTS.leadDays,
      repeat: (r?.repeat ?? REVIEW_DEFAULTS.repeat) as Repeat, escalateDays: r?.escalate_days ?? REVIEW_DEFAULTS.escalateDays, editorRoles: r?.editor_roles ?? null,
      updatedAt: r?.updated_at ?? null, updatedBy: r?.updated_by_name ?? null }];
  }));
}

const iso = (d: unknown) => (d == null ? null : d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));
function addMonths(d: string, n: number) {
  const [y, m, day] = d.split('-').map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, m - 1 + n, 1));
  const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
  return new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), Math.min(day, last))).toISOString().slice(0, 10);
}
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

export interface ReviewItem {
  type: string; typeLabel: string; group: string; id: string; number: string; title: string; facilityId: string | null; owners: string[]; link: string;
  months: number; ownMonths: boolean; lastReviewedOn: string | null; lastOutcome: string | null; dueOn: string | null; status: 'overdue' | 'due_soon' | 'ok'; daysOverdue: number;
}

/** Every record of the kinds turned on (and whose feature is not off for everyone), with its due date and status. */
export async function reviewItems(tx: Tx, tenantId: string, today: string, only?: string): Promise<ReviewItem[]> {
  const settings = await reviewSettings(tx);
  const features = await featureSettings(tx, tenantId);
  const out: ReviewItem[] = [];
  for (const d of REVIEWS) {
    if (only && d.key !== only) continue;
    const s = settings.get(d.key)!;
    if (!s.enabled || (d.feature && features.get(d.feature)?.mode === 'off')) continue;
    const rows = await many(tx, d.sql, [tenantId]);
    if (!rows.length) continue;
    const last = new Map((await many(tx, `SELECT DISTINCT ON (subject_id) subject_id, reviewed_on, outcome FROM record_review WHERE review_type = $1 ORDER BY subject_id, reviewed_on DESC, id DESC`, [d.key]))
      .map((r) => [r.subject_id as string, r]));
    const own = new Map((await many(tx, 'SELECT subject_id, interval_months FROM review_interval WHERE review_type = $1', [d.key])).map((r) => [r.subject_id as string, r.interval_months as number]));
    for (const r of rows) {
      const lr = last.get(r.id);
      const months = r.own_months ?? own.get(r.id) ?? s.months;
      const lastOn = iso(lr?.reviewed_on);
      // Continuity plans keep their own due date; others count from the last review here, else a date already on the record, else approval or creation.
      const dueOn = d.own ? iso(r.fixed_due) : lastOn ? addMonths(lastOn, months) : iso(r.fixed_due) ?? (iso(r.base) ? addMonths(iso(r.base)!, months) : null);
      const daysOverdue = dueOn && dueOn < today ? Math.round((Date.parse(today) - Date.parse(dueOn)) / 86_400_000) : 0;
      out.push({ type: d.key, typeLabel: d.label, group: d.group, id: r.id, number: r.number, title: r.title, facilityId: r.facility_id, owners: (r.owners ?? []).filter(Boolean), link: r.link,
        months, ownMonths: r.own_months != null || own.has(r.id), lastReviewedOn: lastOn, lastOutcome: lr?.outcome ?? null, dueOn,
        status: !dueOn ? 'ok' : dueOn < today ? 'overdue' : dueOn <= addDays(today, s.leadDays) ? 'due_soon' : 'ok', daysOverdue });
    }
  }
  return out;
}

const mayReview = (actor: Actor, d: ReviewDef, item: Pick<ReviewItem, 'owners' | 'facilityId'>) => item.owners.includes(actor.userId) || can(actor, d.permission as never, item.facilityId);

/** The Reviews page: what the person may review (they own it, or manage the area), soonest first. */
export async function listReviews(tx: Tx, actor: Actor, q: { status?: 'due' | 'all'; type?: string } = {}) {
  const today = new Date().toISOString().slice(0, 10);
  const items = (await reviewItems(tx, actor.tenantId, today, q.type)).filter((i) => mayReview(actor, REVIEW_BY_KEY.get(i.type)!, i));
  const shown = q.status === 'all' ? items : items.filter((i) => i.status !== 'ok');
  shown.sort((a, b) => (a.dueOn ?? '9999').localeCompare(b.dueOn ?? '9999'));
  const kinds = REVIEWS.filter((d) => items.some((i) => i.type === d.key)).map((d) => ({ key: d.key, label: d.label }));
  return {
    counts: { overdue: items.filter((i) => i.status === 'overdue').length, dueSoon: items.filter((i) => i.status === 'due_soon').length, total: items.length },
    kinds, items: shown.map((i) => ({ ...i, mine: i.owners.includes(actor.userId), canManage: can(actor, REVIEW_BY_KEY.get(i.type)!.permission as never, i.facilityId) })),
  };
}

async function itemOf(tx: Tx, actor: Actor, type: string, id: string) {
  const d = REVIEW_BY_KEY.get(type);
  if (!d) throw notFound('review kind');
  const item = (await reviewItems(tx, actor.tenantId, new Date().toISOString().slice(0, 10), type)).find((i) => i.id === id);
  if (!item) throw notFound(`${d.label.toLowerCase()} record due for review`);
  return { d, item };
}

/** Records a review. "No change": confirmed current. "Changes needed": a revision is to follow through the record's own approval. */
export async function recordReview(tx: Tx, actor: Actor, type: string, id: string, input: { outcome: 'no_change' | 'changes_needed'; note?: string | null }) {
  const { d, item } = await itemOf(tx, actor, type, id);
  if (!mayReview(actor, d, item)) throw forbidden(d.permission);
  const note = input.note?.trim() || null;
  if (input.outcome === 'changes_needed' && !note) throw invalid('say what needs to change');
  if (d.own) {
    if (input.outcome === 'changes_needed') throw invalid('start a revision of the plan from its page');
    const { confirmReview } = await import('../continuity/service.js');
    await confirmReview(tx, actor, id, note ?? 'Reviewed: no change');
  }
  await tx.query(`INSERT INTO record_review (tenant_id, review_type, subject_id, facility_id, reviewed_on, reviewed_by, outcome, note, due_on) VALUES ($1, $2, $3, $4, current_date, $5, $6, $7, $8)`,
    [actor.tenantId, type, id, item.facilityId, actor.userId, input.outcome, note, item.dueOn]);
  await audit(tx, actor, { action: 'review.recorded', entityType: type, entityId: id, facilityId: item.facilityId,
    data: { kind: d.label, number: item.number, outcome: input.outcome, note, wasDue: item.dueOn } });
  return { nextDue: d.own ? null : addMonths(new Date().toISOString().slice(0, 10), item.months) };
}

/** A record's own frequency (null: the company's for its kind). */
export async function setRecordInterval(tx: Tx, actor: Actor, type: string, id: string, months: number | null) {
  const { d, item } = await itemOf(tx, actor, type, id);
  if (!can(actor, d.permission as never, item.facilityId)) throw forbidden(d.permission);
  if (d.own) throw invalid('a continuity plan’s frequency is set on the plan');
  if (months !== null && (!Number.isInteger(months) || months < d.months.min || months > d.months.max)) throw invalid(`${d.label}: every ${d.months.min} to ${d.months.max} months`);
  if (months === null) await tx.query('DELETE FROM review_interval WHERE review_type = $1 AND subject_id = $2', [type, id]);
  else await tx.query(`INSERT INTO review_interval (tenant_id, review_type, subject_id, interval_months, set_by) VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (tenant_id, review_type, subject_id) DO UPDATE SET interval_months = EXCLUDED.interval_months, set_by = EXCLUDED.set_by, set_at = now()`, [actor.tenantId, type, id, months, actor.userId]);
  await audit(tx, actor, { action: 'review.interval_set', entityType: type, entityId: id, facilityId: item.facilityId, data: { from: item.ownMonths ? item.months : null, to: months } });
}

/** Review history for one record. */
export async function reviewHistory(tx: Tx, type: string, id: string) {
  return many(tx, `SELECT r.reviewed_on, r.outcome, r.note, r.due_on, u.display_name AS reviewed_by FROM record_review r JOIN app_user u ON u.id = r.reviewed_by
    WHERE r.review_type = $1 AND r.subject_id = $2 ORDER BY r.reviewed_on DESC, r.id DESC`, [type, id]);
}

/** Daily sweep part (called by runReminders): due soon or overdue → owners (or the area's managers); overdue past the escalation → managers or administrators. */
export async function remindReviews(tx: Tx, tenantId: string, today: string, week: string) {
  const settings = await reviewSettings(tx);
  const counts: Record<string, number> = {};
  const add = (k: string, n: number) => { counts[k] = (counts[k] ?? 0) + n; };
  for (const i of await reviewItems(tx, tenantId, today)) {
    const d = REVIEW_BY_KEY.get(i.type)!;
    if (d.own || i.status === 'ok') continue;
    const s = settings.get(i.type)!;
    const period = s.repeat === 'daily' ? today : s.repeat === 'weekly' ? week : 'once';
    const managers = await usersWithPermission(tx, d.permission, i.facilityId);
    const who = i.owners.length ? i.owners : managers;
    const when = i.status === 'overdue' ? `overdue since ${i.dueOn}` : `due ${i.dueOn}`;
    add('review_due', await notify(tx, tenantId, who, { kind: 'reminder.review_due', title: `Review ${when}: ${d.label.replace(/s$/, '')} ${i.number} ${i.title}`.replace(/\s+/g, ' '),
      body: 'Confirm it is still current, or note what needs to change, under Reviews.', link: `/reviews?type=${i.type}`, subjectType: i.type, subjectId: i.id,
      dedupeKey: `review:${i.type}:${i.id}:${i.dueOn}:${period}` }));
    if (i.status === 'overdue' && i.daysOverdue >= s.escalateDays) {
      const up = i.owners.length ? managers.filter((u) => !i.owners.includes(u)) : (await usersWithPermission(tx, 'tenant.admin', null)).filter((u) => !managers.includes(u));
      add('review_escalated', await notify(tx, tenantId, up.length ? up : managers, { kind: 'reminder.review_escalated',
        title: `${i.daysOverdue} days overdue: review of ${d.label.replace(/s$/, '').toLowerCase()} ${i.number} ${i.title}`.replace(/\s+/g, ' '), link: `/reviews?type=${i.type}`,
        subjectType: i.type, subjectId: i.id, dedupeKey: `review-esc:${i.type}:${i.id}:${i.dueOn}:${period}` }));
    }
  }
  return counts;
}

// ---------- settings per kind (Admin → Reminders, Periodic reviews) ----------

export function canEditReview(actor: Actor, d: ReviewDef, s: ReviewSetting) {
  if (can(actor, 'tenant.admin')) return true;
  if (s.editorRoles) return actor.grants.some((g) => s.editorRoles!.some((k) => g.roles.has(k)));
  return can(actor, d.permission as never);
}

export async function listReviewSettings(tx: Tx, actor: Actor) {
  const settings = await reviewSettings(tx);
  return REVIEWS.map((d) => { const s = settings.get(d.key)!; return { key: d.key, label: d.label, group: d.group, description: d.description, recipients: d.recipients,
    months: d.months, own: !!d.own, feature: d.feature ?? null, setting: s, canEdit: canEditReview(actor, d, s) }; });
}

export async function setReviewSetting(tx: Tx, actor: Actor, key: string, v: { enabled: boolean; months: number; leadDays: number; repeat: Repeat; escalateDays: number }) {
  const d = REVIEW_BY_KEY.get(key);
  if (!d) throw notFound('review kind');
  const prior = (await reviewSettings(tx)).get(key)!;
  if (!canEditReview(actor, d, prior)) throw forbidden(prior.editorRoles ? `one of the roles ${prior.editorRoles.join(', ')}` : d.permission);
  if (!Number.isInteger(v.months) || v.months < d.months.min || v.months > d.months.max) throw invalid(`${d.label}: every ${d.months.min} to ${d.months.max} months`);
  if (!Number.isInteger(v.leadDays) || v.leadDays < 0 || v.leadDays > 180) throw invalid('warn 0 to 180 days ahead');
  if (!Number.isInteger(v.escalateDays) || v.escalateDays < 1 || v.escalateDays > 365) throw invalid('escalate after 1 to 365 days overdue');
  if (!['daily', 'weekly', 'once'].includes(v.repeat)) throw invalid('repeat daily, weekly or once');
  await saveReviewSetting(tx, actor, key, { ...v, editorRoles: prior.editorRoles });
  await audit(tx, actor, { action: 'review.setting_set', entityType: 'tenant_reminder', entityId: actor.tenantId,
    data: { review: key, from: { enabled: prior.enabled, months: prior.months, leadDays: prior.leadDays, repeat: prior.repeat, escalateDays: prior.escalateDays }, to: v } });
}

export async function saveReviewSetting(tx: Tx, actor: Actor, key: string, v: { enabled: boolean; months: number; leadDays: number; repeat: Repeat; escalateDays: number; editorRoles: string[] | null }) {
  const d = REVIEW_BY_KEY.get(key)!;
  const isDefault = v.enabled && v.months === d.months.default && v.leadDays === REVIEW_DEFAULTS.leadDays && v.repeat === REVIEW_DEFAULTS.repeat && v.escalateDays === REVIEW_DEFAULTS.escalateDays && !v.editorRoles;
  if (isDefault) { await tx.query('DELETE FROM tenant_reminder WHERE reminder_key = $1', [reviewSettingKey(key)]); return; }
  await tx.query(`INSERT INTO tenant_reminder (tenant_id, reminder_key, enabled, lead_days, repeat, interval_months, escalate_days, editor_roles, updated_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    ON CONFLICT (tenant_id, reminder_key) DO UPDATE SET enabled = EXCLUDED.enabled, lead_days = EXCLUDED.lead_days, repeat = EXCLUDED.repeat, interval_months = EXCLUDED.interval_months,
      escalate_days = EXCLUDED.escalate_days, editor_roles = EXCLUDED.editor_roles, updated_by = EXCLUDED.updated_by, updated_at = now()`,
  [actor.tenantId, reviewSettingKey(key), v.enabled, v.leadDays, v.repeat, v.months, v.escalateDays, v.editorRoles, actor.userId]);
}

/** Months for new continuity plans (D-154): the company's setting for continuity reviews. */
export async function defaultContinuityMonths(tx: Tx) {
  return (await reviewSettings(tx)).get('continuity')!.months;
}
