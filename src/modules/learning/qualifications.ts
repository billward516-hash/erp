import type { Actor } from '../../platform/auth/actor.js';
import { can, requirePermission } from '../../platform/auth/actor.js';
import { audit } from '../../platform/audit/audit.js';
import type { Tx } from '../../platform/db/tx.js';
import { many, nextSequence, one } from '../../platform/db/tx.js';
import { AppError, conflict, invalid, notFound } from '../../platform/errors.js';

export type QualStatus = 'active' | 'expired' | 'revoked' | 'not_held' | 'not_yet_effective';

export async function createQualification(
  tx: Tx, actor: Actor,
  input: { code: string; name: string; description?: string | null; validityMonths?: number | null; safetyCritical?: boolean; requiresPractical?: boolean; courseIds?: string[] },
) {
  requirePermission(actor, 'learning.manage');
  if (await one(tx, 'SELECT 1 FROM qualification WHERE code = $1', [input.code])) throw conflict(`qualification ${input.code} already exists`);
  const q = await one(
    tx,
    `INSERT INTO qualification (tenant_id, code, name, description, validity_months, safety_critical, requires_practical)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [actor.tenantId, input.code, input.name, input.description ?? null, input.validityMonths ?? null, input.safetyCritical ?? false, input.requiresPractical ?? false],
  );
  for (const courseId of input.courseIds ?? []) {
    if (!(await one(tx, 'SELECT 1 FROM course WHERE id = $1', [courseId]))) throw invalid(`course ${courseId} not found`);
    await tx.query('INSERT INTO qualification_course (tenant_id, qualification_id, course_id) VALUES ($1, $2, $3)', [actor.tenantId, q.id, courseId]);
  }
  await audit(tx, actor, { action: 'qualification.defined', entityType: 'qualification', entityId: q.id, data: { code: q.code, courseIds: input.courseIds ?? [] } });
  return q;
}

export async function listQualifications(tx: Tx, actor: Actor) {
  requirePermission(actor, 'qualifications.view');
  return many(
    tx,
    `SELECT q.*, coalesce((SELECT json_agg(json_build_object('id', c.id, 'code', c.code, 'title', c.title))
                           FROM qualification_course qc JOIN course c ON c.id = qc.course_id WHERE qc.qualification_id = q.id), '[]') AS courses,
            (SELECT count(*)::int FROM asset_qualification_requirement r WHERE r.qualification_id = q.id) AS required_by_assets
     FROM qualification q ORDER BY q.code`,
  );
}

export async function setAssetRequirement(tx: Tx, actor: Actor, assetId: string, qualificationId: string, scope: 'operate' | 'maintain', remove = false) {
  const a = await one(tx, 'SELECT id, facility_id, asset_tag FROM asset WHERE id = $1', [assetId]);
  if (!a) throw notFound('asset');
  requirePermission(actor, 'assets.manage', a.facility_id);
  if (!(await one(tx, 'SELECT 1 FROM qualification WHERE id = $1', [qualificationId]))) throw notFound('qualification');
  if (remove) await tx.query('DELETE FROM asset_qualification_requirement WHERE asset_id = $1 AND qualification_id = $2 AND scope = $3', [assetId, qualificationId, scope]);
  else await tx.query('INSERT INTO asset_qualification_requirement (tenant_id, asset_id, qualification_id, scope) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING', [actor.tenantId, assetId, qualificationId, scope]);
  await audit(tx, actor, { action: remove ? 'asset.requirement_removed' : 'asset.requirement_added', entityType: 'asset', entityId: assetId, facilityId: a.facility_id, data: { qualificationId, scope } });
}

/**
 * Status of one person's qualification on a date. The most recent non-revoked grant decides;
 * a revoked latest grant means revoked even if an older grant would still be in date.
 */
export async function qualificationStatus(tx: Tx, employeeId: string, qualificationId: string, asOf = new Date()) {
  const latest = await one(
    tx,
    `SELECT id, effective_on, expires_on, revoked_at, granted_at FROM employee_qualification
     WHERE employee_id = $1 AND qualification_id = $2 ORDER BY granted_at DESC LIMIT 1`,
    [employeeId, qualificationId],
  );
  const day = asOf.toISOString().slice(0, 10);
  let status: QualStatus = 'not_held';
  if (latest) {
    if (latest.revoked_at) status = 'revoked';
    else if (latest.effective_on > day) status = 'not_yet_effective';
    else if (latest.expires_on && latest.expires_on < day) status = 'expired';
    else status = 'active';
  }
  return { status, grant: latest ?? null };
}

/** Whether an employee currently meets every requirement of an asset for the given scope. */
export async function checkAssetQualification(tx: Tx, employeeId: string, assetId: string, scope: 'operate' | 'maintain', asOf = new Date()) {
  const reqs = await many(
    tx,
    `SELECT q.id, q.code, q.name FROM asset_qualification_requirement r JOIN qualification q ON q.id = r.qualification_id
     WHERE r.asset_id = $1 AND r.scope = $2`,
    [assetId, scope],
  );
  const missing: { code: string; name: string; status: QualStatus; expiredOn?: string | null }[] = [];
  for (const q of reqs) {
    const s = await qualificationStatus(tx, employeeId, q.id, asOf);
    if (s.status !== 'active') missing.push({ code: q.code, name: q.name, status: s.status, expiredOn: s.status === 'expired' ? s.grant?.expires_on : undefined });
  }
  return { ok: missing.length === 0, required: reqs.map((r) => r.code), missing };
}

/** Throws a 422 naming exactly which qualification is missing/expired/revoked. */
export async function assertAssetQualified(tx: Tx, employeeId: string, assetId: string, scope: 'operate' | 'maintain') {
  const r = await checkAssetQualification(tx, employeeId, assetId, scope);
  if (r.ok) return;
  const who = await one(tx, `SELECT first_name || ' ' || last_name AS name FROM employee WHERE id = $1`, [employeeId]);
  throw new AppError(422, 'not_qualified',
    `${who?.name ?? 'employee'} is not qualified to ${scope} this asset: ${r.missing.map((m) => `${m.code} (${m.status.replace(/_/g, ' ')})`).join(', ')}`,
    { employeeId, missing: r.missing });
}

/**
 * Evidence check before an authorizer may grant: every linked course completed (any published
 * version) and, when required, a passed practical evaluation signed by someone other than the learner.
 * Course completion alone never grants anything; this only tells the authorizer the record is complete.
 */
export async function eligibility(tx: Tx, employeeId: string, qualificationId: string) {
  const q = await one(tx, 'SELECT * FROM qualification WHERE id = $1', [qualificationId]);
  if (!q) throw notFound('qualification');
  const courses = await many(tx, 'SELECT c.id, c.code FROM qualification_course qc JOIN course c ON c.id = qc.course_id WHERE qc.qualification_id = $1', [qualificationId]);
  const reasons: string[] = [];
  const enrollments: string[] = [];
  for (const c of courses) {
    const done = await one(
      tx,
      `SELECT n.id FROM enrollment n JOIN course_version v ON v.id = n.course_version_id
       WHERE n.employee_id = $1 AND v.course_id = $2 AND n.status = 'completed' ORDER BY n.completed_at DESC LIMIT 1`,
      [employeeId, c.id],
    );
    if (done) enrollments.push(done.id); else reasons.push(`course ${c.code} not completed`);
  }
  let evaluation: any = null;
  if (q.requires_practical) {
    evaluation = await one(
      tx,
      `SELECT c.id, c.completed_at, u.display_name AS evaluator FROM event_completion c
       JOIN learning_event e ON e.id = c.learning_event_id JOIN enrollment n ON n.id = c.enrollment_id JOIN app_user u ON u.id = c.recorded_by
       WHERE n.employee_id = $1 AND e.kind = 'practical_evaluation' AND c.outcome = 'passed'
         AND (cardinality($2::uuid[]) = 0 OR n.id = ANY ($2))
       ORDER BY c.completed_at DESC LIMIT 1`,
      [employeeId, enrollments],
    );
    if (!evaluation) reasons.push('no passed practical evaluation on record');
  }
  return { eligible: reasons.length === 0, reasons, basis: { enrollments, practicalEvaluation: evaluation?.id ?? null, evaluator: evaluation?.evaluator ?? null } };
}

export function addMonths(day: string, months: number): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, m - 1 + months, 1));
  const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
  t.setUTCDate(Math.min(d, last));
  return t.toISOString().slice(0, 10);
}

/** Authorizes a qualification. Never self-granted; requires complete training evidence (see eligibility). */
export async function grantQualification(
  tx: Tx, actor: Actor, employeeId: string, qualificationId: string, input: { effectiveOn?: string; note?: string } = {},
) {
  const emp = await one(tx, `SELECT id, facility_id, status FROM employee WHERE id = $1`, [employeeId]);
  if (!emp) throw notFound('employee');
  requirePermission(actor, 'qualifications.grant', emp.facility_id);
  if (actor.employeeId === employeeId) throw invalid('you cannot authorize your own qualification');
  if (emp.status !== 'active') throw invalid('qualifications can only be granted to active employees');
  const q = await one(tx, 'SELECT * FROM qualification WHERE id = $1 AND active', [qualificationId]);
  if (!q) throw notFound('qualification');
  const e = await eligibility(tx, employeeId, qualificationId);
  if (!e.eligible) throw new AppError(422, 'not_eligible', `training record incomplete: ${e.reasons.join('; ')}`, e);
  const effective = input.effectiveOn ?? new Date().toISOString().slice(0, 10);
  const expires = q.validity_months ? addMonths(effective, q.validity_months) : null;
  const g = await one(
    tx,
    `INSERT INTO employee_qualification (tenant_id, employee_id, qualification_id, granted_by, effective_on, expires_on, basis)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [actor.tenantId, employeeId, qualificationId, actor.userId, effective, expires, { ...e.basis, note: input.note ?? null }],
  );
  await audit(tx, actor, { action: 'qualification.granted', entityType: 'employee', entityId: employeeId, facilityId: emp.facility_id,
    data: { grantId: g.id, qualification: q.code, effectiveOn: effective, expiresOn: expires, basis: e.basis } });
  return g;
}

export async function revokeQualification(tx: Tx, actor: Actor, grantId: string, reason: string) {
  const g = await one(tx, `SELECT g.*, e.facility_id, q.code FROM employee_qualification g JOIN employee e ON e.id = g.employee_id
                           JOIN qualification q ON q.id = g.qualification_id WHERE g.id = $1 FOR UPDATE OF g`, [grantId]);
  if (!g) throw notFound('qualification grant');
  requirePermission(actor, 'qualifications.grant', g.facility_id);
  if (g.revoked_at) throw conflict('already revoked');
  if (!reason || reason.trim().length < 5) throw invalid('a revocation reason is required');
  await tx.query('UPDATE employee_qualification SET revoked_at = now(), revoked_by = $2, revoke_reason = $3 WHERE id = $1', [grantId, actor.userId, reason]);
  await audit(tx, actor, { action: 'qualification.revoked', entityType: 'employee', entityId: g.employee_id, facilityId: g.facility_id, data: { grantId, qualification: g.code, reason } });
}

/** Issues an internal certificate for an active grant. Does not represent external accreditation. */
export async function issueCertificate(tx: Tx, actor: Actor, grantId: string) {
  const g = await one(tx, `SELECT g.*, e.facility_id FROM employee_qualification g JOIN employee e ON e.id = g.employee_id WHERE g.id = $1`, [grantId]);
  if (!g) throw notFound('qualification grant');
  requirePermission(actor, 'qualifications.grant', g.facility_id);
  const s = await qualificationStatus(tx, g.employee_id, g.qualification_id);
  if (s.status !== 'active' || s.grant?.id !== grantId) throw invalid('certificates are issued only for the current, active grant');
  const existing = await one(tx, 'SELECT * FROM certificate WHERE employee_qualification_id = $1', [grantId]);
  if (existing) return existing;
  const year = new Date().getUTCFullYear();
  const number = `CERT-${year}-${String(await nextSequence(tx, actor.tenantId, `certificate-${year}`)).padStart(5, '0')}`;
  const c = await one(tx, `INSERT INTO certificate (tenant_id, employee_qualification_id, number, issued_by) VALUES ($1, $2, $3, $4) RETURNING *`,
    [actor.tenantId, grantId, number, actor.userId]);
  await audit(tx, actor, { action: 'certificate.issued', entityType: 'employee', entityId: g.employee_id, facilityId: g.facility_id, data: { grantId, number } });
  return c;
}

export async function certificateData(tx: Tx, actor: Actor, certificateId: string) {
  const c = await one(
    tx,
    `SELECT c.number, c.issued_at, iu.display_name AS issued_by, gu.display_name AS authorized_by, g.effective_on, g.expires_on, g.revoked_at, g.employee_id,
            e.first_name || ' ' || e.last_name AS employee, e.employee_number, e.facility_id, q.code, q.name AS qualification,
            t.name AS company, f.name AS facility
     FROM certificate c JOIN employee_qualification g ON g.id = c.employee_qualification_id JOIN employee e ON e.id = g.employee_id
     JOIN qualification q ON q.id = g.qualification_id JOIN app_user iu ON iu.id = c.issued_by JOIN app_user gu ON gu.id = g.granted_by
     JOIN tenant t ON t.id = c.tenant_id
     LEFT JOIN facility f ON f.id = e.facility_id WHERE c.id = $1`,
    [certificateId],
  );
  if (!c) throw notFound('certificate');
  if (actor.employeeId !== c.employee_id && !can(actor, 'qualifications.view', c.facility_id)) throw notFound('certificate');
  return c;
}

/** Every qualification for one employee with current status, plus external credentials. */
export async function employeeQualifications(tx: Tx, actor: Actor, employeeId: string) {
  const emp = await one(tx, `SELECT id, facility_id, first_name || ' ' || last_name AS name FROM employee WHERE id = $1`, [employeeId]);
  if (!emp) throw notFound('employee');
  if (actor.employeeId !== employeeId) requirePermission(actor, 'qualifications.view', emp.facility_id);
  const quals = await many(tx, 'SELECT id, code, name, safety_critical FROM qualification ORDER BY code');
  const out = [];
  for (const q of quals) {
    const s = await qualificationStatus(tx, employeeId, q.id);
    if (s.status === 'not_held') continue;
    const cert = s.grant ? await one(tx, 'SELECT id, number FROM certificate WHERE employee_qualification_id = $1', [s.grant.id]) : null;
    out.push({ ...q, status: s.status, grantId: s.grant?.id, effectiveOn: s.grant?.effective_on, expiresOn: s.grant?.expires_on ?? null, certificate: cert ?? null });
  }
  const external = await many(tx, 'SELECT id, name, issuer, credential_no, issued_on, expires_on FROM external_credential WHERE employee_id = $1 ORDER BY name', [employeeId]);
  return { employee: emp, qualifications: out, externalCredentials: external };
}

export async function recordExternalCredential(
  tx: Tx, actor: Actor, employeeId: string,
  input: { name: string; issuer: string; credentialNo?: string | null; issuedOn?: string | null; expiresOn?: string | null },
) {
  const emp = await one(tx, 'SELECT id, facility_id FROM employee WHERE id = $1', [employeeId]);
  if (!emp) throw notFound('employee');
  requirePermission(actor, 'learning.view_records', emp.facility_id);
  const row = await one(
    tx,
    `INSERT INTO external_credential (tenant_id, employee_id, name, issuer, credential_no, issued_on, expires_on, recorded_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
    [actor.tenantId, employeeId, input.name, input.issuer, input.credentialNo ?? null, input.issuedOn ?? null, input.expiresOn ?? null, actor.userId],
  );
  await audit(tx, actor, { action: 'credential.recorded', entityType: 'employee', entityId: employeeId, facilityId: emp.facility_id, data: { name: input.name, issuer: input.issuer } });
  return row;
}
