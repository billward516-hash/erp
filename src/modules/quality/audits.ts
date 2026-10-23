import type { Actor } from '../../platform/auth/actor.js';
import { can, requirePermission } from '../../platform/auth/actor.js';
import { audit } from '../../platform/audit/audit.js';
import type { Tx } from '../../platform/db/tx.js';
import { many, nextSequence, one } from '../../platform/db/tx.js';
import { conflict, forbidden, invalid, notFound } from '../../platform/errors.js';
import { notify } from '../../platform/notify/notify.js';
import { createCapa, listActions } from './service.js';

const AUDIT = 'quality_audit';
const FINDINGS = ['minor_nc', 'major_nc'];

async function lockAudit(tx: Tx, id: string) {
  const a = await one(tx, 'SELECT * FROM quality_audit WHERE id = $1 FOR UPDATE', [id]);
  if (!a) throw notFound('audit');
  return a;
}
// Auditors do not audit their own work (ISO 9001 9.2.2 c): the auditee cannot record results even as a quality manager (D-161).
const isAuditor = (actor: Actor, a: any) => a.auditee_user_id !== actor.userId && (a.lead_auditor_id === actor.userId || can(actor, 'quality.manage', a.facility_id));

/**
 * Plans an audit with its checklist. The lead auditor cannot be the owner of the audited area (auditors do not
 * audit their own work); this is checked in the database too.
 */
export async function createAudit(tx: Tx, actor: Actor, input: { facilityId: string; title: string; scope: string; kind?: 'internal' | 'supplier' | 'customer' | 'certification';
  supplierId?: string | null; plannedOn: string; leadAuditorId: string; auditeeUserId?: string | null; items: string[] }) {
  requirePermission(actor, 'quality.manage', input.facilityId);
  if (!input.title?.trim() || !input.scope?.trim()) throw invalid('a title and the scope are required');
  if (input.auditeeUserId && input.auditeeUserId === input.leadAuditorId) throw invalid('the lead auditor cannot audit their own area');
  if (input.kind === 'supplier' && !input.supplierId) throw invalid('choose the supplier being audited');
  const items = input.items.map((x) => x.trim()).filter(Boolean);
  if (!items.length) throw invalid('add at least one checklist item');
  const number = `AUD-${String(await nextSequence(tx, actor.tenantId, 'audit')).padStart(5, '0')}`;
  const a = await one(tx, `INSERT INTO quality_audit (tenant_id, facility_id, number, title, scope, kind, supplier_id, planned_on, lead_auditor_id, auditee_user_id, created_by)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
  [actor.tenantId, input.facilityId, number, input.title.trim(), input.scope.trim(), input.kind ?? 'internal', input.supplierId ?? null, input.plannedOn, input.leadAuditorId, input.auditeeUserId ?? null, actor.userId]);
  for (const [i, text] of items.entries()) await tx.query('INSERT INTO audit_item (tenant_id, audit_id, seq, requirement) VALUES ($1, $2, $3, $4)', [actor.tenantId, a.id, i + 1, text]);
  await notify(tx, actor.tenantId, [input.leadAuditorId, input.auditeeUserId], { kind: 'quality.audit_planned', title: `${number} planned for ${input.plannedOn}: ${a.title}`,
    link: `/quality/audits/${a.id}`, subjectType: AUDIT, subjectId: a.id, dedupeKey: `audit-planned:${a.id}` }, actor.userId);
  await audit(tx, actor, { action: 'audit.planned', entityType: AUDIT, entityId: a.id, facilityId: a.facility_id, data: { number, items: items.length } });
  return a;
}

export async function startAudit(tx: Tx, actor: Actor, id: string) {
  const a = await lockAudit(tx, id);
  if (!isAuditor(actor, a)) throw forbidden('be the lead auditor');
  if (a.status !== 'planned') throw conflict(`audit is ${a.status}`);
  await tx.query(`UPDATE quality_audit SET status = 'in_progress', started_at = now() WHERE id = $1`, [id]);
  await audit(tx, actor, { action: 'audit.started', entityType: AUDIT, entityId: id, facilityId: a.facility_id, data: {} });
}

/** Records the result of one checklist item; findings and observations need the objective evidence. */
export async function recordItem(tx: Tx, actor: Actor, itemId: string, input: { result: 'conforming' | 'observation' | 'minor_nc' | 'major_nc' | 'not_applicable'; evidence?: string | null }) {
  const it = await one(tx, 'SELECT * FROM audit_item WHERE id = $1 FOR UPDATE', [itemId]);
  if (!it) throw notFound('checklist item');
  const a = await lockAudit(tx, it.audit_id);
  if (!isAuditor(actor, a)) throw forbidden('be the lead auditor');
  if (a.status !== 'in_progress') throw conflict(a.status === 'planned' ? 'start the audit first' : `audit is ${a.status}`);
  if (input.result !== 'conforming' && input.result !== 'not_applicable' && (input.evidence?.trim().length ?? 0) < 10) throw invalid('record the objective evidence for a finding or observation');
  await tx.query('UPDATE audit_item SET result = $2, evidence = $3 WHERE id = $1', [itemId, input.result, input.evidence?.trim() || null]);
}

export async function addItem(tx: Tx, actor: Actor, auditId: string, requirement: string) {
  const a = await lockAudit(tx, auditId);
  if (!isAuditor(actor, a)) throw forbidden('be the lead auditor');
  if (!['planned', 'in_progress'].includes(a.status)) throw conflict(`audit is ${a.status}`);
  if (!requirement?.trim()) throw invalid('describe what is checked');
  const n = Number((await one(tx, 'SELECT coalesce(max(seq), 0) + 1 AS n FROM audit_item WHERE audit_id = $1', [auditId])).n);
  await tx.query('INSERT INTO audit_item (tenant_id, audit_id, seq, requirement) VALUES ($1, $2, $3, $4)', [actor.tenantId, auditId, n, requirement.trim()]);
}

/** Issues the audit report once every item has a result; the auditee is told how many findings to answer. */
export async function reportAudit(tx: Tx, actor: Actor, id: string, summary: string) {
  const a = await lockAudit(tx, id);
  if (!isAuditor(actor, a)) throw forbidden('be the lead auditor');
  if (a.status !== 'in_progress') throw conflict(`audit is ${a.status}`);
  const items = await many(tx, 'SELECT seq, result FROM audit_item WHERE audit_id = $1', [id]);
  const missing = items.filter((x) => !x.result);
  if (missing.length) throw invalid(`record a result for item${missing.length === 1 ? '' : 's'} ${missing.map((x) => x.seq).join(', ')}`);
  if (!summary?.trim()) throw invalid('write the audit summary');
  const findings = items.filter((x) => FINDINGS.includes(x.result)).length;
  await tx.query(`UPDATE quality_audit SET status = 'reported', summary = $2, reported_at = now() WHERE id = $1`, [id, summary.trim()]);
  if (a.auditee_user_id) {
    await notify(tx, actor.tenantId, [a.auditee_user_id], { kind: 'quality.audit_reported', title: `${a.number} report: ${findings ? `${findings} finding${findings === 1 ? '' : 's'} to answer` : 'no findings'}`,
      link: `/quality/audits/${id}`, subjectType: AUDIT, subjectId: id, dedupeKey: `audit-report:${id}` }, actor.userId);
  }
  await audit(tx, actor, { action: 'audit.reported', entityType: AUDIT, entityId: id, facilityId: a.facility_id, data: { findings } });
  return { findings };
}

/** A finding answered with a corrective action (owned by the auditee unless someone else is named). */
export async function capaForFinding(tx: Tx, actor: Actor, itemId: string, input: { ownerUserId?: string | null; dueDate?: string | null }) {
  const it = await one(tx, 'SELECT * FROM audit_item WHERE id = $1 FOR UPDATE', [itemId]);
  if (!it) throw notFound('checklist item');
  const a = await lockAudit(tx, it.audit_id);
  requirePermission(actor, 'quality.manage', a.facility_id);
  if (!FINDINGS.includes(it.result)) throw invalid('only nonconformities need a corrective action');
  if (it.capa_id) throw conflict('this finding already has a corrective action');
  if (a.status !== 'reported') throw conflict('issue the audit report first');
  const owner = input.ownerUserId ?? a.auditee_user_id;
  if (!owner) throw invalid('name the owner');
  const c = await createCapa(tx, actor, { facilityId: a.facility_id, source: 'audit', priority: it.result === 'major_nc' ? 'high' : 'medium', ownerUserId: owner, dueDate: input.dueDate ?? null,
    title: `${a.number} finding ${it.seq}: ${it.requirement.slice(0, 120)}`, problem: `${it.result === 'major_nc' ? 'Major' : 'Minor'} nonconformity found in ${a.number} (${a.scope}).\nEvidence: ${it.evidence}` });
  await tx.query('UPDATE audit_item SET capa_id = $2 WHERE id = $1', [itemId, c.id]);
  return c;
}

/** Closes a reported audit once every nonconformity has a corrective action or at least one action. */
export async function closeAudit(tx: Tx, actor: Actor, id: string) {
  const a = await lockAudit(tx, id);
  requirePermission(actor, 'quality.manage', a.facility_id);
  if (a.status !== 'reported') throw conflict(a.status === 'closed' ? 'already closed' : 'issue the audit report first');
  const open = await many(tx, `SELECT i.seq FROM audit_item i WHERE i.audit_id = $1 AND i.result IN ('minor_nc', 'major_nc') AND i.capa_id IS NULL
    AND NOT EXISTS (SELECT 1 FROM action_item x WHERE x.audit_item_id = i.id AND x.status <> 'cancelled')`, [id]);
  if (open.length) throw invalid(`answer finding${open.length === 1 ? '' : 's'} ${open.map((x) => x.seq).join(', ')} with a corrective action or an action first`);
  await tx.query(`UPDATE quality_audit SET status = 'closed', closed_at = now() WHERE id = $1`, [id]);
  await audit(tx, actor, { action: 'audit.closed', entityType: AUDIT, entityId: id, facilityId: a.facility_id, data: {} });
}

export async function getAudit(tx: Tx, actor: Actor, id: string) {
  const a = await one(tx, `SELECT a.*, f.code AS facility_code, lu.display_name AS lead_auditor_name, au.display_name AS auditee_name, s.name AS supplier_name
    FROM quality_audit a JOIN facility f ON f.id = a.facility_id JOIN app_user lu ON lu.id = a.lead_auditor_id LEFT JOIN app_user au ON au.id = a.auditee_user_id
    LEFT JOIN supplier s ON s.id = a.supplier_id WHERE a.id = $1`, [id]);
  if (!a) throw notFound('audit');
  if (!can(actor, 'quality.view', a.facility_id) && a.lead_auditor_id !== actor.userId && a.auditee_user_id !== actor.userId) throw forbidden('quality.view');
  const items = await many(tx, `SELECT i.*, c.number AS capa_number, c.status AS capa_status,
      (SELECT count(*)::int FROM action_item x WHERE x.audit_item_id = i.id AND x.status <> 'cancelled') AS actions
    FROM audit_item i LEFT JOIN corrective_action c ON c.id = i.capa_id WHERE i.audit_id = $1 ORDER BY i.seq`, [id]);
  const actions = await listActions(tx, 'quality_audit', id);
  return { ...a, items, actions, isAuditor: isAuditor(actor, a), canManage: can(actor, 'quality.manage', a.facility_id),
    findings: items.filter((i) => FINDINGS.includes(i.result)).length, observations: items.filter((i) => i.result === 'observation').length };
}

export async function listAudits(tx: Tx, actor: Actor, q: { open?: boolean } = {}) {
  const rows = await many(tx, `SELECT a.id, a.number, a.title, a.kind, a.status, a.planned_on, a.facility_id, a.lead_auditor_id, a.auditee_user_id, f.code AS facility_code,
      lu.display_name AS lead_auditor_name, s.name AS supplier_name,
      (SELECT count(*)::int FROM audit_item i WHERE i.audit_id = a.id AND i.result IN ('minor_nc', 'major_nc')) AS findings,
      (a.status = 'planned' AND a.planned_on < current_date) AS overdue
    FROM quality_audit a JOIN facility f ON f.id = a.facility_id JOIN app_user lu ON lu.id = a.lead_auditor_id LEFT JOIN supplier s ON s.id = a.supplier_id
    WHERE (NOT $1 OR a.status NOT IN ('closed', 'cancelled')) ORDER BY a.planned_on DESC LIMIT 300`, [q.open ?? false]);
  return rows.filter((r) => can(actor, 'quality.view', r.facility_id) || r.lead_auditor_id === actor.userId || r.auditee_user_id === actor.userId);
}
