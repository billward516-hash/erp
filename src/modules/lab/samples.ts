import type { Actor } from '../../platform/auth/actor.js';
import { can, requirePermission } from '../../platform/auth/actor.js';
import { audit } from '../../platform/audit/audit.js';
import type { Tx } from '../../platform/db/tx.js';
import { many, nextSequence, one } from '../../platform/db/tx.js';
import { conflict, invalid, notFound } from '../../platform/errors.js';

export const today = () => new Date().toISOString().slice(0, 10);
const day = (v: unknown) => (v == null ? null : String(v instanceof Date ? v.toISOString() : v).slice(0, 10));

export type CustodyKind = 'received' | 'moved' | 'handed_over' | 'returned' | 'on_hold' | 'resumed' | 'released' | 'disposed';

/** Appends a custody event (who, when, from, to, note). The table refuses any later change. */
export async function addCustody(tx: Tx, actor: Actor, s: { id: string; facility_id: string }, e: { kind: CustodyKind; fromWhere?: string | null; toWhere?: string | null; note?: string | null }) {
  await tx.query('INSERT INTO lab_custody_event (tenant_id, facility_id, sample_id, kind, from_where, to_where, note, by_user_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
    [actor.tenantId, s.facility_id, s.id, e.kind, e.fromWhere?.trim() || null, e.toWhere?.trim() || null, e.note?.trim() || null, actor.userId]);
}

export async function lockSample(tx: Tx, id: string) {
  const s = await one(tx, 'SELECT * FROM lab_sample WHERE id = $1 FOR UPDATE', [id]);
  if (!s) throw notFound('sample');
  return s;
}

/**
 * The sample's working status follows its tests: received (no tests), in testing (a test still without all its results),
 * in review (every test has results, awaiting review or release). Hold, release and disposal are set by their own actions.
 */
export async function refreshStatus(tx: Tx, sampleId: string) {
  const s = await one(tx, 'SELECT status FROM lab_sample WHERE id = $1', [sampleId]);
  if (!s || ['released', 'disposed', 'on_hold'].includes(s.status)) return s?.status as string | undefined;
  const t = await one(tx, `SELECT count(*) FILTER (WHERE status <> 'cancelled')::int AS live, count(*) FILTER (WHERE status = 'assigned')::int AS waiting FROM lab_test WHERE sample_id = $1`, [sampleId]);
  const next = !t!.live ? 'received' : t!.waiting ? 'in_testing' : 'in_review';
  if (next !== s.status) await tx.query('UPDATE lab_sample SET status = $2 WHERE id = $1', [sampleId, next]);
  return next;
}

export interface ReceiveInput {
  facilityId: string; source: 'customer' | 'internal'; customerId?: string | null; customerReference?: string | null; description: string; container?: string | null;
  quantity?: number | null; quantityUnit?: string | null; storageLocation?: string | null; receivedOn?: string | null; dueOn: string; retentionUntil?: string | null;
}

export async function receiveSample(tx: Tx, actor: Actor, input: ReceiveInput) {
  requirePermission(actor, 'lab.analyze', input.facilityId);
  if (!(await one(tx, 'SELECT 1 FROM facility WHERE id = $1', [input.facilityId]))) throw notFound('site');
  if (!input.description?.trim() || input.description.trim().length < 2) throw invalid('describe the sample');
  if (input.source === 'internal' && input.customerId) throw invalid('an internal sample has no customer');
  let customerName: string | null = null;
  if (input.customerId) {
    const c = await one(tx, 'SELECT name FROM customer WHERE id = $1', [input.customerId]);
    if (!c) throw invalid('the customer was not found');
    customerName = c.name;
  }
  const receivedOn = input.receivedOn ?? today();
  if (receivedOn > today()) throw invalid('the received date cannot be in the future');
  if (input.dueOn < receivedOn) throw invalid('the turnaround target is before the received date');
  if (input.retentionUntil && input.retentionUntil < receivedOn) throw invalid('the retention date is before the received date');
  if (input.quantity != null && !(input.quantity >= 0)) throw invalid('the quantity cannot be negative');
  const number = `LS-${String(await nextSequence(tx, actor.tenantId, 'lab_sample')).padStart(6, '0')}`;
  const s = await one(tx, `INSERT INTO lab_sample (tenant_id, facility_id, number, source, customer_id, customer_reference, description, container, quantity, quantity_unit, storage_location,
      received_on, due_on, retention_until, received_by)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) RETURNING *`,
  [actor.tenantId, input.facilityId, number, input.source, input.customerId ?? null, input.customerReference?.trim() || null, input.description.trim(), input.container?.trim() || null,
    input.quantity ?? null, input.quantityUnit?.trim() || null, input.storageLocation?.trim() || null, receivedOn, input.dueOn, input.retentionUntil ?? null, actor.userId]);
  await addCustody(tx, actor, s, { kind: 'received', fromWhere: customerName ?? (input.source === 'customer' ? 'Customer' : 'Internal'), toWhere: input.storageLocation ?? null, note: input.customerReference ? `Reference ${input.customerReference.trim()}` : null });
  await audit(tx, actor, { action: 'lab.sample_received', entityType: 'lab_sample', entityId: s.id, facilityId: s.facility_id, data: { number, source: input.source, customerId: input.customerId ?? null, dueOn: input.dueOn, retentionUntil: input.retentionUntil ?? null } });
  return s;
}

export async function recordCustody(tx: Tx, actor: Actor, sampleId: string, input: { kind: 'moved' | 'handed_over' | 'returned'; toWhere: string; fromWhere?: string | null; note?: string | null }) {
  const s = await lockSample(tx, sampleId);
  requirePermission(actor, 'lab.analyze', s.facility_id);
  if (s.status === 'disposed') throw conflict(`${s.number} has been disposed of`);
  if (!input.toWhere?.trim()) throw invalid('say where or to whom the sample went');
  await addCustody(tx, actor, s, { kind: input.kind, fromWhere: input.fromWhere ?? s.storage_location, toWhere: input.toWhere, note: input.note });
  if (input.kind === 'moved') await tx.query('UPDATE lab_sample SET storage_location = $2 WHERE id = $1', [sampleId, input.toWhere.trim()]);
  await audit(tx, actor, { action: 'lab.sample_custody', entityType: 'lab_sample', entityId: sampleId, facilityId: s.facility_id, data: { kind: input.kind, to: input.toWhere } });
}

export async function holdSample(tx: Tx, actor: Actor, sampleId: string, reason: string) {
  const s = await lockSample(tx, sampleId);
  requirePermission(actor, 'lab.review', s.facility_id);
  if (['on_hold', 'disposed'].includes(s.status)) throw conflict(`${s.number} is ${s.status.replace('_', ' ')}`);
  if (!reason?.trim() || reason.trim().length < 3) throw invalid('say why the sample is on hold');
  await tx.query(`UPDATE lab_sample SET status = 'on_hold', held_from = $2, hold_reason = $3 WHERE id = $1`, [sampleId, s.status, reason.trim()]);
  await addCustody(tx, actor, s, { kind: 'on_hold', note: reason });
  await audit(tx, actor, { action: 'lab.sample_held', entityType: 'lab_sample', entityId: sampleId, facilityId: s.facility_id, data: { reason } });
}

export async function resumeSample(tx: Tx, actor: Actor, sampleId: string, note?: string | null) {
  const s = await lockSample(tx, sampleId);
  requirePermission(actor, 'lab.review', s.facility_id);
  if (s.status !== 'on_hold') throw conflict(`${s.number} is not on hold`);
  await tx.query(`UPDATE lab_sample SET status = $2, held_from = NULL, hold_reason = NULL WHERE id = $1`, [sampleId, s.held_from ?? 'received']);
  await refreshStatus(tx, sampleId);
  await addCustody(tx, actor, s, { kind: 'resumed', note });
  await audit(tx, actor, { action: 'lab.sample_resumed', entityType: 'lab_sample', entityId: sampleId, facilityId: s.facility_id, data: { note: note ?? null } });
}

/**
 * Releases a sample: every test reviewed, every out-of-specification investigation closed, and not by the person who
 * entered any of its results. A confirmed out-of-specification result is released as it is (the certificate shows it).
 */
export async function releaseSample(tx: Tx, actor: Actor, sampleId: string, note?: string | null) {
  const s = await lockSample(tx, sampleId);
  requirePermission(actor, 'lab.review', s.facility_id);
  if (s.status === 'released') throw conflict(`${s.number} has already been released`);
  if (s.status === 'on_hold') throw conflict(`${s.number} is on hold: ${s.hold_reason}`);
  if (s.status === 'disposed') throw conflict(`${s.number} has been disposed of`);
  const open = await many(tx, `SELECT number FROM lab_investigation WHERE sample_id = $1 AND status = 'open' ORDER BY number`, [sampleId]);
  if (open.length) throw conflict(`${open.map((o) => o.number).join(', ')} ${open.length === 1 ? 'is' : 'are'} still open; close the out-of-specification investigation before releasing ${s.number}`);
  const tests = await many(tx, `SELECT t.id, t.status FROM lab_test t WHERE t.sample_id = $1 AND t.status <> 'cancelled'`, [sampleId]);
  if (!tests.length) throw conflict(`${s.number} has no tests to release`);
  const pending = tests.filter((t) => t.status !== 'reviewed');
  if (pending.length) throw conflict(`${pending.length} test${pending.length === 1 ? ' is' : 's are'} not yet reviewed`);
  const mine = await one(tx, `SELECT 1 FROM lab_result r JOIN lab_test t ON t.id = r.test_id WHERE t.sample_id = $1 AND r.superseded_at IS NULL AND r.entered_by = $2 LIMIT 1`, [sampleId, actor.userId]);
  if (mine) throw invalid('you entered results for this sample; someone else releases it');
  await tx.query(`UPDATE lab_sample SET status = 'released', released_at = now(), released_by = $2, release_note = $3 WHERE id = $1`, [sampleId, actor.userId, note?.trim() || null]);
  await addCustody(tx, actor, s, { kind: 'released', note });
  await audit(tx, actor, { action: 'lab.sample_released', entityType: 'lab_sample', entityId: sampleId, facilityId: s.facility_id, data: { number: s.number, tests: tests.length } });
}

export async function disposeSample(tx: Tx, actor: Actor, sampleId: string, input: { note: string; confirmEarly?: boolean }) {
  const s = await lockSample(tx, sampleId);
  requirePermission(actor, 'lab.manage', s.facility_id);
  if (s.status === 'disposed') throw conflict(`${s.number} has already been disposed of`);
  if (!input.note?.trim() || input.note.trim().length < 3) throw invalid('record how and by whom the sample was disposed of');
  const open = await one(tx, `SELECT number FROM lab_investigation WHERE sample_id = $1 AND status = 'open' LIMIT 1`, [sampleId]);
  if (open) throw conflict(`${open.number} is still open; keep the sample until the investigation is closed`);
  const until = day(s.retention_until);
  const early = !!until && until > today();
  if (early && !input.confirmEarly) throw conflict(`${s.number} is to be retained until ${until}; confirm early disposal to record it`);
  await tx.query(`UPDATE lab_sample SET status = 'disposed', disposed_at = now(), disposed_by = $2, disposal_note = $3, held_from = NULL WHERE id = $1`, [sampleId, actor.userId, input.note.trim()]);
  await addCustody(tx, actor, s, { kind: 'disposed', fromWhere: s.storage_location, note: `${early ? `Early disposal (retention until ${until}). ` : ''}${input.note.trim()}` });
  await audit(tx, actor, { action: 'lab.sample_disposed', entityType: 'lab_sample', entityId: sampleId, facilityId: s.facility_id, data: { number: s.number, early, retentionUntil: until } });
}

/** Moves the turnaround target or the retention date. A changed target is recorded with a reason so lateness is not quietly hidden. */
export async function setSampleDates(tx: Tx, actor: Actor, sampleId: string, input: { dueOn?: string; retentionUntil?: string | null; reason: string }) {
  const s = await lockSample(tx, sampleId);
  requirePermission(actor, 'lab.manage', s.facility_id);
  if (s.status === 'disposed') throw conflict(`${s.number} has been disposed of`);
  if (!input.reason?.trim() || input.reason.trim().length < 3) throw invalid('say why the date changes');
  const dueOn = input.dueOn ?? day(s.due_on)!;
  const retention = input.retentionUntil !== undefined ? input.retentionUntil : day(s.retention_until);
  if (dueOn < day(s.received_on)!) throw invalid('the turnaround target is before the received date');
  if (retention && retention < day(s.received_on)!) throw invalid('the retention date is before the received date');
  await tx.query('UPDATE lab_sample SET due_on = $2, retention_until = $3 WHERE id = $1', [sampleId, dueOn, retention]);
  await audit(tx, actor, { action: 'lab.sample_dates_changed', entityType: 'lab_sample', entityId: sampleId, facilityId: s.facility_id,
    data: { number: s.number, dueOn: { from: day(s.due_on), to: dueOn }, retentionUntil: { from: day(s.retention_until), to: retention }, reason: input.reason.trim() } });
}

export async function listSamples(tx: Tx, actor: Actor, q: { facilityId?: string; status?: string; open?: boolean; overdue?: boolean } = {}) {
  requirePermission(actor, 'lab.view');
  const rows = await many(tx, `SELECT s.*, f.code AS facility_code, c.name AS customer_name, u.display_name AS received_by_name,
      (s.status NOT IN ('released', 'disposed') AND s.due_on < current_date) AS overdue, (current_date - s.due_on) AS days_late,
      (SELECT count(*)::int FROM lab_test t WHERE t.sample_id = s.id AND t.status <> 'cancelled') AS tests,
      (SELECT count(*)::int FROM lab_test t WHERE t.sample_id = s.id AND t.status = 'reviewed') AS tests_reviewed,
      (SELECT count(*)::int FROM lab_investigation i WHERE i.sample_id = s.id AND i.status = 'open') AS open_investigations,
      (SELECT count(*)::int FROM lab_result r JOIN lab_test t ON t.id = r.test_id WHERE t.sample_id = s.id AND r.superseded_at IS NULL AND r.outcome = 'fail') AS failing_results
    FROM lab_sample s JOIN facility f ON f.id = s.facility_id JOIN app_user u ON u.id = s.received_by LEFT JOIN customer c ON c.id = s.customer_id
    WHERE ($1::uuid IS NULL OR s.facility_id = $1) AND ($2::text IS NULL OR s.status = $2) AND (NOT $3::boolean OR s.status NOT IN ('released', 'disposed'))
      AND (NOT $4::boolean OR (s.status NOT IN ('released', 'disposed') AND s.due_on < current_date))
    ORDER BY (s.status IN ('released', 'disposed')), s.due_on, s.number`, [q.facilityId ?? null, q.status ?? null, q.open ?? false, q.overdue ?? false]);
  return rows.filter((s) => can(actor, 'lab.view', s.facility_id));
}

export async function getSample(tx: Tx, actor: Actor, id: string) {
  const s = await one(tx, `SELECT s.*, f.code AS facility_code, f.name AS facility_name, c.name AS customer_name, c.code AS customer_code, ru.display_name AS received_by_name,
      rl.display_name AS released_by_name, dp.display_name AS disposed_by_name,
      (s.status NOT IN ('released', 'disposed') AND s.due_on < current_date) AS overdue, (current_date - s.due_on) AS days_late
    FROM lab_sample s JOIN facility f ON f.id = s.facility_id JOIN app_user ru ON ru.id = s.received_by LEFT JOIN customer c ON c.id = s.customer_id
    LEFT JOIN app_user rl ON rl.id = s.released_by LEFT JOIN app_user dp ON dp.id = s.disposed_by WHERE s.id = $1`, [id]);
  if (!s) throw notFound('sample');
  requirePermission(actor, 'lab.view', s.facility_id);
  const tests = await many(tx, `SELECT t.*, m.code AS method_code, m.version AS method_version, m.name AS method_name, m.required_instrument_class, m.required_qualification_id,
      q.code AS qualification_code, q.name AS qualification_name, au.display_name AS assigned_name, eu.display_name AS entered_by_name, ru.display_name AS reviewed_by_name,
      coalesce((SELECT json_agg(json_build_object('id', a.id, 'name', a.name, 'unit', a.unit, 'specLow', a.spec_low::float, 'specHigh', a.spec_high::float) ORDER BY a.seq)
                FROM lab_method_analyte a WHERE a.method_id = m.id), '[]') AS analytes
    FROM lab_test t JOIN lab_method m ON m.id = t.method_id LEFT JOIN qualification q ON q.id = m.required_qualification_id LEFT JOIN app_user au ON au.id = t.assigned_user_id
    LEFT JOIN app_user eu ON eu.id = t.entered_by LEFT JOIN app_user ru ON ru.id = t.reviewed_by WHERE t.sample_id = $1 ORDER BY t.created_at`, [id]);
  const results = await many(tx, `SELECT r.id, r.test_id, r.analyte_id, r.analyte_name, r.unit, r.spec_low::float AS spec_low, r.spec_high::float AS spec_high, r.value::float AS value, r.outcome,
      r.instrument_tag, r.instrument_cal_due, r.note, r.entered_at, r.superseded_at, r.superseded_reason, u.display_name AS entered_by_name, r.entered_by
    FROM lab_result r JOIN lab_test t ON t.id = r.test_id JOIN app_user u ON u.id = r.entered_by WHERE t.sample_id = $1 ORDER BY r.entered_at`, [id]);
  const investigations = await many(tx, `SELECT i.*, r.analyte_name, r.value::float AS value, r.unit, r.entered_by AS result_entered_by, n.number AS ncr_number, ca.number AS capa_number
    FROM lab_investigation i JOIN lab_result r ON r.id = i.result_id LEFT JOIN nonconformance n ON n.id = i.ncr_id LEFT JOIN corrective_action ca ON ca.id = i.capa_id
    WHERE i.sample_id = $1 ORDER BY i.number`, [id]);
  const custody = await many(tx, `SELECT e.id, e.kind, e.from_where, e.to_where, e.note, e.at, u.display_name AS by_name FROM lab_custody_event e JOIN app_user u ON u.id = e.by_user_id
    WHERE e.sample_id = $1 ORDER BY e.at, e.id`, [id]);
  return {
    ...s, tests: tests.map((t) => ({ ...t, results: results.filter((r) => r.test_id === t.id) })), investigations, custody,
    canAnalyze: can(actor, 'lab.analyze', s.facility_id), canReview: can(actor, 'lab.review', s.facility_id), canManage: can(actor, 'lab.manage', s.facility_id),
  };
}
