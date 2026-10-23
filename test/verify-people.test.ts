import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import type { Actor } from '../src/platform/auth/actor.js';
import { asActor, loadActor } from '../src/platform/auth/actor.js';
import { safeReturn } from '../src/platform/auth/sso.js';
import { closePools, getAdminPool } from '../src/platform/db/pool.js';
import { withTx } from '../src/platform/db/tx.js';
import { notify } from '../src/platform/notify/notify.js';
import { createUserWithToken } from '../src/platform/tenancy/provision.js';
import { createAsset } from '../src/modules/assets/service.js';
import { stageImport } from '../src/modules/imports/service.js';
import { addPart, createWorkOrder } from '../src/modules/maintenance/service.js';
import { runReminders } from '../src/modules/notifications/reminders.js';
import { createPart } from '../src/modules/parts/service.js';
import { getReview, hrAction, listPerformance, nextReviewDue, openDueReviews, saveAssessment, saveSettings } from '../src/modules/performance/service.js';
import { requestForWorkOrder } from '../src/modules/purchasing/service.js';
import { runRetention } from '../src/modules/retention/service.js';
import type { World } from './fixtures.js';
import { makeWorld } from './fixtures.js';

/** Verification pass (D-161): people, notifications and work order demand. */
let app: FastifyInstance; let w: World; let hr: Actor; let hrEmp: string;
const db = () => getAdminPool();
const sys = (tenantId: string) => ({ tenantId, userId: null, facilityIds: [], allFacilities: true });
const settings = { enabled: true, intervalMonths: 12, anchor: 'calendar' as const, calendarMonth: 3, firstReviewMonths: 3, checkinMonths: 0, selfAssessment: true, openDaysBefore: 21 };

beforeAll(async () => {
  app = buildApp();
  w = await makeWorld('vfypeople');
  hrEmp = (await db().query(`INSERT INTO employee (tenant_id, facility_id, employee_number, first_name, last_name, hire_date) VALUES ($1, $2, 'H-1', 'Hana', 'Hr', '2015-01-05') RETURNING id`, [w.tenantId, w.facilities.A])).rows[0].id;
  const h = await createUserWithToken(db(), w.tenantId, { email: `hr@${w.tenantId}.example`, displayName: 'Hana HR', roles: [{ role: 'hr_manager', facility: null }], employeeId: hrEmp });
  hr = (await loadActor(w.tenantId, h.userId))!;
});
afterAll(async () => { await app.close(); await closePools(); });

describe('performance reviews', () => {
  it('a new hire’s first review is followed by the next cycle date at least half an interval on, not a year and a half later', () => {
    const S = { ...settings, calendarMonth: 1, configured: true };
    expect(nextReviewDue(S, { hire_date: '2026-03-15' }, null, '2026-05-01')).toBe('2026-06-30');
    expect(nextReviewDue(S, { hire_date: '2026-03-15' }, '2026-06-30', '2026-07-01')).toBe('2027-01-31');
    expect(nextReviewDue(S, { hire_date: '2026-03-15' }, '2027-01-31', '2027-02-01')).toBe('2028-01-31');
  });

  it('someone in HR is the employee on their own review: no draft, no editing, no HR actions on it, and not in their HR list', async () => {
    await asActor(hr, (tx) => saveSettings(tx, hr, settings));
    await withTx(sys(w.tenantId), (tx) => openDueReviews(tx, w.tenantId, '2027-03-15'));
    const own = (await db().query(`SELECT id FROM performance_review WHERE employee_id = $1`, [hrEmp])).rows[0].id;
    await db().query(`UPDATE performance_review SET rating = 2, summary = 'Draft notes' WHERE id = $1`, [own]);
    expect(await asActor(hr, (tx) => getReview(tx, hr, own))).toMatchObject({ role: 'employee', rating: null, summary: null });
    await expect(asActor(hr, (tx) => saveAssessment(tx, hr, own, { rating: 5, summary: 'Great' }))).rejects.toThrow(/reviewer writes/);
    await expect(asActor(hr, (tx) => hrAction(tx, hr, own, { action: 'cancel', reason: 'no thanks' }))).rejects.toThrow(/another member of HR/);
    const list = await asActor(hr, (tx) => listPerformance(tx, hr));
    expect(list.all!.find((r: any) => r.id === own)).toMatchObject({ role: 'employee', summary: null });
  });

  it('a review cancelled before it was shared keeps its draft hidden, and the next cycle still opens', async () => {
    const r = (await db().query(`SELECT id FROM performance_review WHERE employee_id = $1`, [w.techAEmployeeId])).rows[0].id;
    await db().query(`UPDATE performance_review SET rating = 2, summary = 'Unshared draft' WHERE id = $1`, [r]);
    await asActor(hr, (tx) => hrAction(tx, hr, r, { action: 'cancel', reason: 'Long leave' }));
    expect(await asActor(w.techA, (tx) => getReview(tx, w.techA, r))).toMatchObject({ status: 'cancelled', rating: null, summary: null });
    await withTx(sys(w.tenantId), (tx) => openDueReviews(tx, w.tenantId, '2028-03-15'));
    const rows = (await db().query(`SELECT status, due_on FROM performance_review WHERE employee_id = $1 ORDER BY due_on`, [w.techAEmployeeId])).rows;
    expect(rows).toEqual([{ status: 'cancelled', due_on: '2027-03-31' }, { status: 'open', due_on: '2028-03-31' }]);
  });
});

describe('employee imports', () => {
  it('reporting lines that loop are refused, and a manager whose row fails is said, not dropped silently', async () => {
    const file = Buffer.from('Emp No,First,Last,Reports To,Site\nL-1,Ada,Kim,L-2,A\nL-2,Sam,Lee,L-1,A\nL-3,,,,A\nL-4,Max,Roe,L-3,A\n');
    const staged = await stageImport(w.admin, { target: 'employees', sourceSystem: 'payroll', fileName: 'loop.csv', content: file });
    const rows = (await db().query(`SELECT row_number, messages FROM import_row WHERE batch_id = $1 ORDER BY row_number`, [staged.batchId])).rows;
    const text = (n: number) => JSON.stringify(rows[n]!.messages);
    expect(text(0)).toMatch(/reporting lines loop/);
    expect(text(1)).toMatch(/reporting lines loop/);
    expect(text(3)).toMatch(/manager L-3 has errors on their own row/);
  });
});

describe('query yes/no parameters', () => {
  it('"false" means no, and nonsense is refused', async () => {
    await db().query(`INSERT INTO notification (tenant_id, user_id, kind, title, read_at) VALUES ($1, $2, 'test', 'Already read', now())`, [w.tenantId, w.techA.userId]);
    const h = { authorization: `Bearer ${w.tokens.techA}` };
    const no = await app.inject({ url: '/api/notifications?unreadOnly=false', headers: h });
    expect(JSON.stringify(no.json())).toMatch(/Already read/);
    const yes = await app.inject({ url: '/api/notifications?unreadOnly=true', headers: h });
    expect(JSON.stringify(yes.json())).not.toMatch(/Already read/);
    expect((await app.inject({ url: '/api/notifications?unreadOnly=maybe', headers: h })).statusCode).toBe(422);
  });
});

describe('sign-in return paths', () => {
  it('only paths on this site', () => {
    expect(safeReturn('/work-orders?x=1')).toBe('/work-orders?x=1');
    for (const bad of ['//evil.example', '/\\evil.example', '/\t/evil.example', '/\n/evil.example', 'https://evil.example', '/a b', null]) expect(safeReturn(bad)).toBe('/');
  });
});

describe('reminders', () => {
  it('a qualification renewed without an expiry date gets no expiry reminder', async () => {
    const q = (await db().query(`INSERT INTO qualification (tenant_id, code, name) VALUES ($1, 'Q-FLT', 'Forklift') RETURNING id`, [w.tenantId])).rows[0].id;
    await db().query(`INSERT INTO employee_qualification (tenant_id, employee_id, qualification_id, granted_by, granted_at, expires_on) VALUES
      ($1, $2, $3, $4, now() - interval '2 years', current_date + 10), ($1, $2, $3, $4, now(), NULL)`, [w.tenantId, w.techAEmployeeId, q, w.admin.userId]);
    await runReminders(w.tenantId);
    expect((await db().query(`SELECT count(*)::int AS n FROM notification WHERE user_id = $1 AND kind = 'reminder.qualification_expiring'`, [w.techA.userId])).rows[0].n).toBe(0);
  });

  it('a once-only reminder is not sent again after retention deletes the old notification', async () => {
    await db().query(`INSERT INTO notification (tenant_id, user_id, kind, title, dedupe_key, created_at, read_at) VALUES ($1, $2, 'reminder.test', 'Old', 'test-once:1:once', now() - interval '400 days', now() - interval '400 days')`,
      [w.tenantId, w.tech2A.userId]);
    await runRetention(w.tenantId);
    expect((await db().query(`SELECT count(*)::int AS n FROM notification WHERE dedupe_key = 'test-once:1:once' AND user_id = $1`, [w.tech2A.userId])).rows[0].n).toBe(0);
    const sent = await withTx(sys(w.tenantId), (tx) => notify(tx, w.tenantId, [w.tech2A.userId], { kind: 'reminder.test', title: 'Again', dedupeKey: 'test-once:1:once' }));
    expect(sent).toBe(0);
    expect(await withTx(sys(w.tenantId), (tx) => notify(tx, w.tenantId, [w.tech2A.userId], { kind: 'reminder.test', title: 'Other', dedupeKey: 'test-once:2:once' }))).toBe(1);
  });
});

describe('work order demand', () => {
  it('a part used without its planned line is not requested again', async () => {
    const asset = await asActor(w.managerA, (tx) => createAsset(tx, w.managerA, { facilityId: w.facilities.A!, assetTag: 'VFY-1', name: 'Press' }));
    const part = await asActor(w.admin, (tx) => createPart(tx, w.admin, { partNumber: 'VFY-SEAL', description: 'Seal kit' }));
    const wo = await asActor(w.managerA, async (tx) => {
      const o = await createWorkOrder(tx, w.managerA, { assetId: asset.id, title: 'Reseal press' });
      await addPart(tx, w.managerA, o.id, { partId: part.id, qtyPlanned: 2 });
      return o;
    });
    await asActor(w.admin, (tx) => addPart(tx, w.admin, wo.id, { partId: part.id, qtyUsed: 2 }));
    await expect(asActor(w.admin, (tx) => requestForWorkOrder(tx, w.admin, wo.id))).rejects.toThrow(/nothing to request/);
  });
});
