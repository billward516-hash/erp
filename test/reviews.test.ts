import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { asActor } from '../src/platform/auth/actor.js';
import { closePools, getAdminPool } from '../src/platform/db/pool.js';
import { withTx } from '../src/platform/db/tx.js';
import { REVIEWS } from '../src/modules/reviews/catalogue.js';
import { listReviews, recordReview, reviewHistory, reviewItems, setRecordInterval, setReviewSetting } from '../src/modules/reviews/service.js';
import { runReminders } from '../src/modules/notifications/reminders.js';
import type { World } from './fixtures.js';
import { makeWorld } from './fixtures.js';

/** Periodic reviews (D-154). */
let app: FastifyInstance; let w: World; let fmeaId: string; let legacyId: string;
const db = () => getAdminPool();
const today = new Date().toISOString().slice(0, 10);
const monthsAgo = (n: number) => { const d = new Date(); d.setUTCMonth(d.getUTCMonth() - n); return d.toISOString(); };
const inMonths = (n: number) => { const d = new Date(`${today}T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() + n); return d.toISOString().slice(0, 10); };
const fmea = async (number: string, approvedMonthsAgo: number, reviewDue: string | null = null) =>
  (await db().query(`INSERT INTO fmea (tenant_id, facility_id, number, kind, title, scope, owner_user_id, status, approved_at, review_due, created_by)
    VALUES ($1, $2, $3, 'process', 'Weld cell', 'Cell 4 welding', $4, 'approved', $5, $6, $4) RETURNING id`, [w.tenantId, w.facilities.A, number, w.qualityA.userId, monthsAgo(approvedMonthsAgo), reviewDue])).rows[0].id as string;
const item = async (who = w.qualityA, id = fmeaId) => (await asActor(who, (tx) => listReviews(tx, who, { status: 'all', type: 'fmea' }))).items.find((i) => i.id === id);
const sent = async (kind: string) => Number((await db().query('SELECT count(*)::int AS n FROM notification WHERE tenant_id = $1 AND kind = $2', [w.tenantId, kind])).rows[0].n);

beforeAll(async () => {
  app = buildApp();
  w = await makeWorld('reviews');
  fmeaId = await fmea('FMEA-1', 13);
  legacyId = await fmea('FMEA-2', 1, inMonths(2));
});
afterAll(async () => { await app.close(); await closePools(); });

describe('the catalogue', () => {
  it('every kind’s query runs, so its record type, columns and link are real', async () => {
    for (const d of REVIEWS) await withTx({ tenantId: w.tenantId, userId: null, facilityIds: [], allFacilities: true }, (tx) => reviewItems(tx, w.tenantId, today, d.key));
    expect(REVIEWS.map((d) => d.key)).toEqual(expect.arrayContaining(['fmea', 'continuity', 'document', 'policy', 'course', 'supplier', 'pm_plan', 'spares', 'spc', 'access', 'repair_template', 'visit_template', 'expense_policy']));
  });
});

describe('when a record is due', () => {
  it('counts from approval: an FMEA approved 13 months ago with a yearly review is overdue, for its owner and the area’s managers only', async () => {
    expect(await item()).toMatchObject({ status: 'overdue', months: 12, mine: true, lastReviewedOn: null });
    expect(await item(w.admin)).toMatchObject({ status: 'overdue', mine: false, canManage: true });
    expect(await item(w.techA)).toBeUndefined();
    const access = (await asActor(w.admin, (tx) => listReviews(tx, w.admin, { status: 'all', type: 'access' }))).items[0];
    expect(access).toMatchObject({ status: 'ok', months: 6, dueOn: inMonths(6) });
  });

  it('a review date already typed on the record is used until the first review here', async () => {
    expect(await item(w.qualityA, legacyId)).toMatchObject({ dueOn: inMonths(2), status: 'ok' });
  });

  it('the company’s frequency moves every record of the kind; a record can have its own', async () => {
    await asActor(w.admin, (tx) => setReviewSetting(tx, w.admin, 'fmea', { enabled: true, months: 24, leadDays: 30, repeat: 'weekly', escalateDays: 14 }));
    expect(await item()).toMatchObject({ status: 'ok', months: 24 });
    await asActor(w.qualityA, (tx) => setRecordInterval(tx, w.qualityA, 'fmea', fmeaId, 6));
    expect(await item()).toMatchObject({ status: 'overdue', months: 6, ownMonths: true });
    await expect(asActor(w.qualityA, (tx) => setReviewSetting(tx, w.qualityA, 'access', { enabled: true, months: 3, leadDays: 30, repeat: 'weekly', escalateDays: 14 }))).rejects.toThrow(/tenant.admin/);
    await expect(asActor(w.admin, (tx) => setReviewSetting(tx, w.admin, 'fmea', { enabled: true, months: 0, leadDays: 30, repeat: 'weekly', escalateDays: 14 }))).rejects.toThrow(/every 1 to 60 months/);
    await asActor(w.admin, (tx) => setReviewSetting(tx, w.admin, 'fmea', { enabled: true, months: 12, leadDays: 30, repeat: 'weekly', escalateDays: 14 }));
  });
});

describe('reminders', () => {
  it('the owner is reminded, and after the escalation the area’s managers too', async () => {
    await runReminders(w.tenantId, today);
    expect(await sent('reminder.review_due')).toBeGreaterThanOrEqual(1);
    const esc = (await db().query(`SELECT user_id FROM notification WHERE tenant_id = $1 AND kind = 'reminder.review_escalated' AND subject_id = $2`, [w.tenantId, fmeaId])).rows.map((r) => r.user_id);
    expect(esc).toContain(w.admin.userId);
    expect(esc).not.toContain(w.qualityA.userId);
    const before = await sent('reminder.review_due');
    await runReminders(w.tenantId, today); // same week: not repeated
    expect(await sent('reminder.review_due')).toBe(before);
  });

  it('a kind turned off is neither listed nor reminded', async () => {
    await asActor(w.admin, (tx) => setReviewSetting(tx, w.admin, 'fmea', { enabled: false, months: 12, leadDays: 30, repeat: 'weekly', escalateDays: 14 }));
    expect(await item()).toBeUndefined();
    await asActor(w.admin, (tx) => setReviewSetting(tx, w.admin, 'fmea', { enabled: true, months: 12, leadDays: 30, repeat: 'weekly', escalateDays: 14 }));
  });
});

describe('recording a review', () => {
  it('“no change” starts the next period today; “changes needed” needs a note; both are kept and audited', async () => {
    await expect(asActor(w.qualityA, (tx) => recordReview(tx, w.qualityA, 'fmea', fmeaId, { outcome: 'changes_needed' }))).rejects.toThrow(/say what needs to change/);
    await expect(asActor(w.techA, (tx) => recordReview(tx, w.techA, 'fmea', fmeaId, { outcome: 'no_change' }))).rejects.toThrow();
    const r = await asActor(w.qualityA, (tx) => recordReview(tx, w.qualityA, 'fmea', fmeaId, { outcome: 'no_change', note: 'Checked against Q3 field returns' }));
    expect(r.nextDue).toBe(inMonths(6)); // its own frequency
    expect(await item()).toMatchObject({ status: 'ok', lastReviewedOn: today, dueOn: inMonths(6) });
    const h = await asActor(w.qualityA, (tx) => reviewHistory(tx, 'fmea', fmeaId));
    expect(h[0]).toMatchObject({ outcome: 'no_change', note: 'Checked against Q3 field returns', reviewed_by: 'qualityA' });
    expect(Number((await db().query(`SELECT count(*)::int AS n FROM audit_event WHERE tenant_id = $1 AND action = 'review.recorded'`, [w.tenantId])).rows[0].n)).toBe(1);
  });

  it('works over HTTP for the Reviews page', async () => {
    const h = { authorization: `Bearer ${w.tokens.qualityA}` };
    const list = (await app.inject({ method: 'GET', url: '/api/reviews?status=all&type=fmea', headers: h })).json();
    expect(list.items.map((i: any) => i.number)).toEqual(expect.arrayContaining(['FMEA-1', 'FMEA-2']));
    const r = await app.inject({ method: 'POST', url: `/api/reviews/fmea/${legacyId}`, headers: h, payload: { outcome: 'changes_needed', note: 'Add the new fixture' } });
    expect(r.statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/review-settings', headers: h })).json().find((s: any) => s.key === 'fmea')).toMatchObject({ canEdit: true });
  });
});
