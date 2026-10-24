import type { Actor } from '../../platform/auth/actor.js';
import { can, requirePermission } from '../../platform/auth/actor.js';
import { audit } from '../../platform/audit/audit.js';
import type { Tx } from '../../platform/db/tx.js';
import { many, one } from '../../platform/db/tx.js';
import { conflict, invalid, notFound } from '../../platform/errors.js';

export interface AnalyteInput { name: string; unit: string; specLow?: number | null; specHigh?: number | null }
export interface MethodInput {
  facilityId: string; code: string; name: string; description?: string | null; documentId?: string | null; requiredQualificationId?: string | null;
  requiredInstrumentClass?: string | null; analytes: AnalyteInput[];
}

function cleanAnalytes(list: AnalyteInput[]) {
  if (!list?.length) throw invalid('a method needs at least one analyte');
  const seen = new Set<string>();
  return list.map((a, i) => {
    const name = a.name?.trim(), unit = a.unit?.trim();
    if (!name) throw invalid(`analyte ${i + 1}: name it`);
    if (!unit) throw invalid(`${name}: give the unit`);
    if (seen.has(name.toLowerCase())) throw invalid(`${name} is listed twice`);
    seen.add(name.toLowerCase());
    const low = a.specLow ?? null, high = a.specHigh ?? null;
    if ((low != null && !Number.isFinite(low)) || (high != null && !Number.isFinite(high))) throw invalid(`${name}: limits must be numbers`);
    if (low != null && high != null && low > high) throw invalid(`${name}: the low limit is above the high limit`);
    return { name, unit, low, high };
  });
}

async function insertVersion(tx: Tx, actor: Actor, input: MethodInput, version: number) {
  requirePermission(actor, 'lab.manage', input.facilityId);
  const code = input.code?.trim();
  if (!code) throw invalid('give the method a code');
  if (!input.name?.trim() || input.name.trim().length < 2) throw invalid('name the method');
  const analytes = cleanAnalytes(input.analytes);
  let docVersion: string | null = null;
  if (input.documentId) {
    const d = await one(tx, 'SELECT id, current_version_id FROM document WHERE id = $1', [input.documentId]);
    if (!d) throw invalid('the controlled document was not found');
    docVersion = d.current_version_id ?? null;
  }
  if (input.requiredQualificationId && !(await one(tx, 'SELECT 1 FROM qualification WHERE id = $1', [input.requiredQualificationId]))) throw invalid('the required qualification was not found');
  const m = await one(tx, `INSERT INTO lab_method (tenant_id, facility_id, code, version, name, description, document_id, document_version_id, required_qualification_id, required_instrument_class, created_by)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
  [actor.tenantId, input.facilityId, code, version, input.name.trim(), input.description?.trim() || null, input.documentId ?? null, docVersion, input.requiredQualificationId ?? null,
    input.requiredInstrumentClass?.trim() || null, actor.userId]);
  let seq = 1;
  for (const a of analytes) {
    await tx.query('INSERT INTO lab_method_analyte (tenant_id, method_id, seq, name, unit, spec_low, spec_high) VALUES ($1, $2, $3, $4, $5, $6, $7)', [actor.tenantId, m.id, seq++, a.name, a.unit, a.low, a.high]);
  }
  await audit(tx, actor, { action: 'lab.method_saved', entityType: 'lab_method', entityId: m.id, facilityId: m.facility_id,
    data: { code, version, analytes: analytes.map((a) => ({ name: a.name, unit: a.unit, low: a.low, high: a.high })), documentId: input.documentId ?? null, qualificationId: input.requiredQualificationId ?? null, instrumentClass: m.required_instrument_class } });
  return m;
}

export async function createMethod(tx: Tx, actor: Actor, input: MethodInput) {
  requirePermission(actor, 'lab.manage', input.facilityId);
  if (await one(tx, 'SELECT 1 FROM lab_method WHERE facility_id = $1 AND lower(code) = lower($2)', [input.facilityId, input.code?.trim() ?? ''])) {
    throw conflict(`method ${input.code} already exists at this site; revise it to save a new version`);
  }
  return insertVersion(tx, actor, input, 1);
}

/** A change to what a method measures or its limits is a new version; earlier versions stay for the tests that used them and stop being offered for new ones. */
export async function reviseMethod(tx: Tx, actor: Actor, id: string, input: Partial<Omit<MethodInput, 'facilityId' | 'code'>>) {
  const prior = await one(tx, 'SELECT * FROM lab_method WHERE id = $1 FOR UPDATE', [id]);
  if (!prior) throw notFound('method');
  requirePermission(actor, 'lab.manage', prior.facility_id);
  const latest = await one(tx, 'SELECT max(version)::int AS v FROM lab_method WHERE facility_id = $1 AND lower(code) = lower($2)', [prior.facility_id, prior.code]);
  if (prior.version !== latest!.v) throw conflict(`version ${latest!.v} of ${prior.code} is the current one; revise that`);
  const priorAnalytes = await many(tx, 'SELECT name, unit, spec_low::float AS "specLow", spec_high::float AS "specHigh" FROM lab_method_analyte WHERE method_id = $1 ORDER BY seq', [id]);
  const m = await insertVersion(tx, actor, {
    facilityId: prior.facility_id, code: prior.code, name: input.name ?? prior.name, description: input.description !== undefined ? input.description : prior.description,
    documentId: input.documentId !== undefined ? input.documentId : prior.document_id,
    requiredQualificationId: input.requiredQualificationId !== undefined ? input.requiredQualificationId : prior.required_qualification_id,
    requiredInstrumentClass: input.requiredInstrumentClass !== undefined ? input.requiredInstrumentClass : prior.required_instrument_class,
    analytes: input.analytes ?? priorAnalytes,
  }, prior.version + 1);
  await tx.query(`UPDATE lab_method SET status = 'retired', retired_at = now() WHERE id = $1`, [id]);
  return m;
}

export async function retireMethod(tx: Tx, actor: Actor, id: string) {
  const m = await one(tx, 'SELECT * FROM lab_method WHERE id = $1 FOR UPDATE', [id]);
  if (!m) throw notFound('method');
  requirePermission(actor, 'lab.manage', m.facility_id);
  if (m.status === 'retired') return;
  await tx.query(`UPDATE lab_method SET status = 'retired', retired_at = now() WHERE id = $1`, [id]);
  await audit(tx, actor, { action: 'lab.method_retired', entityType: 'lab_method', entityId: id, facilityId: m.facility_id, data: { code: m.code, version: m.version } });
}

const METHOD_SQL = `SELECT m.*, f.code AS facility_code, q.code AS qualification_code, q.name AS qualification_name, d.doc_number, d.title AS document_title, dv.version_label AS document_revision,
    (SELECT count(*)::int FROM lab_test t WHERE t.method_id = m.id) AS tests_run,
    coalesce((SELECT json_agg(json_build_object('id', a.id, 'seq', a.seq, 'name', a.name, 'unit', a.unit, 'specLow', a.spec_low::float, 'specHigh', a.spec_high::float) ORDER BY a.seq)
              FROM lab_method_analyte a WHERE a.method_id = m.id), '[]') AS analytes
  FROM lab_method m JOIN facility f ON f.id = m.facility_id LEFT JOIN qualification q ON q.id = m.required_qualification_id
  LEFT JOIN document d ON d.id = m.document_id LEFT JOIN document_version dv ON dv.id = m.document_version_id`;

export async function listMethods(tx: Tx, actor: Actor, q: { facilityId?: string; all?: boolean } = {}) {
  requirePermission(actor, 'lab.view');
  const rows = await many(tx, `${METHOD_SQL} WHERE ($1::uuid IS NULL OR m.facility_id = $1) AND ($2::boolean OR m.status = 'active') ORDER BY m.code, m.version DESC`, [q.facilityId ?? null, q.all ?? false]);
  return rows.filter((m) => can(actor, 'lab.view', m.facility_id)).map((m) => ({ ...m, canManage: can(actor, 'lab.manage', m.facility_id) }));
}

export async function getMethod(tx: Tx, actor: Actor, id: string) {
  const m = await one(tx, `${METHOD_SQL} WHERE m.id = $1`, [id]);
  if (!m) throw notFound('method');
  requirePermission(actor, 'lab.view', m.facility_id);
  return { ...m, canManage: can(actor, 'lab.manage', m.facility_id) };
}
