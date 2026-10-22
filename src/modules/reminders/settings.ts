import type { Actor } from '../../platform/auth/actor.js';
import { can } from '../../platform/auth/actor.js';
import { audit } from '../../platform/audit/audit.js';
import type { Tx } from '../../platform/db/tx.js';
import { many } from '../../platform/db/tx.js';
import { forbidden, invalid, notFound } from '../../platform/errors.js';
import { featureSettings } from '../../platform/features.js';
import type { ReminderDef, Repeat } from './catalogue.js';
import { REMINDER_BY_KEY, REMINDERS } from './catalogue.js';

/** Reminder settings per company (D-153): on or off, lead days, repeat; and who may change each one. */
interface Row { reminder_key: string; enabled: boolean; lead_days: number | null; repeat: Repeat | null; editor_roles: string[] | null; updated_at?: string; updated_by?: string }

async function rows(tx: Tx): Promise<Map<string, Row>> {
  return new Map((await many(tx, `SELECT t.reminder_key, t.enabled, t.lead_days, t.repeat, t.editor_roles, t.updated_at, u.display_name AS updated_by
    FROM tenant_reminder t JOIN app_user u ON u.id = t.updated_by`)).map((r) => [r.reminder_key, r as Row]));
}

export function effective(def: ReminderDef, r?: Row) {
  return { enabled: r?.enabled ?? true, lead: def.lead ? r?.lead_days ?? def.lead.default : null, repeat: r?.repeat ?? def.repeat };
}

/** Administrators always; otherwise the roles an administrator named, or else holders of the area's manage permission. */
export function canEditReminder(actor: Actor, def: ReminderDef, r?: Row) {
  if (can(actor, 'tenant.admin')) return true;
  if (r?.editor_roles) return actor.grants.some((g) => r.editor_roles!.some((k) => g.roles.has(k)));
  return can(actor, def.permission as never);
}

export async function canEditAnyReminder(tx: Tx, actor: Actor) {
  if (can(actor, 'tenant.admin')) return true;
  const set = await rows(tx);
  return REMINDERS.some((d) => canEditReminder(actor, d, set.get(d.key)));
}

/** The sweep's view: whether a reminder is on, its lead, and the dedupe period for its repeat. */
export async function sweepSettings(tx: Tx, tenantId: string, today: string, week: string) {
  const set = await rows(tx);
  const features = await featureSettings(tx, tenantId);
  const get = (key: string) => { const d = REMINDER_BY_KEY.get(key)!; return { d, e: effective(d, set.get(key)) }; };
  return {
    on: (key: string) => { const { d, e } = get(key); return e.enabled && !(d.feature && features.get(d.feature)?.mode === 'off'); },
    lead: (key: string) => get(key).e.lead!,
    /** Appended to a dedupe key: the same reminder is not sent twice within the period ('once': never again for that subject and date). */
    period: (key: string) => { const r = get(key).e.repeat; return r === 'daily' ? today : r === 'weekly' ? week : 'once'; },
  };
}

export async function listReminders(tx: Tx, actor: Actor) {
  const set = await rows(tx);
  const admin = can(actor, 'tenant.admin');
  const features = await featureSettings(tx, actor.tenantId);
  const list = REMINDERS.map((d) => {
    const r = set.get(d.key);
    const e = effective(d, r);
    return { ...d, enabled: e.enabled, leadDays: e.lead, repeat: e.repeat, defaultRepeat: d.repeat, canEdit: canEditReminder(actor, d, r), editorRoles: r?.editor_roles ?? null,
      featureOff: !!(d.feature && features.get(d.feature)?.mode === 'off'), updatedAt: r?.updated_at ?? null, updatedBy: r?.updated_by ?? null };
  });
  if (!admin && !list.some((x) => x.canEdit)) throw forbidden('tenant.admin');
  const roles = admin ? await many(tx, 'SELECT key, name FROM role ORDER BY name') : [];
  return { admin, roles, reminders: admin ? list : list.filter((x) => x.canEdit) };
}

export async function setReminder(tx: Tx, actor: Actor, key: string, input: { enabled: boolean; leadDays?: number | null; repeat: Repeat }) {
  const d = REMINDER_BY_KEY.get(key);
  if (!d) throw notFound('reminder');
  const prior = (await rows(tx)).get(key);
  if (!canEditReminder(actor, d, prior)) throw forbidden(prior?.editor_roles ? `one of the roles ${prior.editor_roles.join(', ')}` : d.permission);
  if (!d.repeats.includes(input.repeat)) throw invalid(`${d.label} can repeat ${d.repeats.join(' or ')}`);
  let lead: number | null = null;
  if (d.lead) {
    lead = input.leadDays ?? d.lead.default;
    if (!Number.isInteger(lead) || lead < d.lead.min || lead > d.lead.max) throw invalid(`${d.label}: ${d.lead.min} to ${d.lead.max} days`);
  }
  await save(tx, actor, key, { enabled: input.enabled, lead_days: lead, repeat: input.repeat, editor_roles: prior?.editor_roles ?? null });
  await audit(tx, actor, { action: 'reminder.setting_set', entityType: 'tenant_reminder', entityId: actor.tenantId,
    data: { reminder: key, from: effective(d, prior), to: { enabled: input.enabled, lead, repeat: input.repeat } } });
}

/** Administrators only: which roles may change this reminder (null: holders of the area's manage permission). */
export async function setReminderEditors(tx: Tx, actor: Actor, key: string, roleKeys: string[] | null) {
  if (!can(actor, 'tenant.admin')) throw forbidden('tenant.admin');
  const d = REMINDER_BY_KEY.get(key);
  if (!d) throw notFound('reminder');
  const roles = roleKeys ? [...new Set(roleKeys)] : null;
  if (roles) {
    if (!roles.length) throw invalid('choose at least one role, or go back to the default');
    const known = new Set((await many(tx, 'SELECT key FROM role WHERE key = ANY ($1)', [roles])).map((r) => r.key));
    const unknown = roles.filter((r) => !known.has(r));
    if (unknown.length) throw invalid(`unknown role ${unknown.join(', ')}`);
  }
  const prior = (await rows(tx)).get(key);
  const e = effective(d, prior);
  await save(tx, actor, key, { enabled: e.enabled, lead_days: e.lead, repeat: e.repeat, editor_roles: roles });
  await audit(tx, actor, { action: 'reminder.editors_set', entityType: 'tenant_reminder', entityId: actor.tenantId, data: { reminder: key, from: prior?.editor_roles ?? null, to: roles } });
}

async function save(tx: Tx, actor: Actor, key: string, v: { enabled: boolean; lead_days: number | null; repeat: Repeat; editor_roles: string[] | null }) {
  const d = REMINDER_BY_KEY.get(key)!;
  const isDefault = v.enabled && v.repeat === d.repeat && (d.lead ? v.lead_days === d.lead.default : true) && !v.editor_roles;
  if (isDefault) { await tx.query('DELETE FROM tenant_reminder WHERE reminder_key = $1', [key]); return; }
  await tx.query(`INSERT INTO tenant_reminder (tenant_id, reminder_key, enabled, lead_days, repeat, editor_roles, updated_by) VALUES ($1, $2, $3, $4, $5, $6, $7)
    ON CONFLICT (tenant_id, reminder_key) DO UPDATE SET enabled = EXCLUDED.enabled, lead_days = EXCLUDED.lead_days, repeat = EXCLUDED.repeat,
      editor_roles = EXCLUDED.editor_roles, updated_by = EXCLUDED.updated_by, updated_at = now()`,
  [actor.tenantId, key, v.enabled, v.lead_days, v.repeat, v.editor_roles, actor.userId]);
}
