import type { Actor } from '../../platform/auth/actor.js';
import { can, requirePermission } from '../../platform/auth/actor.js';
import { audit } from '../../platform/audit/audit.js';
import type { Tx } from '../../platform/db/tx.js';
import { many, nextSequence, one } from '../../platform/db/tx.js';
import { conflict, forbidden, invalid, notFound } from '../../platform/errors.js';
import { notify, usersWithPermission } from '../../platform/notify/notify.js';
import { listActions } from '../quality/service.js';

const INC = 'safety_incident';
type Kind = 'near_miss' | 'first_aid' | 'injury' | 'illness' | 'property_damage' | 'environmental';
const PEOPLE: Kind[] = ['first_aid', 'injury', 'illness'];
const KIND_LABEL: Record<string, string> = { near_miss: 'Near miss', first_aid: 'First aid', injury: 'Injury', illness: 'Illness', property_damage: 'Property damage', environmental: 'Environmental' };

/**
 * Anyone with safety.report can report what happened, including near misses. Names and injury details of the
 * people involved are private: only safety staff (safety.manage) see them. Safety staff at the facility are
 * told at once; injuries and illnesses also go to managers who can see incidents there.
 */
export async function reportIncident(tx: Tx, actor: Actor, input: { facilityId: string; kind: Kind; occurredAt: Date; location?: string | null; assetId?: string | null;
  description: string; immediateActions?: string | null; involvedEmployeeId?: string | null; injuryDescription?: string | null }) {
  requirePermission(actor, 'safety.report', input.facilityId);
  if (!input.description?.trim()) throw invalid('describe what happened');
  if (input.occurredAt.getTime() > Date.now() + 5 * 60_000) throw invalid('the time cannot be in the future');
  if (input.assetId) {
    const a = await one(tx, 'SELECT facility_id FROM asset WHERE id = $1', [input.assetId]);
    if (!a || a.facility_id !== input.facilityId) throw invalid('equipment must be at the same facility');
  }
  if (input.involvedEmployeeId && !(await one(tx, 'SELECT 1 FROM employee WHERE id = $1', [input.involvedEmployeeId]))) throw invalid('employee not found');
  const number = `INC-${String(await nextSequence(tx, actor.tenantId, 'incident')).padStart(6, '0')}`;
  const i = await one(tx, `INSERT INTO safety_incident (tenant_id, facility_id, number, kind, occurred_at, location, asset_id, description, immediate_actions, involved_employee_id, injury_description, reported_by)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *`,
  [actor.tenantId, input.facilityId, number, input.kind, input.occurredAt, input.location ?? null, input.assetId ?? null, input.description.trim(), input.immediateActions ?? null,
    input.involvedEmployeeId ?? null, input.injuryDescription ?? null, actor.userId]);
  const people = PEOPLE.includes(input.kind) && input.kind !== 'first_aid';
  const to = new Set([...(await usersWithPermission(tx, 'safety.manage', input.facilityId)), ...(people ? await usersWithPermission(tx, 'safety.view', input.facilityId) : [])]);
  // The notice never carries private details: kind, place and number only.
  await notify(tx, actor.tenantId, [...to], { kind: 'safety.incident_reported', title: `${number} ${KIND_LABEL[input.kind]} reported${input.location ? ` at ${input.location}` : ''}`,
    link: `/safety/${i.id}`, subjectType: INC, subjectId: i.id, dedupeKey: `incident:${i.id}` }, actor.userId);
  await audit(tx, actor, { action: 'incident.reported', entityType: INC, entityId: i.id, facilityId: i.facility_id, data: { number, kind: input.kind } });
  return { id: i.id as string, number };
}

async function lockIncident(tx: Tx, id: string) {
  const i = await one(tx, 'SELECT * FROM safety_incident WHERE id = $1 FOR UPDATE', [id]);
  if (!i) throw notFound('incident');
  return i;
}

/**
 * Safety staff classify the incident: severity, corrected kind, the people involved and whether it is
 * recordable. Recordability is a person's determination against the applicable rules; the platform does not
 * compute it, but asks for it on injuries and illnesses before they close.
 */
export async function classifyIncident(tx: Tx, actor: Actor, id: string, input: { severity: 'low' | 'medium' | 'high' | 'serious'; kind?: Kind; involvedEmployeeId?: string | null;
  injuryDescription?: string | null; medicalTreatment?: boolean | null; daysAway?: number | null; daysRestricted?: number | null; recordable?: boolean | null }) {
  const i = await lockIncident(tx, id);
  requirePermission(actor, 'safety.manage', i.facility_id);
  if (i.status === 'closed') throw conflict('incident is closed');
  if ((input.daysAway ?? 0) > 0 || (input.daysRestricted ?? 0) > 0) {
    if (input.recordable === false) throw invalid('days away or on restricted duty make a work-related case recordable; record it as recordable or correct the days');
  }
  if (input.involvedEmployeeId && !(await one(tx, 'SELECT 1 FROM employee WHERE id = $1', [input.involvedEmployeeId]))) throw invalid('the involved employee was not found');
  await tx.query(`UPDATE safety_incident SET severity = $2, kind = coalesce($3, kind), involved_employee_id = CASE WHEN $4 THEN $5::uuid ELSE involved_employee_id END,
      injury_description = coalesce($6, injury_description), medical_treatment = coalesce($7, medical_treatment), days_away = coalesce($8, days_away),
      days_restricted = coalesce($9, days_restricted), recordable = coalesce($10, recordable), classified_by = $11,
      status = CASE WHEN status = 'reported' THEN 'investigating' ELSE status END WHERE id = $1`,
  [id, input.severity, input.kind ?? null, input.involvedEmployeeId !== undefined, input.involvedEmployeeId ?? null, input.injuryDescription ?? null, input.medicalTreatment ?? null,
    input.daysAway ?? null, input.daysRestricted ?? null, input.recordable ?? null, actor.userId]);
  await audit(tx, actor, { action: 'incident.classified', entityType: INC, entityId: id, facilityId: i.facility_id,
    data: { severity: input.severity, kind: input.kind ?? i.kind, recordable: input.recordable ?? null, daysAway: input.daysAway ?? null, daysRestricted: input.daysRestricted ?? null } });
}

export async function investigateIncident(tx: Tx, actor: Actor, id: string, input: { rootCause: string; contributingFactors?: string | null }) {
  const i = await lockIncident(tx, id);
  requirePermission(actor, 'safety.manage', i.facility_id);
  if (i.status === 'closed') throw conflict('incident is closed');
  if (!i.severity) throw invalid('classify the incident first');
  if (!input.rootCause?.trim()) throw invalid('state the root cause');
  await tx.query(`UPDATE safety_incident SET root_cause = $2, contributing_factors = $3, status = 'actions' WHERE id = $1`, [id, input.rootCause.trim(), input.contributingFactors ?? null]);
  await audit(tx, actor, { action: 'incident.investigated', entityType: INC, entityId: id, facilityId: i.facility_id, data: { rootCause: input.rootCause } });
}

/**
 * Closes the incident once its actions are finished. Injuries and illnesses need the recordability decision;
 * anything other than a low-severity near miss or first aid needs a root cause.
 */
export async function closeIncident(tx: Tx, actor: Actor, id: string) {
  const i = await lockIncident(tx, id);
  requirePermission(actor, 'safety.manage', i.facility_id);
  if (i.status === 'closed') throw conflict('incident is already closed');
  if (!i.severity) throw invalid('classify the incident first');
  if (['injury', 'illness'].includes(i.kind) && i.recordable == null) throw invalid('decide whether the case is recordable before closing');
  const minor = ['near_miss', 'first_aid'].includes(i.kind) && i.severity === 'low';
  if (!minor && !i.root_cause) throw invalid('record the root cause before closing');
  if (await one(tx, `SELECT 1 FROM action_item WHERE subject_type = 'safety_incident' AND subject_id = $1 AND status = 'open'`, [id])) throw invalid('finish or cancel the open actions first');
  await tx.query(`UPDATE safety_incident SET status = 'closed', closed_by = $2, closed_at = now() WHERE id = $1`, [id, actor.userId]);
  await audit(tx, actor, { action: 'incident.closed', entityType: INC, entityId: id, facilityId: i.facility_id, data: {} });
}

/** Removes private fields unless the reader is safety staff. */
function redact(i: any, actor: Actor) {
  if (can(actor, 'safety.manage', i.facility_id)) return { ...i, restricted: false };
  const { involved_employee_id: _a, involved_name: _b, injury_description: _c, medical_treatment: _d, days_away: _e, days_restricted: _f, ...rest } = i;
  return { ...rest, restricted: true };
}

export async function getIncident(tx: Tx, actor: Actor, id: string) {
  const i = await one(tx, `SELECT i.*, f.code AS facility_code, a.asset_tag, a.name AS asset_name, e.first_name || ' ' || e.last_name AS involved_name,
      ru.display_name AS reported_by_name, ca.number AS capa_number, ca.status AS capa_status
    FROM safety_incident i JOIN facility f ON f.id = i.facility_id LEFT JOIN asset a ON a.id = i.asset_id LEFT JOIN employee e ON e.id = i.involved_employee_id
    JOIN app_user ru ON ru.id = i.reported_by LEFT JOIN corrective_action ca ON ca.id = i.capa_id WHERE i.id = $1`, [id]);
  if (!i) throw notFound('incident');
  if (!can(actor, 'safety.view', i.facility_id) && i.reported_by !== actor.userId) throw forbidden('safety.view');
  const actions = await listActions(tx, 'safety_incident', id);
  const employees = can(actor, 'safety.manage', i.facility_id)
    ? await many(tx, `SELECT id, employee_number, first_name || ' ' || last_name AS name FROM employee WHERE status = 'active' AND (facility_id = $1 OR facility_id IS NULL) ORDER BY last_name`, [i.facility_id]) : [];
  return { ...redact(i, actor), actions, employees, canManage: can(actor, 'safety.manage', i.facility_id) };
}

/** Incidents at facilities the reader can see; people who can only report see their own reports. */
export async function listIncidents(tx: Tx, actor: Actor, q: { open?: boolean; kind?: string } = {}) {
  const rows = await many(tx, `SELECT i.id, i.number, i.kind, i.occurred_at, i.location, i.status, i.severity, i.recordable, i.facility_id, i.reported_by, f.code AS facility_code, a.asset_tag,
      (SELECT count(*)::int FROM action_item x WHERE x.subject_type = 'safety_incident' AND x.subject_id = i.id AND x.status = 'open') AS open_actions
    FROM safety_incident i JOIN facility f ON f.id = i.facility_id LEFT JOIN asset a ON a.id = i.asset_id
    WHERE (NOT $1 OR i.status <> 'closed') AND ($2::text IS NULL OR i.kind = $2) ORDER BY i.occurred_at DESC LIMIT 500`, [q.open ?? false, q.kind ?? null]);
  return rows.filter((r) => can(actor, 'safety.view', r.facility_id) || r.reported_by === actor.userId)
    .map((r) => (can(actor, 'safety.manage', r.facility_id) ? r : { ...r, recordable: undefined }));
}
