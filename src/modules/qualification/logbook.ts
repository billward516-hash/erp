import type { Actor } from '../../platform/auth/actor.js';
import { can, requirePermission } from '../../platform/auth/actor.js';
import { audit } from '../../platform/audit/audit.js';
import type { Tx } from '../../platform/db/tx.js';
import { many, one } from '../../platform/db/tx.js';
import { invalid, notFound } from '../../platform/errors.js';

/**
 * The equipment logbook (SC-007 B, D-184B): one time-ordered view of what happened to a tool, combining state changes, work
 * orders, calibrations, qualification events, changes that affect it and manual notes. Nothing is copied: each entry is read from
 * the record that owns it, so the logbook can never disagree with the records. Notes are the only entries written here, and they
 * are append-only (who and when are kept; a correction is a new note). A source the reader may not see is left out and named in
 * `omitted`, so a partial logbook is never mistaken for a complete one.
 */
export const LOG_KINDS = ['state', 'work_order', 'calibration', 'qualification', 'change', 'note'] as const;
export type LogKind = (typeof LOG_KINDS)[number];

export interface LogEntry {
  at: string; kind: LogKind; title: string; detail: string | null; actor: string | null; ref: { type: string; id: string; href: string } | null; engineering?: boolean;
}
const human = (s: string) => s.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
const SOURCE_ORDER: Record<LogKind, number> = { state: 0, work_order: 1, calibration: 2, qualification: 3, change: 4, note: 5 };

export async function logbook(tx: Tx, actor: Actor, assetId: string, opts: { from?: Date; to?: Date; kinds?: LogKind[]; order?: 'asc' | 'desc'; limit?: number } = {}) {
  const a = await one(tx, 'SELECT id, facility_id, asset_tag, name FROM asset WHERE id = $1', [assetId]);
  if (!a) throw notFound('asset');
  requirePermission(actor, 'qualification.view', a.facility_id);
  const from = opts.from ?? new Date(0);
  const to = opts.to ?? new Date(Date.now() + 86_400_000);
  const want = (k: LogKind) => !opts.kinds?.length || opts.kinds.includes(k);
  const entries: (LogEntry & { _o: number; _id: string })[] = [];
  const omitted: string[] = [];
  const push = (kind: LogKind, id: string, at: Date, e: Omit<LogEntry, 'at' | 'kind'>) => entries.push({ ...e, kind, at: new Date(at).toISOString(), _o: SOURCE_ORDER[kind], _id: id });

  if (want('state')) {
    if (!can(actor, 'assets.view', a.facility_id)) omitted.push('state changes');
    else {
      for (const e of await many(tx, `SELECT e.id, e.started_at, e.state, e.reason_code, e.note, e.source, e.engineering, u.display_name AS who FROM asset_state_event e LEFT JOIN app_user u ON u.id = e.recorded_by
        WHERE e.asset_id = $1 AND e.started_at >= $2 AND e.started_at < $3`, [assetId, from, to])) {
        push('state', e.id, e.started_at, { title: `State: ${human(e.state)}${e.engineering ? ' (engineering use)' : ''}`, detail: [e.reason_code ? `reason ${e.reason_code}` : '', e.note ?? '', e.source !== 'manual' ? `source ${e.source}` : ''].filter(Boolean).join('; ') || null,
          actor: e.who, ref: null, engineering: e.engineering });
      }
    }
  }
  if (want('work_order')) {
    if (!can(actor, 'work_orders.view', a.facility_id)) omitted.push('work orders');
    else {
      for (const w of await many(tx, `SELECT w.id, w.number, w.title, w.wo_type, w.remedy, w.created_at, w.completed_at, w.verified_at, cu.display_name AS opened_by, du.display_name AS completed_by, vu.display_name AS verified_by
        FROM work_order w LEFT JOIN app_user cu ON cu.id = w.created_by LEFT JOIN app_user du ON du.id = w.completed_by LEFT JOIN app_user vu ON vu.id = w.verified_by WHERE w.asset_id = $1`, [assetId])) {
        const ref = { type: 'work_order', id: w.id, href: `/work-orders/${w.id}` };
        const within = (d: Date | null) => d && d >= from && d < to;
        if (within(w.created_at)) push('work_order', `${w.id}:1`, w.created_at, { title: `Work order ${w.number} opened: ${w.title}`, detail: human(w.wo_type), actor: w.opened_by, ref });
        if (within(w.completed_at)) push('work_order', `${w.id}:2`, w.completed_at, { title: `Work order ${w.number} completed`, detail: w.remedy ?? null, actor: w.completed_by, ref });
        if (within(w.verified_at)) push('work_order', `${w.id}:3`, w.verified_at, { title: `Work order ${w.number} verified`, detail: null, actor: w.verified_by, ref });
      }
    }
  }
  if (want('calibration')) {
    if (!can(actor, 'quality.view', a.facility_id)) omitted.push('calibrations');
    else {
      for (const c of await many(tx, `SELECT c.id, c.performed_on, c.performed_by, c.as_found, c.as_left, c.certificate_no, c.notes, c.created_at FROM calibration_record c
        WHERE c.asset_id = $1 AND c.performed_on >= $2::date AND c.performed_on < $3::date + 1`, [assetId, from, to])) {
        push('calibration', c.id, new Date(`${new Date(c.performed_on).toISOString().slice(0, 10)}T12:00:00Z`), { title: `Calibration: found ${human(c.as_found).toLowerCase()}, left ${human(c.as_left).toLowerCase()}`,
          detail: [c.certificate_no ? `certificate ${c.certificate_no}` : '', c.notes ?? ''].filter(Boolean).join('; ') || null, actor: c.performed_by, ref: { type: 'calibration_record', id: c.id, href: `/quality/calibration/${c.id}` } });
      }
    }
  }
  if (want('qualification')) {
    for (const e of await many(tx, `SELECT e.id, e.kind, e.occurred_at, e.summary, e.protocol_id, e.ref_type, e.ref_id, u.display_name AS who FROM qualification_event e LEFT JOIN app_user u ON u.id = e.actor_user_id
      WHERE e.asset_id = $1 AND e.occurred_at >= $2 AND e.occurred_at < $3`, [assetId, from, to])) {
      push('qualification', e.id, e.occurred_at, { title: e.summary, detail: null, actor: e.who, ref: e.protocol_id ? { type: 'qualification_protocol', id: e.protocol_id, href: `/qualification/protocols/${e.protocol_id}` } : null });
    }
  }
  if (want('change')) {
    if (!can(actor, 'moc.view', a.facility_id)) omitted.push('changes');
    else {
      for (const c of await many(tx, `SELECT c.id, c.number, c.title, c.created_at, c.approved_at, c.in_service_at, c.closed_at, c.status, ru.display_name AS requested_by
        FROM moc_change c JOIN moc_affected x ON x.change_id = c.id LEFT JOIN app_user ru ON ru.id = c.requested_by WHERE x.entity_type = 'asset' AND x.entity_id = $1`, [assetId])) {
        const ref = { type: 'moc_change', id: c.id, href: `/changes/${c.id}` };
        const within = (d: Date | null) => d && d >= from && d < to;
        if (within(c.created_at)) push('change', `${c.id}:1`, c.created_at, { title: `Change ${c.number} raised: ${c.title}`, detail: null, actor: c.requested_by, ref });
        if (within(c.approved_at)) push('change', `${c.id}:2`, c.approved_at, { title: `Change ${c.number} authorized`, detail: null, actor: null, ref });
        if (within(c.in_service_at)) push('change', `${c.id}:3`, c.in_service_at, { title: `Change ${c.number} put in service`, detail: c.title, actor: null, ref });
        if (within(c.closed_at)) push('change', `${c.id}:4`, c.closed_at, { title: `Change ${c.number} ${c.status === 'cancelled' ? 'cancelled' : 'closed'}`, detail: null, actor: null, ref });
      }
    }
  }
  if (want('note')) {
    for (const n of await many(tx, `SELECT n.id, n.body, n.created_at, u.display_name AS who FROM equipment_note n JOIN app_user u ON u.id = n.created_by WHERE n.asset_id = $1 AND n.created_at >= $2 AND n.created_at < $3`, [assetId, from, to])) {
      push('note', n.id, n.created_at, { title: 'Note', detail: n.body, actor: n.who, ref: null });
    }
  }

  const dir = (opts.order ?? 'desc') === 'asc' ? 1 : -1;
  entries.sort((x, y) => dir * (x.at < y.at ? -1 : x.at > y.at ? 1 : x._o - y._o || (x._id < y._id ? -1 : x._id > y._id ? 1 : 0)));
  const limit = Math.min(opts.limit ?? 1000, 5000);
  return {
    asset: { id: a.id, asset_tag: a.asset_tag, name: a.name, facility_id: a.facility_id }, total: entries.length, truncated: entries.length > limit, omitted,
    entries: entries.slice(0, limit).map(({ _o, _id, ...e }) => e) as LogEntry[],
  };
}

/** A manual note. Append-only: there is no edit; a correction is a new note that refers to the earlier one. */
export async function addNote(tx: Tx, actor: Actor, assetId: string, body: string) {
  const a = await one(tx, 'SELECT id, facility_id, asset_tag FROM asset WHERE id = $1', [assetId]);
  if (!a) throw notFound('asset');
  requirePermission(actor, 'qualification.execute', a.facility_id);
  if (!body?.trim()) throw invalid('write the note');
  if (body.length > 4000) throw invalid('keep the note under 4000 characters');
  const n = await one(tx, `INSERT INTO equipment_note (tenant_id, facility_id, asset_id, body, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING id, created_at`, [actor.tenantId, a.facility_id, assetId, body.trim(), actor.userId]);
  await audit(tx, actor, { action: 'equipment_note.added', entityType: 'asset', entityId: assetId, facilityId: a.facility_id, data: { noteId: n.id } });
  return n;
}
