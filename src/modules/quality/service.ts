import type { Actor } from '../../platform/auth/actor.js';
import { can, requirePermission } from '../../platform/auth/actor.js';
import { audit } from '../../platform/audit/audit.js';
import type { Tx } from '../../platform/db/tx.js';
import { many, nextSequence, one } from '../../platform/db/tx.js';
import { conflict, forbidden, invalid, notFound } from '../../platform/errors.js';
import { notify, usersWithPermission } from '../../platform/notify/notify.js';

const NCR = 'nonconformance';
const CAPA = 'corrective_action';
const today = () => new Date().toISOString().slice(0, 10);
const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const money = (n: number) => Math.round(n * 100) / 100;

/** A user who can be given work at a facility: active, with a role there or a corporate role. */
async function assertAssignable(tx: Tx, userId: string, facilityId: string) {
  const ok = await one(tx, `SELECT 1 FROM app_user u JOIN user_role_assignment a ON a.user_id = u.id
    WHERE u.id = $1 AND u.status = 'active' AND (a.facility_id IS NULL OR a.facility_id = $2) LIMIT 1`, [userId, facilityId]);
  if (!ok) throw invalid('the owner must be an active user with access to this facility');
}

// ---------------------------------------------------------------------------
// Nonconformances
// ---------------------------------------------------------------------------

export interface NcrInput {
  facilityId?: string; source?: 'production' | 'receiving' | 'customer' | 'supplier' | 'internal'; title?: string; description: string; severity?: 'minor' | 'major' | 'critical';
  partId?: string | null; qty?: number | null; productionEntryId?: string | null; productionOrderId?: string | null; purchaseOrderId?: string | null;
  supplierId?: string | null; customerId?: string | null; salesOrderId?: string | null; assetId?: string | null;
}

/**
 * Raises a nonconformance. From a production run with scrap it fills in the order, part, quantity and
 * reason; from a purchase order it fills in the supplier. Quality staff at the facility are told.
 */
export async function createNcr(tx: Tx, actor: Actor, input: NcrInput) {
  const v = { ...input };
  let ctx = '';
  if (v.productionEntryId) {
    const e = await one(tx, `SELECT e.*, o.part_id, o.number, op.op_no, sr.label AS reason FROM production_entry e JOIN production_order o ON o.id = e.order_id
      JOIN production_operation op ON op.id = e.operation_id LEFT JOIN scrap_reason sr ON sr.code = e.scrap_reason WHERE e.id = $1`, [v.productionEntryId]);
    if (!e) throw notFound('production run');
    if (await one(tx, `SELECT number FROM nonconformance WHERE production_entry_id = $1 AND status <> 'cancelled'`, [v.productionEntryId])) throw conflict('a nonconformance already covers this run');
    Object.assign(v, { facilityId: e.facility_id, source: 'production', productionOrderId: e.order_id, partId: e.part_id, qty: v.qty ?? (Number(e.qty_scrap) || null), assetId: v.assetId ?? e.asset_id });
    ctx = `${e.number} op ${e.op_no}${e.reason ? `: ${e.reason}` : ''}`;
  }
  if (v.purchaseOrderId) {
    const po = await one(tx, 'SELECT facility_id, supplier_id, number FROM purchase_order WHERE id = $1', [v.purchaseOrderId]);
    if (!po) throw notFound('purchase order');
    Object.assign(v, { facilityId: v.facilityId ?? po.facility_id, supplierId: po.supplier_id, source: v.source ?? 'receiving' });
    ctx = ctx || `${po.number}`;
  }
  if (v.salesOrderId) {
    const so = await one(tx, 'SELECT facility_id, customer_id FROM sales_order WHERE id = $1', [v.salesOrderId]);
    if (!so) throw notFound('sales order');
    Object.assign(v, { facilityId: v.facilityId ?? so.facility_id, customerId: so.customer_id, source: v.source ?? 'customer' });
  }
  if (!v.facilityId) throw invalid('choose the facility');
  requirePermission(actor, 'quality.report', v.facilityId);
  if (!v.description?.trim()) throw invalid('describe what is wrong');
  if (v.qty != null && !(v.qty > 0)) throw invalid('quantity must be positive');
  if (v.productionOrderId && !v.productionEntryId) {
    const o = await one(tx, 'SELECT facility_id, part_id FROM production_order WHERE id = $1', [v.productionOrderId]);
    if (!o || o.facility_id !== v.facilityId) throw invalid('production order not found at this facility');
    v.partId = v.partId ?? o.part_id;
  }
  const part = v.partId ? await one(tx, 'SELECT part_number FROM part WHERE id = $1', [v.partId]) : null;
  const title = v.title?.trim() || [part?.part_number, ctx, part && ctx ? null : v.description.trim().slice(0, 80)].filter(Boolean).join(' · ');
  const number = `NCR-${String(await nextSequence(tx, actor.tenantId, 'ncr')).padStart(6, '0')}`;
  const n = await one(tx, `INSERT INTO nonconformance (tenant_id, facility_id, number, source, title, description, severity, part_id, qty, production_order_id, production_entry_id,
      purchase_order_id, supplier_id, customer_id, sales_order_id, asset_id, reported_by)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17) RETURNING *`,
  [actor.tenantId, v.facilityId, number, v.source ?? 'internal', title, v.description.trim(), v.severity ?? 'minor', v.partId ?? null, v.qty ?? null, v.productionOrderId ?? null,
    v.productionEntryId ?? null, v.purchaseOrderId ?? null, v.supplierId ?? null, v.customerId ?? null, v.salesOrderId ?? null, v.assetId ?? null, actor.userId]);
  await notify(tx, actor.tenantId, await usersWithPermission(tx, 'quality.manage', v.facilityId), { kind: 'quality.ncr_raised',
    title: `${number} (${n.severity}): ${title}`, body: v.description.trim().slice(0, 300), link: `/quality/ncr/${n.id}`, subjectType: NCR, subjectId: n.id, dedupeKey: `ncr:${n.id}` }, actor.userId);
  await audit(tx, actor, { action: 'ncr.raised', entityType: NCR, entityId: n.id, facilityId: n.facility_id, data: { number, source: n.source, severity: n.severity, qty: v.qty ?? null } });
  return n;
}

async function lockNcr(tx: Tx, id: string) {
  const n = await one(tx, 'SELECT * FROM nonconformance WHERE id = $1 FOR UPDATE', [id]);
  if (!n) throw notFound('nonconformance');
  return n;
}

/** Records what was done to stop the problem spreading (quarantine, sort, hold). */
export async function containNcr(tx: Tx, actor: Actor, id: string, containment: string) {
  const n = await lockNcr(tx, id);
  requirePermission(actor, 'quality.manage', n.facility_id);
  if (!['open', 'contained'].includes(n.status)) throw conflict(`nonconformance is ${n.status}`);
  if (!containment?.trim()) throw invalid('describe the containment');
  await tx.query(`UPDATE nonconformance SET containment = $2, contained_by = $3, contained_at = now(), status = 'contained' WHERE id = $1`, [id, containment.trim(), actor.userId]);
  await audit(tx, actor, { action: 'ncr.contained', entityType: NCR, entityId: id, facilityId: n.facility_id, data: { containment } });
}

/**
 * Decides what happens to the nonconforming material. Accepting it as is (or repairing it) on a major or
 * critical nonconformance is a concession: it needs a written justification and someone other than the
 * person who reported it. Scrap is costed at the part's current unit cost unless a cost is given.
 */
export async function dispositionNcr(tx: Tx, actor: Actor, id: string, input: { disposition: 'use_as_is' | 'rework' | 'repair' | 'scrap' | 'return_to_supplier'; reason?: string | null; cost?: number | null }) {
  const n = await lockNcr(tx, id);
  requirePermission(actor, 'quality.manage', n.facility_id);
  if (!['open', 'contained'].includes(n.status)) throw conflict(`nonconformance is ${n.status}`);
  const concession = ['use_as_is', 'repair'].includes(input.disposition) && n.severity !== 'minor';
  if (concession) {
    if ((input.reason?.trim().length ?? 0) < 10) throw invalid('accepting a major or critical nonconformance needs a written justification (who accepted it and why)');
    if (n.reported_by === actor.userId) throw forbidden('quality.manage (someone other than the reporter must accept a concession)');
  }
  if (input.disposition === 'return_to_supplier' && !n.supplier_id) throw invalid('no supplier is linked to this nonconformance');
  let cost = input.cost ?? null;
  if (cost == null && input.disposition === 'scrap' && n.part_id && n.qty) {
    const p = await one(tx, 'SELECT unit_cost::float AS c FROM part WHERE id = $1', [n.part_id]);
    if (p?.c != null) cost = money(Number(n.qty) * p.c);
  }
  await tx.query(`UPDATE nonconformance SET disposition = $2, disposition_reason = $3, cost = $4, dispositioned_by = $5, dispositioned_at = now(), status = 'dispositioned' WHERE id = $1`,
    [id, input.disposition, input.reason ?? null, cost, actor.userId]);
  await audit(tx, actor, { action: 'ncr.dispositioned', entityType: NCR, entityId: id, facilityId: n.facility_id, data: { disposition: input.disposition, concession, cost, reason: input.reason ?? null } });
}

/** Closes a dispositioned nonconformance. Major and critical ones need a corrective action linked first. */
export async function closeNcr(tx: Tx, actor: Actor, id: string) {
  const n = await lockNcr(tx, id);
  requirePermission(actor, 'quality.manage', n.facility_id);
  if (n.status !== 'dispositioned') throw conflict(n.status === 'closed' ? 'already closed' : 'disposition the material before closing');
  if (n.severity !== 'minor' && !n.capa_id) throw invalid(`a ${n.severity} nonconformance needs a corrective action before it closes`);
  await tx.query(`UPDATE nonconformance SET status = 'closed', closed_by = $2, closed_at = now() WHERE id = $1`, [id, actor.userId]);
  await audit(tx, actor, { action: 'ncr.closed', entityType: NCR, entityId: id, facilityId: n.facility_id, data: {} });
}

export async function cancelNcr(tx: Tx, actor: Actor, id: string, reason: string) {
  const n = await lockNcr(tx, id);
  requirePermission(actor, 'quality.manage', n.facility_id);
  if (['closed', 'cancelled'].includes(n.status)) throw conflict(`nonconformance is ${n.status}`);
  if (!reason?.trim()) throw invalid('a reason is required');
  await tx.query(`UPDATE nonconformance SET status = 'cancelled', cancel_reason = $2 WHERE id = $1`, [id, reason]);
  await audit(tx, actor, { action: 'ncr.cancelled', entityType: NCR, entityId: id, facilityId: n.facility_id, data: { reason } });
}

export async function linkNcrToCapa(tx: Tx, actor: Actor, ncrId: string, capaId: string) {
  const n = await lockNcr(tx, ncrId);
  requirePermission(actor, 'quality.manage', n.facility_id);
  const c = await one(tx, 'SELECT number, status FROM corrective_action WHERE id = $1', [capaId]);
  if (!c) throw notFound('corrective action');
  if (['closed', 'cancelled'].includes(c.status)) throw conflict(`${c.number} is ${c.status}`);
  await tx.query('UPDATE nonconformance SET capa_id = $2 WHERE id = $1', [ncrId, capaId]);
  await audit(tx, actor, { action: 'ncr.linked', entityType: NCR, entityId: ncrId, facilityId: n.facility_id, data: { capa: c.number } });
}

export async function getNcr(tx: Tx, actor: Actor, id: string) {
  const n = await one(tx, `SELECT n.*, n.qty::float AS qty, n.cost::float AS cost, f.code AS facility_code, p.part_number, p.description AS part_description, p.uom,
      mo.number AS production_order_number, po.number AS purchase_order_number, s.name AS supplier_name, c.name AS customer_name, so.number AS sales_order_number,
      a.asset_tag, ca.number AS capa_number, ca.status AS capa_status, ru.display_name AS reported_by_name, cu.display_name AS contained_by_name, du.display_name AS dispositioned_by_name,
      e.scrap_reason, sr.label AS scrap_label, op.op_no
    FROM nonconformance n JOIN facility f ON f.id = n.facility_id LEFT JOIN part p ON p.id = n.part_id LEFT JOIN production_order mo ON mo.id = n.production_order_id
    LEFT JOIN purchase_order po ON po.id = n.purchase_order_id LEFT JOIN supplier s ON s.id = n.supplier_id LEFT JOIN customer c ON c.id = n.customer_id
    LEFT JOIN sales_order so ON so.id = n.sales_order_id LEFT JOIN asset a ON a.id = n.asset_id LEFT JOIN corrective_action ca ON ca.id = n.capa_id
    LEFT JOIN production_entry e ON e.id = n.production_entry_id LEFT JOIN production_operation op ON op.id = e.operation_id LEFT JOIN scrap_reason sr ON sr.code = e.scrap_reason
    JOIN app_user ru ON ru.id = n.reported_by LEFT JOIN app_user cu ON cu.id = n.contained_by LEFT JOIN app_user du ON du.id = n.dispositioned_by WHERE n.id = $1`, [id]);
  if (!n) throw notFound('nonconformance');
  if (!can(actor, 'quality.view', n.facility_id) && n.reported_by !== actor.userId) throw forbidden('quality.view');
  const openCapas = can(actor, 'quality.manage', n.facility_id)
    ? await many(tx, `SELECT id, number, title FROM corrective_action WHERE facility_id = $1 AND status NOT IN ('closed', 'cancelled') ORDER BY number DESC LIMIT 50`, [n.facility_id]) : [];
  return { ...n, openCapas };
}

export async function listNcrs(tx: Tx, actor: Actor, q: { status?: string; open?: boolean; source?: string; partId?: string; supplierId?: string } = {}) {
  const rows = await many(tx, `SELECT n.id, n.number, n.title, n.source, n.severity, n.status, n.qty::float AS qty, n.cost::float AS cost, n.disposition, n.created_at, n.facility_id, n.reported_by,
      f.code AS facility_code, p.part_number, s.name AS supplier_name, c.name AS customer_name, ca.number AS capa_number, (current_date - n.created_at::date) AS age_days
    FROM nonconformance n JOIN facility f ON f.id = n.facility_id LEFT JOIN part p ON p.id = n.part_id LEFT JOIN supplier s ON s.id = n.supplier_id
    LEFT JOIN customer c ON c.id = n.customer_id LEFT JOIN corrective_action ca ON ca.id = n.capa_id
    WHERE ($1::text IS NULL OR n.status = $1) AND (NOT $2 OR n.status IN ('open', 'contained', 'dispositioned')) AND ($3::text IS NULL OR n.source = $3)
      AND ($4::uuid IS NULL OR n.part_id = $4) AND ($5::uuid IS NULL OR n.supplier_id = $5)
    ORDER BY n.created_at DESC LIMIT 500`, [q.status ?? null, q.open ?? false, q.source ?? null, q.partId ?? null, q.supplierId ?? null]);
  return rows.filter((r) => can(actor, 'quality.view', r.facility_id) || r.reported_by === actor.userId);
}

// ---------------------------------------------------------------------------
// Corrective actions
// ---------------------------------------------------------------------------

const capaManager = (actor: Actor, c: { facility_id: string; owner_user_id: string; source: string }) =>
  can(actor, 'quality.manage', c.facility_id) || (c.source === 'incident' && can(actor, 'safety.manage', c.facility_id));

export async function createCapa(tx: Tx, actor: Actor, input: { facilityId: string; title: string; problem: string; source: 'nonconformance' | 'incident' | 'customer_complaint' | 'audit' | 'internal';
  priority?: 'low' | 'medium' | 'high'; ownerUserId: string; dueDate?: string | null; ncrIds?: string[]; incidentId?: string | null }) {
  if (input.source === 'incident') {
    if (!can(actor, 'safety.manage', input.facilityId) && !can(actor, 'quality.manage', input.facilityId)) throw forbidden('safety.manage');
  } else requirePermission(actor, 'quality.manage', input.facilityId);
  if (!input.title?.trim() || !input.problem?.trim()) throw invalid('a title and a problem statement are required');
  await assertAssignable(tx, input.ownerUserId, input.facilityId);
  const number = `CA-${String(await nextSequence(tx, actor.tenantId, 'capa')).padStart(6, '0')}`;
  const c = await one(tx, `INSERT INTO corrective_action (tenant_id, facility_id, number, title, problem, source, priority, owner_user_id, due_date, created_by)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
  [actor.tenantId, input.facilityId, number, input.title.trim(), input.problem.trim(), input.source, input.priority ?? 'medium', input.ownerUserId, input.dueDate ?? addDays(today(), 30), actor.userId]);
  for (const nid of input.ncrIds ?? []) {
    const n = await one(tx, 'SELECT facility_id, status FROM nonconformance WHERE id = $1', [nid]);
    if (!n || n.facility_id !== input.facilityId) throw invalid('linked nonconformances must be at the same facility');
    await tx.query('UPDATE nonconformance SET capa_id = $2 WHERE id = $1', [nid, c.id]);
  }
  if (input.incidentId) {
    const i = await one(tx, 'SELECT facility_id FROM safety_incident WHERE id = $1', [input.incidentId]);
    if (!i || i.facility_id !== input.facilityId) throw invalid('the incident must be at the same facility');
    await tx.query('UPDATE safety_incident SET capa_id = $2 WHERE id = $1', [input.incidentId, c.id]);
  }
  await notify(tx, actor.tenantId, [input.ownerUserId], { kind: 'quality.capa_assigned', title: `You own ${number}: ${c.title}`, body: c.problem.slice(0, 300),
    link: `/quality/capa/${c.id}`, subjectType: CAPA, subjectId: c.id, dedupeKey: `capa-owner:${c.id}:${input.ownerUserId}` }, actor.userId);
  await audit(tx, actor, { action: 'capa.opened', entityType: CAPA, entityId: c.id, facilityId: c.facility_id, data: { number, source: c.source, owner: input.ownerUserId, ncrs: input.ncrIds ?? [], incident: input.incidentId ?? null } });
  return c;
}

async function lockCapa(tx: Tx, id: string) {
  const c = await one(tx, 'SELECT * FROM corrective_action WHERE id = $1 FOR UPDATE', [id]);
  if (!c) throw notFound('corrective action');
  return c;
}

export async function updateCapa(tx: Tx, actor: Actor, id: string, input: { containment?: string | null; rootCauseMethod?: string | null; rootCause?: string | null;
  verifyAfter?: string | null; dueDate?: string | null; priority?: string; ownerUserId?: string }) {
  const c = await lockCapa(tx, id);
  if (c.owner_user_id !== actor.userId && !capaManager(actor, c)) throw forbidden('quality.manage (or be the owner)');
  if (['closed', 'cancelled'].includes(c.status)) throw conflict(`corrective action is ${c.status}`);
  if (input.ownerUserId && input.ownerUserId !== c.owner_user_id) {
    if (!capaManager(actor, c)) throw forbidden('quality.manage');
    await assertAssignable(tx, input.ownerUserId, c.facility_id);
    await notify(tx, actor.tenantId, [input.ownerUserId], { kind: 'quality.capa_assigned', title: `You own ${c.number}: ${c.title}`, link: `/quality/capa/${id}`,
      subjectType: CAPA, subjectId: id, dedupeKey: `capa-owner:${id}:${input.ownerUserId}` }, actor.userId);
  }
  const map: Record<string, string> = { containment: 'containment', rootCauseMethod: 'root_cause_method', rootCause: 'root_cause', verifyAfter: 'verify_after', dueDate: 'due_date', priority: 'priority', ownerUserId: 'owner_user_id' };
  const sets: string[] = []; const vals: unknown[] = [id];
  for (const [k, col] of Object.entries(map)) if ((input as any)[k] !== undefined) { vals.push((input as any)[k]); sets.push(`${col} = $${vals.length}`); }
  if (sets.length) await tx.query(`UPDATE corrective_action SET ${sets.join(', ')} WHERE id = $1`, vals);
  await audit(tx, actor, { action: 'capa.updated', entityType: CAPA, entityId: id, facilityId: c.facility_id, data: input });
}

const NEXT: Record<string, string> = { open: 'root_cause', root_cause: 'actions', actions: 'verification' };

/**
 * Moves the corrective action forward one step, checking the step's evidence: containment before root-cause
 * work, a stated root cause (and method) before actions, and every action finished before verification.
 */
export async function advanceCapa(tx: Tx, actor: Actor, id: string) {
  const c = await lockCapa(tx, id);
  if (c.owner_user_id !== actor.userId && !capaManager(actor, c)) throw forbidden('quality.manage (or be the owner)');
  const next = NEXT[c.status];
  if (!next) throw conflict(c.status === 'verification' ? 'the effectiveness check closes it' : `corrective action is ${c.status}`);
  if (next === 'root_cause' && !c.containment?.trim()) throw invalid('record the containment (or that none was needed) first');
  if (next === 'actions' && (!c.root_cause_method || !c.root_cause?.trim())) throw invalid('state the root cause and how it was found first');
  if (next === 'verification') {
    const a = await many(tx, `SELECT status FROM action_item WHERE subject_type = 'corrective_action' AND subject_id = $1`, [id]);
    if (a.some((x) => x.status === 'open')) throw invalid('finish or cancel the open actions first');
    if (!a.some((x) => x.status === 'done')) throw invalid('complete at least one action first');
    if (!c.verify_after) await tx.query('UPDATE corrective_action SET verify_after = $2 WHERE id = $1', [id, addDays(today(), 30)]);
  }
  await tx.query('UPDATE corrective_action SET status = $2 WHERE id = $1', [id, next]);
  await audit(tx, actor, { action: 'capa.advanced', entityType: CAPA, entityId: id, facilityId: c.facility_id, data: { from: c.status, to: next } });
  return next;
}

/**
 * The effectiveness check, by someone other than the owner and not before the date set for it. Effective closes
 * the corrective action (and its linked nonconformances may then close); not effective sends it back to actions.
 */
export async function verifyCapa(tx: Tx, actor: Actor, id: string, input: { effective: boolean; note: string }) {
  const c = await lockCapa(tx, id);
  if (!capaManager(actor, c)) throw forbidden('quality.manage');
  if (c.status !== 'verification') throw conflict('the corrective action is not waiting for its effectiveness check');
  if (c.owner_user_id === actor.userId) throw forbidden('quality.manage (the owner cannot verify their own corrective action)');
  if (c.verify_after && c.verify_after > today()) throw conflict(`the effectiveness check is due on ${c.verify_after}; it needs time to show the fix holds`);
  if ((input.note?.trim().length ?? 0) < 10) throw invalid('describe the evidence (data, audits, samples) that the fix worked or did not');
  if (input.effective) {
    await tx.query(`UPDATE corrective_action SET status = 'closed', effective = true, effectiveness_note = $2, verified_by = $3, verified_at = now(), closed_at = now() WHERE id = $1`, [id, input.note, actor.userId]);
  } else {
    await tx.query(`UPDATE corrective_action SET status = 'actions', effective = false, effectiveness_note = $2, verify_after = NULL WHERE id = $1`, [id, input.note]);
    await notify(tx, actor.tenantId, [c.owner_user_id], { kind: 'quality.capa_assigned', title: `${c.number} was not effective; more actions needed`, body: input.note,
      link: `/quality/capa/${id}`, subjectType: CAPA, subjectId: id, dedupeKey: `capa-reopen:${id}:${Date.now()}` }, actor.userId);
  }
  await audit(tx, actor, { action: input.effective ? 'capa.verified_effective' : 'capa.verified_not_effective', entityType: CAPA, entityId: id, facilityId: c.facility_id, data: { note: input.note } });
}

export async function cancelCapa(tx: Tx, actor: Actor, id: string, reason: string) {
  const c = await lockCapa(tx, id);
  if (!capaManager(actor, c)) throw forbidden('quality.manage');
  if (['closed', 'cancelled'].includes(c.status)) throw conflict(`corrective action is ${c.status}`);
  if (!reason?.trim()) throw invalid('a reason is required');
  await tx.query(`UPDATE corrective_action SET status = 'cancelled', cancel_reason = $2 WHERE id = $1`, [id, reason]);
  await tx.query(`UPDATE action_item SET status = 'cancelled', completion_note = 'Corrective action cancelled' WHERE subject_type = 'corrective_action' AND subject_id = $1 AND status = 'open'`, [id]);
  await audit(tx, actor, { action: 'capa.cancelled', entityType: CAPA, entityId: id, facilityId: c.facility_id, data: { reason } });
}

export async function getCapa(tx: Tx, actor: Actor, id: string) {
  const c = await one(tx, `SELECT c.*, f.code AS facility_code, u.display_name AS owner_name, vu.display_name AS verified_by_name, cu.display_name AS created_by_name,
      (c.status NOT IN ('closed', 'cancelled') AND c.due_date < current_date) AS overdue
    FROM corrective_action c JOIN facility f ON f.id = c.facility_id JOIN app_user u ON u.id = c.owner_user_id LEFT JOIN app_user vu ON vu.id = c.verified_by
    JOIN app_user cu ON cu.id = c.created_by WHERE c.id = $1`, [id]);
  if (!c) throw notFound('corrective action');
  if (!can(actor, 'quality.view', c.facility_id) && !can(actor, 'safety.view', c.facility_id) && c.owner_user_id !== actor.userId) throw forbidden('quality.view');
  const actions = await listActions(tx, 'corrective_action', id);
  const ncrs = await many(tx, `SELECT id, number, title, severity, status, qty::float AS qty, cost::float AS cost FROM nonconformance WHERE capa_id = $1 ORDER BY number`, [id]);
  const incidents = await many(tx, `SELECT id, number, kind, status, occurred_at FROM safety_incident WHERE capa_id = $1 ORDER BY number`, [id]);
  const owners = capaManager(actor, c) || c.owner_user_id === actor.userId ? await assignableUsers(tx, c.facility_id) : [];
  return { ...c, actions, ncrs, incidents, owners, canManage: capaManager(actor, c) };
}

export async function listCapas(tx: Tx, actor: Actor, q: { status?: string; open?: boolean; mine?: boolean } = {}) {
  const rows = await many(tx, `SELECT c.id, c.number, c.title, c.source, c.priority, c.status, c.due_date, c.verify_after, c.facility_id, c.owner_user_id, f.code AS facility_code,
      u.display_name AS owner_name, (c.status NOT IN ('closed', 'cancelled') AND c.due_date < current_date) AS overdue,
      (SELECT count(*)::int FROM action_item a WHERE a.subject_type = 'corrective_action' AND a.subject_id = c.id AND a.status = 'open') AS open_actions,
      (SELECT count(*)::int FROM nonconformance n WHERE n.capa_id = c.id) AS ncrs
    FROM corrective_action c JOIN facility f ON f.id = c.facility_id JOIN app_user u ON u.id = c.owner_user_id
    WHERE ($1::text IS NULL OR c.status = $1) AND (NOT $2 OR c.status NOT IN ('closed', 'cancelled')) AND (NOT $3 OR c.owner_user_id = $4)
    ORDER BY c.due_date NULLS LAST, c.number LIMIT 500`, [q.status ?? null, q.open ?? false, q.mine ?? false, actor.userId]);
  return rows.filter((r) => can(actor, 'quality.view', r.facility_id) || (r.source === 'incident' && can(actor, 'safety.view', r.facility_id)) || r.owner_user_id === actor.userId);
}

export async function assignableUsers(tx: Tx, facilityId: string) {
  return many(tx, `SELECT DISTINCT u.id, u.display_name FROM app_user u JOIN user_role_assignment a ON a.user_id = u.id
    WHERE u.status = 'active' AND (a.facility_id IS NULL OR a.facility_id = $1) ORDER BY u.display_name`, [facilityId]);
}

// ---------------------------------------------------------------------------
// Shared action tracker
// ---------------------------------------------------------------------------

type Subject = 'corrective_action' | 'safety_incident' | 'quality_audit';

async function subjectOf(tx: Tx, type: Subject, id: string) {
  if (type === 'corrective_action') {
    const c = await one(tx, 'SELECT id, number, title, facility_id, owner_user_id, source, status FROM corrective_action WHERE id = $1', [id]);
    if (!c) throw notFound('corrective action');
    return { ...c, link: `/quality/capa/${id}`, closed: ['closed', 'cancelled'].includes(c.status) };
  }
  if (type === 'quality_audit') {
    const a = await one(tx, 'SELECT id, number, title, facility_id, status, lead_auditor_id, auditee_user_id FROM quality_audit WHERE id = $1', [id]);
    if (!a) throw notFound('audit');
    return { ...a, owner_user_id: a.auditee_user_id, source: 'audit', link: `/quality/audits/${id}`, closed: ['closed', 'cancelled'].includes(a.status) };
  }
  const i = await one(tx, 'SELECT id, number, kind AS title, facility_id, status FROM safety_incident WHERE id = $1', [id]);
  if (!i) throw notFound('incident');
  return { ...i, owner_user_id: null, source: 'incident', link: `/safety/${id}`, closed: i.status === 'closed' };
}

const canPlanActions = (actor: Actor, type: Subject, s: any) =>
  type === 'corrective_action' ? s.owner_user_id === actor.userId || capaManager(actor, s)
    : type === 'quality_audit' ? can(actor, 'quality.manage', s.facility_id) || s.auditee_user_id === actor.userId || s.lead_auditor_id === actor.userId
      : can(actor, 'safety.manage', s.facility_id);

export async function addAction(tx: Tx, actor: Actor, input: { subjectType: Subject; subjectId: string; title: string; ownerUserId: string; dueDate: string; auditItemId?: string | null }) {
  const s = await subjectOf(tx, input.subjectType, input.subjectId);
  if (!canPlanActions(actor, input.subjectType, s)) throw forbidden(input.subjectType === 'corrective_action' ? 'quality.manage (or own the corrective action)' : 'safety.manage');
  if (s.closed) throw conflict(`${s.number} is ${s.status}`);
  if (!input.title?.trim()) throw invalid('describe the action');
  if (!input.dueDate) throw invalid('every action needs a due date');
  await assertAssignable(tx, input.ownerUserId, s.facility_id);
  if (input.auditItemId && (input.subjectType !== 'quality_audit' || !(await one(tx, 'SELECT 1 FROM audit_item WHERE id = $1 AND audit_id = $2', [input.auditItemId, input.subjectId])))) {
    throw invalid('the checklist item belongs to another audit');
  }
  const a = await one(tx, `INSERT INTO action_item (tenant_id, facility_id, subject_type, subject_id, title, owner_user_id, due_date, created_by, audit_item_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
    [actor.tenantId, s.facility_id, input.subjectType, input.subjectId, input.title.trim(), input.ownerUserId, input.dueDate, actor.userId, input.auditItemId ?? null]);
  await notify(tx, actor.tenantId, [input.ownerUserId], { kind: 'action.assigned', title: `Action for ${s.number}: ${a.title}`, body: `Due ${input.dueDate}`,
    link: s.link, subjectType: input.subjectType, subjectId: input.subjectId, dedupeKey: `action:${a.id}` }, actor.userId);
  await audit(tx, actor, { action: 'action.added', entityType: input.subjectType, entityId: input.subjectId, facilityId: s.facility_id, data: { actionId: a.id, title: a.title, owner: input.ownerUserId, due: input.dueDate } });
  return a;
}

/** Marks an action done (its owner, or whoever plans the subject's actions), with what was done as evidence. */
export async function completeAction(tx: Tx, actor: Actor, id: string, note: string) {
  const a = await one(tx, 'SELECT * FROM action_item WHERE id = $1 FOR UPDATE', [id]);
  if (!a) throw notFound('action');
  const s = await subjectOf(tx, a.subject_type, a.subject_id);
  if (a.owner_user_id !== actor.userId && !canPlanActions(actor, a.subject_type, s)) throw forbidden('be the action owner');
  if (a.status !== 'open') throw conflict(`action is ${a.status}`);
  if (!note?.trim()) throw invalid('say what was done');
  await tx.query(`UPDATE action_item SET status = 'done', completion_note = $2, completed_by = $3, completed_at = now() WHERE id = $1`, [id, note.trim(), actor.userId]);
  await audit(tx, actor, { action: 'action.completed', entityType: a.subject_type, entityId: a.subject_id, facilityId: a.facility_id, data: { actionId: id, note } });
}

export async function cancelAction(tx: Tx, actor: Actor, id: string, reason: string) {
  const a = await one(tx, 'SELECT * FROM action_item WHERE id = $1 FOR UPDATE', [id]);
  if (!a) throw notFound('action');
  const s = await subjectOf(tx, a.subject_type, a.subject_id);
  if (!canPlanActions(actor, a.subject_type, s)) throw forbidden('quality.manage');
  if (a.status !== 'open') throw conflict(`action is ${a.status}`);
  if (!reason?.trim()) throw invalid('a reason is required');
  await tx.query(`UPDATE action_item SET status = 'cancelled', completion_note = $2, completed_by = $3, completed_at = now() WHERE id = $1`, [id, reason, actor.userId]);
  await audit(tx, actor, { action: 'action.cancelled', entityType: a.subject_type, entityId: a.subject_id, facilityId: a.facility_id, data: { actionId: id, reason } });
}

export async function listActions(tx: Tx, type: Subject, id: string) {
  return many(tx, `SELECT a.id, a.title, a.owner_user_id, u.display_name AS owner_name, a.due_date, a.status, a.completion_note, a.completed_at, cu.display_name AS completed_by_name, a.audit_item_id,
      (a.status = 'open' AND a.due_date < current_date) AS overdue
    FROM action_item a JOIN app_user u ON u.id = a.owner_user_id LEFT JOIN app_user cu ON cu.id = a.completed_by WHERE a.subject_type = $1 AND a.subject_id = $2 ORDER BY a.due_date, a.created_at`, [type, id]);
}

/** Open actions owned by the user, across corrective actions and incidents. */
export async function myActions(tx: Tx, actor: Actor) {
  return many(tx, `SELECT a.id, a.title, a.due_date, a.subject_type, a.subject_id, (a.due_date < current_date) AS overdue,
      coalesce(c.number, i.number, qa.number) AS subject_number, coalesce(c.title, i.kind, qa.title) AS subject_title
    FROM action_item a LEFT JOIN corrective_action c ON a.subject_type = 'corrective_action' AND c.id = a.subject_id
    LEFT JOIN safety_incident i ON a.subject_type = 'safety_incident' AND i.id = a.subject_id
    LEFT JOIN quality_audit qa ON a.subject_type = 'quality_audit' AND qa.id = a.subject_id
    WHERE a.owner_user_id = $1 AND a.status = 'open' ORDER BY a.due_date`, [actor.userId]);
}
