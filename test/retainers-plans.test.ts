import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asActor } from '../src/platform/auth/actor.js';
import type { Actor } from '../src/platform/auth/actor.js';
import { closePools, getAdminPool } from '../src/platform/db/pool.js';
import { LocalBlobStore } from '../src/platform/storage/blob-store.js';
import { voidInvoice } from '../src/modules/ar/service.js';
import { createDraftInvoice, createRun, getRun } from '../src/modules/billing/service.js';
import { saveSettings } from '../src/modules/billing/rates.js';
import { runDailyForTenant } from '../src/platform/jobs/daily.js';
import { whatIsLate } from '../src/modules/late/service.js';
import { runReminders } from '../src/modules/notifications/reminders.js';
import { getReport } from '../src/modules/reporting/registry.js';
import { cancelPlan, changeAmount, createPlan, generateNow, getPlan, listPlans, pausePlan, renewPlan, resumePlan, runRetainers, updatePlan } from '../src/modules/retainers/service.js';
import { actorWith, customer, project } from './billing-helpers.js';
import type { World } from './fixtures.js';
import { makeWorld } from './fixtures.js';

const blobs = new LocalBlobStore('./.storage/test');
const db = () => getAdminPool();
let w: World; let clerk: Actor; let clerkB: Actor; let viewer: Actor; let acme: string; let proj: string;
const mk = (a: Actor, o: Partial<Parameters<typeof createPlan>[2]> = {}) => asActor(a, (tx) => createPlan(tx, a, { customerId: acme, description: 'Managed IT retainer', amount: 3000, interval: 'month', startDate: '2026-08-15', ...o }));
const daily = (on: string) => runRetainers(w.tenantId, blobs, on);
const charges = async (planId: string) => (await db().query(`SELECT c.period_start::text AS period_start, c.amount::float AS amount, c.status, c.invoice_id, i.status AS invoice_status, i.number FROM retainer_charge c LEFT JOIN customer_invoice i ON i.id = c.invoice_id WHERE c.plan_id = $1 ORDER BY c.period_start`, [planId])).rows;
const plan = (a: Actor, id: string) => asActor(a, (tx) => getPlan(tx, a, id)) as Promise<any>;

beforeAll(async () => {
  w = await makeWorld('ret');
  clerk = await actorWith(w, 'ar_clerk', 'clerk', null);
  clerkB = await actorWith(w, 'ar_clerk', 'clerkB', w.facilities.B!);
  viewer = await actorWith(w, 'executive', 'viewer', null);
  acme = await customer(w, 'ACME', 'Acme Plastics');
  proj = await project(w, { number: 'RT-1', customerId: acme, billingType: 'retainer' });
});
afterAll(async () => { await closePools(); });

describe('scheduled invoices', () => {
  let a: { id: string; number: string };
  it('make one draft invoice per plan per period, prorating the first, however often the daily job runs', async () => {
    a = await mk(clerk, { projectId: proj });
    expect(a.number).toMatch(/^RP-/);
    await daily('2026-08-14');
    expect(await charges(a.id)).toHaveLength(0); // not started
    expect(await daily('2026-08-20')).toMatchObject({ failed: 0 });
    for (let i = 0; i < 3; i++) await daily('2026-08-20');
    expect(await charges(a.id)).toHaveLength(1);
    await daily('2026-08-31');
    expect(await charges(a.id)).toHaveLength(1);
    await daily('2026-09-02'); await daily('2026-09-02');
    const c = await charges(a.id);
    expect(c.map((x) => [x.period_start, x.amount, x.status, x.invoice_status])).toEqual([['2026-08-01', 1645.16, 'generated', 'draft'], ['2026-09-01', 3000, 'generated', 'draft']]);
    const inv = (await db().query(`SELECT i.customer_id, i.notes, l.description, l.project_id, l.retainer_charge_id, l.qty::float AS qty, l.unit_price::float AS unit_price, l.account_key FROM customer_invoice i JOIN customer_invoice_line l ON l.invoice_id = i.id WHERE i.id = $1`, [c[0]!.invoice_id])).rows;
    expect(inv).toHaveLength(1);
    expect(inv[0]).toMatchObject({ customer_id: acme, notes: `Retainer ${a.number}`, project_id: proj, qty: 1, unit_price: 1645.16, account_key: 'service_revenue' });
    expect(inv[0].description).toBe('Managed IT retainer, August 2026 (prorated: 2026-08-15 to 2026-08-31)');
    const history = await plan(clerk, a.id);
    expect(history.charges.map((x: any) => [x.periodStart, x.invoiceStatus])).toEqual([['2026-09-01', 'draft'], ['2026-08-01', 'draft']]);
    expect(history).toMatchObject({ status: 'active', nextInvoiceDate: '2026-10-01', amount: 3000 });
    expect(history.history.map((h: any) => h.action)).toContain('retainers.period_invoiced');
  });
  it('a change of amount starts at a period that is not yet invoiced', async () => {
    await expect(asActor(clerk, (tx) => changeAmount(tx, clerk, a.id, { effectiveFrom: '2026-11-15', amount: 3500 }))).rejects.toMatchObject({ status: 422 }); // not a month start
    await expect(asActor(clerk, (tx) => changeAmount(tx, clerk, a.id, { effectiveFrom: '2026-09-01', amount: 3500 }))).rejects.toMatchObject({ status: 409 }); // already invoiced
    await asActor(clerk, (tx) => changeAmount(tx, clerk, a.id, { effectiveFrom: '2026-11-01', amount: 3500, reason: 'Added the second office' }));
    await expect(asActor(clerk, (tx) => changeAmount(tx, clerk, a.id, { effectiveFrom: '2026-11-01', amount: 3600 }))).rejects.toMatchObject({ status: 409 });
    await daily('2026-10-02'); await daily('2026-11-02');
    expect((await charges(a.id)).map((x) => [x.period_start, x.amount])).toEqual([['2026-08-01', 1645.16], ['2026-09-01', 3000], ['2026-10-01', 3000], ['2026-11-01', 3500]]);
  });
  it('a plan cancelled from a date bills the last period for the days it covers, then stops', async () => {
    await expect(asActor(clerk, (tx) => cancelPlan(tx, clerk, a.id, { effectiveOn: '2026-10-15', reason: 'Customer left' }))).rejects.toMatchObject({ status: 409 }); // Oct and Nov are invoiced
    await asActor(clerk, (tx) => cancelPlan(tx, clerk, a.id, { effectiveOn: '2026-12-15', reason: 'Customer moving to an in-house team' }));
    expect((await plan(clerk, a.id)).status).toBe('active'); // still running until the date
    await daily('2026-12-02');
    expect((await charges(a.id)).at(-1)).toMatchObject({ period_start: '2026-12-01', amount: 1693.55 }); // 3500 × 15/31
    await daily('2027-01-05');
    expect(await charges(a.id)).toHaveLength(5);
    expect(await plan(clerk, a.id)).toMatchObject({ status: 'cancelled', cancelOn: '2026-12-15', nextInvoiceDate: null });
    await expect(asActor(clerk, (tx) => cancelPlan(tx, clerk, a.id, { effectiveOn: '2027-01-31', reason: 'again' }))).rejects.toMatchObject({ status: 409 });
  });
});

describe('pause, resume, term end and renewal', () => {
  it('a paused plan skips the periods that start while it is paused', async () => {
    const q = await mk(clerk, { description: 'Quarterly advisory', amount: 9000, interval: 'quarter', startDate: '2026-01-01' });
    await daily('2026-04-02');
    await asActor(clerk, (tx) => pausePlan(tx, clerk, q.id, { from: '2026-06-15', reason: 'Customer on sabbatical' }));
    await expect(asActor(clerk, (tx) => pausePlan(tx, clerk, q.id, {}))).rejects.toMatchObject({ status: 409 });
    expect((await plan(clerk, q.id)).status).toBe('paused');
    await daily('2026-07-05'); await daily('2026-08-01');
    await asActor(clerk, (tx) => resumePlan(tx, clerk, q.id, { on: '2026-09-15' }));
    await daily('2026-10-02'); await daily('2026-10-02');
    expect((await charges(q.id)).map((x) => [x.period_start, x.amount])).toEqual([['2026-01-01', 9000], ['2026-04-01', 9000], ['2026-10-01', 9000]]);
    expect((await plan(clerk, q.id)).status).toBe('active');
  });
  it('a term that ends without renewal is billed to its last day and then closes; renewing brings it back', async () => {
    const d = await mk(clerk, { description: 'Support block', amount: 500, startDate: '2026-01-01', endDate: '2026-03-31' });
    await daily('2026-05-01');
    expect(await charges(d.id)).toHaveLength(3);
    expect(await plan(clerk, d.id)).toMatchObject({ status: 'cancelled', cancelReason: 'Term ended without renewal', cancelOn: '2026-03-31' });
    await expect(asActor(viewer, (tx) => renewPlan(tx, viewer, d.id, { months: 2 }))).rejects.toMatchObject({ status: 403 });
    expect(await asActor(clerk, (tx) => renewPlan(tx, clerk, d.id, { endDate: '2026-06-30' }))).toEqual({ endDate: '2026-06-30' });
    await daily('2026-05-01');
    expect((await charges(d.id)).map((x) => x.period_start)).toEqual(['2026-01-01', '2026-02-01', '2026-03-01', '2026-04-01', '2026-05-01']);
  });
  it('a plan that renews itself extends its term and keeps billing', async () => {
    const y = await mk(clerk, { description: 'Annual licence', amount: 12_000, interval: 'year', startDate: '2026-01-01', endDate: '2026-12-31', autoRenew: true, renewalTermMonths: 12 });
    await daily('2026-06-01');
    await daily('2027-01-05');
    expect(await plan(clerk, y.id)).toMatchObject({ endDate: '2027-12-31', status: 'active' });
    expect((await charges(y.id)).map((x) => [x.period_start, x.amount])).toEqual([['2026-01-01', 12_000], ['2027-01-01', 12_000]]);
    expect((await plan(clerk, y.id)).history.map((h: any) => h.action)).toContain('retainers.auto_renewed');
  });
  it('a plan that renews itself needs a term end date', async () => {
    await expect(mk(clerk, { autoRenew: true })).rejects.toMatchObject({ status: 422 });
    await expect(mk(clerk, { amount: 0 })).rejects.toMatchObject({ status: 422 });
    await expect(mk(clerk, { endDate: '2026-01-01' })).rejects.toMatchObject({ status: 422 });
  });
});

describe('issuing, voiding and failures', () => {
  it('issues the invoices itself when the company says so', async () => {
    await asActor(w.finance, (tx) => saveSettings(tx, w.finance, { retainerIssueMode: 'issue' }));
    const p = await mk(clerk, { description: 'Hosted service', amount: 200, startDate: '2026-02-01' });
    await daily('2026-02-03');
    const c = (await charges(p.id))[0]!;
    expect(c.invoice_status).toBe('issued');
    expect(c.number).toMatch(/^INV-/);
    await asActor(w.finance, (tx) => saveSettings(tx, w.finance, { retainerIssueMode: 'draft' }));
  });
  it('a voided invoice releases its period, which the daily job does not remake but a person can', async () => {
    const p = await mk(clerk, { description: 'Monitoring', amount: 400, startDate: '2026-03-01', endDate: '2026-03-31' });
    await daily('2026-03-05');
    const c = (await charges(p.id))[0]!;
    await asActor(clerk, (tx) => voidInvoice(tx, clerk, c.invoice_id, 'Wrong customer contact'));
    expect((await charges(p.id))[0]).toMatchObject({ status: 'released' });
    expect(await daily('2026-03-06')).toMatchObject({ failed: 0 });
    expect((await plan(clerk, p.id)).due).toEqual([expect.objectContaining({ start: '2026-03-01', released: true })]);
    await expect(asActor(viewer, (tx) => generateNow(tx, viewer, blobs, p.id))).rejects.toMatchObject({ status: 403 });
    await asActor(clerk, (tx) => generateNow(tx, clerk, blobs, p.id));
    const after = await charges(p.id);
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ status: 'generated', invoice_status: 'draft' });
    expect(after[0]!.invoice_id).not.toBe(c.invoice_id);
    await expect(asActor(clerk, (tx) => generateNow(tx, clerk, blobs, p.id))).rejects.toMatchObject({ status: 422 });
  });
  it('one plan failing does not stop the others; the failure is recorded, reminded once, shown as late, and clears when fixed', async () => {
    const bad = await mk(clerk, { description: 'Will fail', amount: 100, startDate: '2026-04-01', endDate: '2026-04-30' });
    const good = await mk(clerk, { description: 'Will work', amount: 100, startDate: '2026-04-01', endDate: '2026-04-30' });
    await db().query(`UPDATE retainer_plan_amount SET amount = 99999999999 WHERE plan_id = $1`, [bad.id]); // too large for an invoice line: the database refuses it
    const r = await daily('2026-04-05');
    expect(r.failed).toBe(1);
    expect((await charges(good.id))).toHaveLength(1);
    expect((await charges(bad.id))).toHaveLength(0); // the half-made charge was rolled back with the failed invoice
    expect((await plan(clerk, bad.id)).lastError).toMatch(/overflow/);
    const first = await runReminders(w.tenantId, '2026-04-05');
    expect(first.retainer_failed).toBeGreaterThanOrEqual(1);
    expect((await runReminders(w.tenantId, '2026-04-05')).retainer_failed ?? 0).toBe(0);
    const late = await asActor(clerk, (tx) => whatIsLate(tx, clerk));
    expect(late.sections.find((s) => s.key === 'retainers')!.rows.some((x) => x.detail.includes('Scheduled invoice failed'))).toBe(true);
    await db().query(`UPDATE retainer_plan_amount SET amount = 100 WHERE plan_id = $1`, [bad.id]);
    expect(await daily('2026-04-06')).toMatchObject({ failed: 0 });
    expect(await charges(bad.id)).toHaveLength(1);
    expect((await plan(clerk, bad.id)).lastError).toBeNull();
  });
  it('the daily job runs the retainer step and repeating it makes no second invoice', async () => {
    const before = (await db().query(`SELECT count(*)::int AS n FROM retainer_charge WHERE tenant_id = $1`, [w.tenantId])).rows[0].n;
    const one = await runDailyForTenant(w.tenantId, blobs);
    const mid = (await db().query(`SELECT count(*)::int AS n FROM retainer_charge WHERE tenant_id = $1`, [w.tenantId])).rows[0].n;
    expect(one.ok).toBe(true);
    expect(one.retainers).toMatchObject({ failed: 0 });
    const two = await runDailyForTenant(w.tenantId, blobs);
    expect((await db().query(`SELECT count(*)::int AS n FROM retainer_charge WHERE tenant_id = $1`, [w.tenantId])).rows[0].n).toBe(mid);
    expect(two.retainers).toMatchObject({ generated: 0, failed: 0 });
    expect(mid).toBeGreaterThanOrEqual(before);
    const dupes = await db().query(`SELECT plan_id, period_start FROM retainer_charge WHERE tenant_id = $1 GROUP BY 1, 2 HAVING count(*) > 1`, [w.tenantId]);
    expect(dupes.rowCount).toBe(0);
  });
});

describe('a billing run can put a due retainer period on its invoice', () => {
  it('folds the period into the run once, and the daily job then finds nothing to make', async () => {
    const c2 = await customer(w, 'FOLD', 'Fold Co');
    const p = await mk(clerk, { customerId: c2, description: 'Quarterly review', amount: 1000, startDate: '2027-04-01', projectId: null });
    const rid = (await asActor(clerk, (tx) => createRun(tx, clerk, { customerId: c2, facilityId: w.facilities.A!, periodFrom: '2027-04-01', periodTo: '2027-04-30' }))).id;
    const v: any = await asActor(clerk, (tx) => getRun(tx, clerk, rid));
    const ls = v.groups.flatMap((g: any) => g.tasks.flatMap((t: any) => t.lines));
    expect(ls.map((l: any) => [l.kind, l.listAmount, l.defaultDescription])).toEqual([['retainer', 1000, 'Quarterly review, April 2027']]);
    const made = await asActor(clerk, (tx) => createDraftInvoice(tx, clerk, rid));
    const c = (await charges(p.id))[0]!;
    expect(c).toMatchObject({ status: 'generated', amount: 1000, invoice_id: made.invoiceId });
    expect((await db().query(`SELECT run_id FROM retainer_charge WHERE plan_id = $1`, [p.id])).rows[0].run_id).toBe(rid);
    await daily('2027-04-10');
    expect(await charges(p.id)).toHaveLength(1);
    await asActor(clerk, (tx) => voidInvoice(tx, clerk, made.invoiceId!, 'Re-bill with the project work'));
    expect((await charges(p.id))[0]!.status).toBe('released');
    const rid2 = (await asActor(clerk, (tx) => createRun(tx, clerk, { customerId: c2, facilityId: w.facilities.A!, periodFrom: '2027-04-01', periodTo: '2027-04-30' }))).id;
    const again: any = await asActor(clerk, (tx) => getRun(tx, clerk, rid2));
    expect(again.totals.lines).toBe(1);
  });
});

describe('renewal reminders', () => {
  it('reminds the plan owner once when the notice period begins, naming the date', async () => {
    const r = await mk(clerk, { description: 'Notice test', amount: 50, startDate: '2026-01-01', endDate: '2026-12-31', noticeDays: 45, autoRenew: true });
    expect((await runReminders(w.tenantId, '2026-10-01')).retainer_renewal ?? 0).toBe(0); // 91 days away
    const near = await runReminders(w.tenantId, '2026-11-20');
    expect(near.retainer_renewal).toBeGreaterThanOrEqual(1);
    expect((await runReminders(w.tenantId, '2026-11-25')).retainer_renewal ?? 0).toBe(0); // once per plan and end date
    const n = await db().query(`SELECT title, body FROM notification WHERE tenant_id = $1 AND kind = 'reminder.retainer_renewal' AND subject_id = $2`, [w.tenantId, r.id]);
    expect(n.rows[0].title).toContain('renews 2026-12-31');
    expect(n.rows[0].body).toContain('unless the customer gives notice');
  });
});

describe('permissions and isolation', () => {
  it('readers read, managers manage, and sites stay apart', async () => {
    const x = await mk(clerk, { description: 'Site A plan', startDate: '2027-06-01' });
    expect((await asActor(viewer, (tx) => listPlans(tx, viewer))).some((p) => p.id === x.id)).toBe(true);
    expect((await plan(viewer, x.id)).canManage).toBe(false);
    await expect(mk(viewer)).rejects.toMatchObject({ status: 403 });
    await expect(asActor(viewer, (tx) => pausePlan(tx, viewer, x.id, {}))).rejects.toMatchObject({ status: 403 });
    await expect(asActor(viewer, (tx) => updatePlan(tx, viewer, x.id, { description: 'x' }))).rejects.toMatchObject({ status: 403 });
    expect((await asActor(clerkB, (tx) => listPlans(tx, clerkB))).length).toBe(0);
    await expect(plan(clerkB, x.id)).rejects.toMatchObject({ status: 404 });
    await expect(asActor(clerkB, (tx) => cancelPlan(tx, clerkB, x.id, { effectiveOn: '2027-12-31', reason: 'nope' }))).rejects.toMatchObject({ status: 404 });
    await expect(mk(clerkB, { facilityId: w.facilities.A! })).rejects.toMatchObject({ status: 403 });
    const b = await mk(clerkB, { facilityId: w.facilities.B!, description: 'Site B plan', startDate: '2027-06-01' });
    expect((await asActor(clerkB, (tx) => listPlans(tx, clerkB))).map((p) => p.id)).toEqual([b.id]);
    const w2 = await makeWorld('ret2');
    await expect(asActor(w2.finance, (tx) => getPlan(tx, w2.finance, x.id))).rejects.toMatchObject({ status: 404 });
  });
});

describe('recurring revenue', () => {
  it('adds monthly equivalents, leaves out paused and ended plans, and measures churn over 90 days', async () => {
    const w3 = await makeWorld('mrr');
    const c = await customer(w3, 'MRRC');
    const fin = w3.finance;
    const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
    const add = async (o: { name: string; amount: number; interval: string; start: string; cancelOn?: string; status?: string; pauseFrom?: string; end?: string; auto?: boolean }) => {
      const id = (await db().query(`INSERT INTO retainer_plan (tenant_id, facility_id, number, customer_id, description, amount, billing_interval, start_date, end_date, auto_renew, status, cancel_on, created_by)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING id`, [w3.tenantId, w3.facilities.A, `M-${o.name}`, c, o.name, o.amount, o.interval, o.start, o.end ?? null, o.auto ?? false, o.status ?? 'active', o.cancelOn ?? null, fin.userId])).rows[0].id;
      await db().query(`INSERT INTO retainer_plan_amount (tenant_id, plan_id, effective_from, amount, created_by) VALUES ($1, $2, $3, $4, $5)`, [w3.tenantId, id, o.start, o.amount, fin.userId]);
      if (o.pauseFrom) await db().query(`INSERT INTO retainer_pause (tenant_id, plan_id, from_date, created_by) VALUES ($1, $2, $3, $4)`, [w3.tenantId, id, o.pauseFrom, fin.userId]);
      return id as string;
    };
    await add({ name: 'monthly', amount: 3000, interval: 'month', start: '2025-01-01' });
    await add({ name: 'quarterly', amount: 9000, interval: 'quarter', start: '2025-01-01' });
    await add({ name: 'yearly', amount: 12_000, interval: 'year', start: '2025-01-01', end: day(45), auto: true });
    await add({ name: 'paused', amount: 1000, interval: 'month', start: '2025-01-01', status: 'paused', pauseFrom: day(-10) });
    await add({ name: 'churned', amount: 2000, interval: 'month', start: '2025-01-01', status: 'cancelled', cancelOn: day(-30) });
    await add({ name: 'new', amount: 500, interval: 'month', start: day(-20) });
    const report = await asActor(fin, (tx) => getReport('recurring-revenue')!.run(tx, fin, {}));
    const k = Object.fromEntries(report.kpis.map((x) => [x.label, x.value]));
    expect(k['Monthly recurring revenue']).toBe(7500); // 3000 + 9000/3 + 12000/12 + 500; the paused and cancelled plans do not count
    expect(k['Annual recurring revenue']).toBe(90_000);
    expect(k['New (90 days)']).toBe(500);
    expect(k['Lost (90 days)']).toBe(2000);
    expect(k['Churn (90 days)']).toBeCloseTo(0.2, 6); // 2000 lost of 10000 (3000 + 3000 + 1000 + 1000 paused-later + 2000) 90 days ago
    expect(k['Paused plans']).toBe(1);
    expect(report.headline).toContain('$7,500 a month recurring');
    expect(report.rows.find((r: any) => r.plan === 'M-yearly')).toMatchObject({ renewal: 'Renews automatically', days_to_end: 45, mrr: 1000 });
    expect(report.rows.find((r: any) => r.plan === 'M-churned')).toMatchObject({ state: 'Ended', mrr: 0 });
    expect(report.charts![0]!.data).toHaveLength(6);
    expect((report.charts![0]!.data.at(-1) as any).mrr).toBe(7500);
    // The same arithmetic in every format, and the other two billing reports open for an administrator.
    for (const id of ['billing-wip', 'billing-runs']) expect((await asActor(fin, (tx) => getReport(id)!.run(tx, fin, {}))).reportId).toBe(id);
  });
});
