import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asActor, loadActor } from '../src/platform/auth/actor.js';
import type { Actor } from '../src/platform/auth/actor.js';
import { closePools, getAdminPool } from '../src/platform/db/pool.js';
import { LocalBlobStore } from '../src/platform/storage/blob-store.js';
import { createUserWithToken } from '../src/platform/tenancy/provision.js';
import { createAsset } from '../src/modules/assets/service.js';
import { createPart } from '../src/modules/parts/service.js';
import { createOrder, createRevision, getOrder, releaseOrder, releaseRevision, saveRevision, saveWorkCenter, startOperation, stopOperation } from '../src/modules/production/service.js';
import { addAttachment, attachmentFile, listAttachments } from '../src/modules/quality/attachments.js';
import { capaForFinding, closeAudit, createAudit, getAudit, recordItem, reportAudit, startAudit } from '../src/modules/quality/audits.js';
import { getPlan, listCalibration, recordCalibration, savePlan } from '../src/modules/quality/calibration.js';
import { addAction, createNcr, getNcr } from '../src/modules/quality/service.js';
import { getReport } from '../src/modules/reporting/registry.js';
import { reportIncident } from '../src/modules/safety/service.js';
import type { World } from './fixtures.js';
import { makeWorld } from './fixtures.js';

const db = () => getAdminPool();
const blobs = new LocalBlobStore('./.storage/test');
const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
let w: World;
let op: Actor;
let gauge: string; let opId: string; let plan: any;

beforeAll(async () => {
  w = await makeWorld('cal');
  const e = (await db().query(`INSERT INTO employee (tenant_id, facility_id, employee_number, first_name, last_name, job_title) VALUES ($1, $2, 'E500', 'Ines', 'Moreau', 'Inspector') RETURNING id`, [w.tenantId, w.facilities.A])).rows[0].id;
  const u = await createUserWithToken(db(), w.tenantId, { email: `ines-${Date.now()}@c.example`, displayName: 'Ines', employeeId: e, roles: [{ role: 'operator', facility: w.facilities.A! }] });
  op = (await loadActor(w.tenantId, u.userId))!;
  const ids = await asActor(w.admin, async (tx) => {
    const g = await createAsset(tx, w.admin, { facilityId: w.facilities.A!, assetTag: 'CMM-9', name: 'Bench CMM' });
    const wc = await saveWorkCenter(tx, w.admin, { facilityId: w.facilities.A!, code: 'INSP', name: 'Inspection', assetIds: [g.id] });
    const p = await createPart(tx, w.admin, { partNumber: 'PIN-7', description: 'Dowel pin' });
    const rev = await createRevision(tx, w.admin, { partId: p.id });
    await saveRevision(tx, w.admin, rev.id, { materials: [], operations: [{ opNo: 10, workCenterId: wc.id, description: 'Measure' }] });
    await releaseRevision(tx, w.admin, rev.id);
    const mo = await createOrder(tx, w.admin, { facilityId: w.facilities.A!, partId: p.id, qty: 50 });
    await releaseOrder(tx, w.admin, mo.id);
    return { g: g.id, op: (await getOrder(tx, w.admin, mo.id)).operations[0].id };
  });
  gauge = ids.g; opId = ids.op;
});
afterAll(closePools);

describe('calibration', () => {
  it('an instrument overdue for calibration cannot be used for production', async () => {
    plan = await asActor(w.qualityA, (tx) => savePlan(tx, w.qualityA, { assetId: gauge, intervalDays: 180, tolerance: '±0.003 mm', nextDue: day(-1) }));
    expect((await asActor(w.qualityA, (tx) => listCalibration(tx, w.qualityA)))[0].status).toBe('overdue');
    await expect(asActor(op, (tx) => startOperation(tx, op, opId, { assetId: gauge }))).rejects.toThrow(/CMM-9 is overdue for calibration/);
    await expect(asActor(op, (tx) => savePlan(tx, op, { assetId: gauge, intervalDays: 30, tolerance: 'x' }))).rejects.toThrow(/quality.manage/);
  });

  it('a passing calibration sets the next due date and frees the instrument', async () => {
    await expect(asActor(w.qualityA, (tx) => recordCalibration(tx, w.qualityA, plan.id, { performedOn: day(1), performedBy: 'Q lab', asFound: 'in_tolerance', asLeft: 'in_tolerance' }))).rejects.toThrow(/future/);
    const r = await asActor(w.qualityA, (tx) => recordCalibration(tx, w.qualityA, plan.id, { performedOn: day(-20), performedBy: 'Hexagon field service', asFound: 'in_tolerance', asLeft: 'in_tolerance', certificateNo: 'HX-2210' }));
    expect(r).toEqual({ id: expect.any(String), nextDue: day(160), ncrId: null });
    const e = await asActor(op, (tx) => startOperation(tx, op, opId, { assetId: gauge }));
    await asActor(op, (tx) => stopOperation(tx, op, e.id, { qtyGood: 10 }));
    await expect(db().query('UPDATE calibration_record SET as_found = $2 WHERE id = $1', [r.id, 'out_of_tolerance'])).rejects.toThrow(/cannot be changed/);
  });

  it('found out of tolerance: a major nonconformance lists the production runs measured since the last good calibration', async () => {
    await expect(asActor(w.qualityA, (tx) => recordCalibration(tx, w.qualityA, plan.id, { performedOn: day(0), performedBy: 'Hexagon', asFound: 'out_of_tolerance', asLeft: 'adjusted' }))).rejects.toThrow(/as-found readings/);
    await expect(asActor(w.qualityA, (tx) => recordCalibration(tx, w.qualityA, plan.id, { performedOn: day(0), performedBy: 'Hexagon', asFound: 'out_of_tolerance', asLeft: 'in_tolerance', notes: 'x axis +0.006' })))
      .rejects.toThrow(/must be adjusted/);
    const r = await asActor(w.qualityA, (tx) => recordCalibration(tx, w.qualityA, plan.id, { performedOn: day(0), performedBy: 'Hexagon', asFound: 'out_of_tolerance', asLeft: 'adjusted', notes: 'X axis +0.006 mm at 250 mm' }));
    const n = await asActor(w.qualityA, (tx) => getNcr(tx, w.qualityA, r.ncrId!));
    expect(n).toMatchObject({ severity: 'major', asset_tag: 'CMM-9', title: `CMM-9 found out of tolerance at calibration on ${day(0)}` });
    expect(n.description).toMatch(new RegExp(`since the last good calibration \\(${day(-20)}\\)`));
    expect(n.description).toMatch(/MO-\d+ op 10 \(PIN-7\): 10 good units measured/);
    const p = await asActor(w.qualityA, (tx) => getPlan(tx, w.qualityA, plan.id));
    expect(p.records.map((x: any) => [x.as_found, x.ncr_number != null])).toEqual([['out_of_tolerance', true], ['in_tolerance', false]]);
  });

  it('a failed instrument goes out of service until it passes again', async () => {
    await asActor(w.qualityA, (tx) => recordCalibration(tx, w.qualityA, plan.id, { performedOn: day(0), performedBy: 'Hexagon', asFound: 'in_tolerance', asLeft: 'failed', notes: 'Probe head damaged' }));
    expect((await db().query('SELECT operational_state FROM asset WHERE id = $1', [gauge])).rows[0].operational_state).toBe('out_of_service');
    expect((await asActor(w.qualityA, (tx) => listCalibration(tx, w.qualityA)))[0].status).toBe('failed');
    await expect(asActor(op, (tx) => startOperation(tx, op, opId, { assetId: gauge }))).rejects.toThrow(/out of service/);
    await asActor(w.qualityA, (tx) => recordCalibration(tx, w.qualityA, plan.id, { performedOn: day(0), performedBy: 'Hexagon', asFound: 'in_tolerance', asLeft: 'in_tolerance', notes: 'New probe head' }));
    expect((await db().query('SELECT operational_state FROM asset WHERE id = $1', [gauge])).rows[0].operational_state).toBe('available');
  });
});

describe('internal audits', () => {
  let a: any; let items: any[];
  it('the auditor cannot audit their own area; findings need evidence; the report needs every item', async () => {
    const base = { facilityId: w.facilities.A!, title: 'Production control', scope: 'ISO 9001 8.5.1 at Plant A', plannedOn: day(0), items: ['Work instructions at the point of use', 'Operators qualified for the machines they run', 'Measuring equipment calibrated'] };
    await expect(asActor(w.qualityA, (tx) => createAudit(tx, w.qualityA, { ...base, leadAuditorId: w.opsA.userId, auditeeUserId: w.opsA.userId }))).rejects.toThrow(/own area/);
    a = await asActor(w.qualityA, (tx) => createAudit(tx, w.qualityA, { ...base, leadAuditorId: w.qualityA.userId, auditeeUserId: w.opsA.userId }));
    expect(a.number).toMatch(/^AUD-\d{5}$/);
    items = (await asActor(w.qualityA, (tx) => getAudit(tx, w.qualityA, a.id))).items;
    await expect(asActor(w.qualityA, (tx) => recordItem(tx, w.qualityA, items[0].id, { result: 'conforming' }))).rejects.toThrow(/start the audit/);
    await asActor(w.qualityA, (tx) => startAudit(tx, w.qualityA, a.id));
    await asActor(w.qualityA, (tx) => recordItem(tx, w.qualityA, items[0].id, { result: 'conforming' }));
    await expect(asActor(w.qualityA, (tx) => recordItem(tx, w.qualityA, items[1].id, { result: 'minor_nc' }))).rejects.toThrow(/objective evidence/);
    await asActor(w.qualityA, (tx) => recordItem(tx, w.qualityA, items[1].id, { result: 'minor_nc', evidence: 'Operator E212 running VMC-2 without the VMC qualification on record' }));
    await expect(asActor(w.qualityA, (tx) => reportAudit(tx, w.qualityA, a.id, 'Summary'))).rejects.toThrow(/item 3/);
    await asActor(w.qualityA, (tx) => recordItem(tx, w.qualityA, items[2].id, { result: 'major_nc', evidence: 'CMM-9 used for production while out of tolerance; impact not assessed for 3 weeks' }));
    expect(await asActor(w.qualityA, (tx) => reportAudit(tx, w.qualityA, a.id, 'Two findings; work instructions good.'))).toEqual({ findings: 2 });
    const n = (await db().query(`SELECT title FROM notification WHERE user_id = $1 AND kind = 'quality.audit_reported'`, [w.opsA.userId])).rows;
    expect(n).toEqual([{ title: `${a.number} report: 2 findings to answer` }]);
  });

  it('every finding is answered by a corrective action or an action before the audit closes', async () => {
    await expect(asActor(w.qualityA, (tx) => closeAudit(tx, w.qualityA, a.id))).rejects.toThrow(/findings 2, 3/);
    const c = await asActor(w.qualityA, (tx) => capaForFinding(tx, w.qualityA, items[2].id, {}));
    expect(c).toMatchObject({ source: 'audit', priority: 'high', owner_user_id: w.opsA.userId });
    await expect(asActor(w.qualityA, (tx) => capaForFinding(tx, w.qualityA, items[0].id, {}))).rejects.toThrow(/only nonconformities/);
    await expect(asActor(w.qualityA, (tx) => closeAudit(tx, w.qualityA, a.id))).rejects.toThrow(/finding 2 /);
    // The auditee answers the minor finding with an action.
    await asActor(w.opsA, (tx) => addAction(tx, w.opsA, { subjectType: 'quality_audit', subjectId: a.id, auditItemId: items[1].id, title: 'Qualify E212 on VMC-2 or reassign', ownerUserId: w.managerA.userId, dueDate: day(14) }));
    await asActor(w.qualityA, (tx) => closeAudit(tx, w.qualityA, a.id));
    const v = await asActor(w.opsA, (tx) => getAudit(tx, w.opsA, a.id));
    expect(v).toMatchObject({ status: 'closed', findings: 2 });
    expect(v.items.map((i: any) => [i.result, i.capa_number != null, i.actions])).toEqual([['conforming', false, 0], ['minor_nc', false, 1], ['major_nc', true, 0]]);
  });
});

describe('attachments', () => {
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
  it('incident photos are restricted to the safety team and the uploader; other files follow the record', async () => {
    const inc = await asActor(w.techA, (tx) => reportIncident(tx, w.techA, { facilityId: w.facilities.A!, kind: 'injury', occurredAt: new Date(Date.now() - 60_000), description: 'Slip at wash station' }));
    const f = await asActor(w.techA, (tx) => addAttachment(tx, w.techA, blobs, { subjectType: 'safety_incident', subjectId: inc.id, fileName: 'floor.png', mime: 'image/png', content: png }));
    expect(f.restricted).toBe(true);
    expect(await asActor(w.opsA, (tx) => listAttachments(tx, w.opsA, 'safety_incident', inc.id))).toEqual([]);
    await expect(asActor(w.opsA, (tx) => attachmentFile(tx, w.opsA, blobs, f.id))).rejects.toThrow(/safety.manage/);
    expect((await asActor(w.ehsA, (tx) => attachmentFile(tx, w.ehsA, blobs, f.id))).content.equals(png)).toBe(true);
    expect((await asActor(w.techA, (tx) => listAttachments(tx, w.techA, 'safety_incident', inc.id))).map((x) => x.file_name)).toEqual(['floor.png']);
    const n = await asActor(w.qualityA, (tx) => createNcr(tx, w.qualityA, { facilityId: w.facilities.A!, description: 'Burr on pin chamfer' }));
    await asActor(w.qualityA, (tx) => addAttachment(tx, w.qualityA, blobs, { subjectType: 'nonconformance', subjectId: n.id, fileName: 'burr photo.png', mime: 'image/png', content: png }));
    expect((await asActor(w.opsA, (tx) => listAttachments(tx, w.opsA, 'nonconformance', n.id))).map((x) => x.file_name)).toEqual(['burr photo.png']);
    await expect(asActor(w.qualityA, (tx) => addAttachment(tx, w.qualityA, blobs, { subjectType: 'nonconformance', subjectId: n.id, fileName: 'x.exe', mime: 'application/x-msdownload', content: png }))).rejects.toThrow(/not accepted/);
    await expect(asActor(w.operatorB, (tx) => listAttachments(tx, w.operatorB, 'nonconformance', n.id))).rejects.toThrow();
  });

  it('the quality report counts instruments overdue for calibration', async () => {
    await asActor(w.admin, async (tx) => {
      const g2 = await createAsset(tx, w.admin, { facilityId: w.facilities.A!, assetTag: 'MIC-3', name: 'Micrometer 0-25' });
      await savePlan(tx, w.admin, { assetId: g2.id, intervalDays: 365, tolerance: '±0.002 mm', nextDue: day(-3) });
    });
    const def = getReport('quality-status')!;
    const r = await asActor(w.qualityA, (tx) => def.run(tx, w.qualityA, def.params.parse({})));
    expect(r.kpis.find((k) => k.label === 'Instruments overdue for calibration')).toMatchObject({ value: 1, note: 'of 2 under control' });
    expect(r.insights.join(' ')).toMatch(/1 instrument overdue for calibration or failed: MIC-3/);
  });
});
