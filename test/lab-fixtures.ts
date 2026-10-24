import { asActor, loadActor } from '../src/platform/auth/actor.js';
import type { Actor } from '../src/platform/auth/actor.js';
import { getAdminPool } from '../src/platform/db/pool.js';
import { createUserWithToken } from '../src/platform/tenancy/provision.js';
import { createAsset } from '../src/modules/assets/service.js';
import { createMethod } from '../src/modules/lab/methods.js';
import { addTest, enterResults } from '../src/modules/lab/results.js';
import { receiveSample } from '../src/modules/lab/samples.js';
import { savePlan } from '../src/modules/quality/calibration.js';
import type { World } from './fixtures.js';
import { makeWorld } from './fixtures.js';

export const db = () => getAdminPool();
export const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

export interface Lab {
  w: World;
  /** lab analyst at A holding QUAL-TITR */
  analyst: Actor; analystUserId: string;
  /** lab analyst at A without the qualification */
  unqualified: Actor;
  /** quality reviewer at A: lab.view and lab.review only, not an analyst */
  reviewer: Actor;
  /** laboratory manager at A: analyze, review, manage; also qualified */
  manager: Actor;
  /** quality manager at A: lab.view, review, manage and quality.manage (for corrective actions) */
  quality: Actor;
  /** laboratory manager at B only */
  managerB: Actor;
  qualId: string; methodId: string; titrationAnalytes: Record<string, string>;
  balance: string; balanceOverdue: string; phMeter: string; notControlled: string;
}

async function person(w: World, key: string, role: string, facility: string | null, employee?: { number: string; first: string; last: string }) {
  let employeeId: string | undefined;
  if (employee) {
    employeeId = (await db().query(`INSERT INTO employee (tenant_id, facility_id, employee_number, first_name, last_name, job_title) VALUES ($1, $2, $3, $4, $5, 'Analyst') RETURNING id`,
      [w.tenantId, facility ?? w.facilities.A, employee.number, employee.first, employee.last])).rows[0].id as string;
  }
  const u = await createUserWithToken(db(), w.tenantId, { email: `${key}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@lab.example`, displayName: key, employeeId, roles: [{ role, facility }] });
  return { actor: (await loadActor(w.tenantId, u.userId))!, employeeId, userId: u.userId };
}

export async function grantQualification(w: World, employeeId: string, qualId: string, opts: { expiresOn?: string | null; revoked?: boolean } = {}) {
  const g = (await db().query(`INSERT INTO employee_qualification (tenant_id, employee_id, qualification_id, granted_by, expires_on) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [w.tenantId, employeeId, qualId, w.admin.userId, opts.expiresOn ?? null])).rows[0].id;
  if (opts.revoked) await db().query(`UPDATE employee_qualification SET revoked_at = now(), revoked_by = $2, revoke_reason = 'test' WHERE id = $1`, [g, w.admin.userId]);
}

/** A site-A laboratory: people, a titration method (one-sided and two-sided limits, needs QUAL-TITR and a balance), instruments in and out of calibration. */
export async function makeLab(prefix = 'lab'): Promise<Lab> {
  const w = await makeWorld(prefix);
  const A = w.facilities.A!;
  const qualId = (await db().query(`INSERT INTO qualification (tenant_id, code, name) VALUES ($1, 'QUAL-TITR', 'Potentiometric titration') RETURNING id`, [w.tenantId])).rows[0].id as string;
  const a = await person(w, 'analyst', 'lab_analyst', A, { number: 'L100', first: 'Ada', last: 'Analyst' });
  await grantQualification(w, a.employeeId!, qualId);
  const un = await person(w, 'unqualified', 'lab_analyst', A, { number: 'L101', first: 'Uma', last: 'Unqualified' });
  const rv = await person(w, 'reviewer', 'quality_reviewer', A, { number: 'L102', first: 'Rae', last: 'Reviewer' });
  const mg = await person(w, 'manager', 'lab_manager', A, { number: 'L103', first: 'Max', last: 'Manager' });
  await grantQualification(w, mg.employeeId!, qualId);
  const ql = await person(w, 'quality', 'quality_manager', A);
  const mb = await person(w, 'managerB', 'lab_manager', w.facilities.B!);
  const inst = await asActor(w.admin, async (tx) => {
    const mk = async (tag: string, name: string, category: string | null) => (await createAsset(tx, w.admin, { facilityId: A, assetTag: tag, name, category: category ?? undefined } as any)).id as string;
    const balance = await mk('BAL-1', 'Analytical balance', 'Balance');
    const overdue = await mk('BAL-2', 'Old balance', 'Balance');
    const ph = await mk('PH-1', 'pH meter', 'pH meter');
    const loose = await mk('BAL-3', 'Uncontrolled balance', 'Balance');
    await savePlan(tx, w.qualityA, { assetId: balance, intervalDays: 365, tolerance: '±0.1 mg', nextDue: day(60) });
    await savePlan(tx, w.qualityA, { assetId: overdue, intervalDays: 365, tolerance: '±0.1 mg', nextDue: day(-3) });
    await savePlan(tx, w.qualityA, { assetId: ph, intervalDays: 90, tolerance: '±0.02 pH', nextDue: day(10) });
    return { balance, overdue, ph, loose };
  });
  const doc = (await db().query(`INSERT INTO document (tenant_id, facility_id, doc_number, title, doc_type) VALUES ($1, $2, 'SOP-TITR', 'Titration procedure', 'sop') RETURNING id`, [w.tenantId, A])).rows[0].id as string;
  const m = await asActor(mg.actor, (tx) => createMethod(tx, mg.actor, { facilityId: A, code: 'TITR-01', name: 'Assay by titration', documentId: doc, requiredQualificationId: qualId, requiredInstrumentClass: 'Balance',
    analytes: [{ name: 'Assay', unit: '%', specLow: 98 }, { name: 'Moisture', unit: '%', specHigh: 2 }, { name: 'pH', unit: 'pH', specLow: 6.5, specHigh: 7.5 }] }));
  const analytes = Object.fromEntries((await db().query('SELECT id, name FROM lab_method_analyte WHERE method_id = $1', [m.id])).rows.map((r) => [r.name, r.id]));
  return { w, analyst: a.actor, analystUserId: a.userId, unqualified: un.actor, reviewer: rv.actor, manager: mg.actor, quality: ql.actor, managerB: mb.actor,
    qualId, methodId: m.id, titrationAnalytes: analytes, balance: inst.balance, balanceOverdue: inst.overdue, phMeter: inst.ph, notControlled: inst.loose };
}

/** A received sample with the titration test added; results are entered by the caller. */
export async function sampleWithTest(l: Lab, over: Partial<Parameters<typeof receiveSample>[2]> = {}) {
  const s = await asActor(l.analyst, (tx) => receiveSample(tx, l.analyst, { facilityId: l.w.facilities.A!, source: 'customer', description: 'Lot 42 powder', dueOn: day(5), storageLocation: 'Fridge 2', ...over }));
  const t = await asActor(l.analyst, (tx) => addTest(tx, l.analyst, s.id, { methodId: l.methodId }));
  return { sample: s, test: t };
}

export const passing = (l: Lab, instrumentId = l.balance) => [
  { analyteId: l.titrationAnalytes.Assay!, value: 99.2, instrumentId }, { analyteId: l.titrationAnalytes.Moisture!, value: 1.1, instrumentId }, { analyteId: l.titrationAnalytes.pH!, value: 7.0, instrumentId },
];

export async function enterPassing(l: Lab, testId: string) {
  return asActor(l.analyst, (tx) => enterResults(tx, l.analyst, testId, passing(l)));
}

/** An API token for a user, for tests that go through HTTP. */
export async function tokenFor(l: Lab, userId: string) {
  const { generateToken, hashToken } = await import('../src/platform/auth/actor.js');
  const t = generateToken();
  await db().query('INSERT INTO api_token (tenant_id, user_id, token_hash, label) VALUES ($1, $2, $3, $4)', [l.w.tenantId, userId, hashToken(t), 'lab test']);
  return t;
}
