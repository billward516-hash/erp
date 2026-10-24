import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asActor } from '../src/platform/auth/actor.js';
import type { Actor } from '../src/platform/auth/actor.js';
import { closePools, getAdminPool } from '../src/platform/db/pool.js';
import { voidInvoice } from '../src/modules/ar/service.js';
import { addMilestone, getBillableContract, reachMilestone, reopenMilestone, setTerms } from '../src/modules/billing/contracts.js';
import { adjustLine, createDraftInvoice, createRun, getRun, holdEntry, unbilledWork } from '../src/modules/billing/service.js';
import { actorWith, customer, project } from './billing-helpers.js';
import type { World } from './fixtures.js';
import { makeWorld } from './fixtures.js';

/**
 * Fixed-price billing (SC-009): by reached milestone, or by percent complete against the contract value. The contract terms are read through
 * getBillableContract (billing/contracts.ts), the one seam to swap if the projects module keeps contract data of its own.
 */
const db = () => getAdminPool();
let w: World; let clerk: Actor; let finance: Actor; let clerkB: Actor; let cust: string; let ms: string; let pc: string;
const run = (a: Actor, input: any = {}) => asActor(a, (tx) => createRun(tx, a, { customerId: cust, periodFrom: '2026-01-01', periodTo: '2026-12-31', ...input }));
const view = (a: Actor, id: string) => asActor(a, (tx) => getRun(tx, a, id)) as Promise<any>;
const lines = (v: any) => v.groups.flatMap((g: any) => g.tasks.flatMap((t: any) => t.lines));
const contract = (a: Actor, id: string) => asActor(a, (tx) => getBillableContract(tx, a, id));

beforeAll(async () => {
  w = await makeWorld('fixed');
  clerk = await actorWith(w, 'ar_clerk', 'clerk', null);
  clerkB = await actorWith(w, 'ar_clerk', 'clerkB', w.facilities.B!);
  finance = w.finance;
  cust = await customer(w, 'FIX');
  ms = await project(w, { number: 'FP-M', name: 'Migration (milestones)', customerId: cust, billingType: 'fixed_price' });
  pc = await project(w, { number: 'FP-P', name: 'Build (percent)', customerId: cust, billingType: 'fixed_price' });
});
afterAll(async () => { await closePools(); });

describe('fixed price by milestone', () => {
  let m1: string; let m2: string;
  it('terms and milestones must fit inside the contract value', async () => {
    await expect(asActor(clerk, (tx) => addMilestone(tx, clerk, ms, { name: 'Kickoff', amount: 10 }))).rejects.toMatchObject({ status: 422 }); // no terms yet
    await asActor(clerk, (tx) => setTerms(tx, clerk, ms, { contractValue: 50_000, method: 'milestone' }));
    m1 = (await asActor(clerk, (tx) => addMilestone(tx, clerk, ms, { name: 'Design signed off', amount: 20_000, dueDate: '2026-03-31' }))).id;
    m2 = (await asActor(clerk, (tx) => addMilestone(tx, clerk, ms, { name: 'Go-live', amount: 30_000 }))).id;
    await expect(asActor(clerk, (tx) => addMilestone(tx, clerk, ms, { name: 'Extra', amount: 1 }))).rejects.toMatchObject({ status: 422 });
    await expect(asActor(clerk, (tx) => setTerms(tx, clerk, ms, { contractValue: 40_000, method: 'milestone' }))).rejects.toMatchObject({ status: 422 });
    const c = await contract(clerk, ms);
    expect(c).toMatchObject({ contractValue: 50_000, method: 'milestone', earned: 0, billed: 0, unbilledEarned: 0, remaining: 50_000 });
    expect(c.milestones.map((m) => [m.name, m.amount, m.status])).toEqual([['Design signed off', 20_000, 'pending'], ['Go-live', 30_000, 'pending']]);
  });
  it('only a reached milestone is billed, once', async () => {
    const before = await view(clerk, (await run(clerk)).id);
    expect(before.totals.lines).toBe(0);
    await asActor(clerk, (tx) => reachMilestone(tx, clerk, m1, { reachedOn: '2026-03-30' }));
    expect(await contract(clerk, ms)).toMatchObject({ earned: 20_000, unbilledEarned: 20_000, remaining: 30_000 });
    const rid = (await run(clerk)).id;
    const v = await view(clerk, rid);
    expect(lines(v).map((l: any) => [l.kind, l.projectNumber, l.listAmount, l.defaultDescription])).toEqual([['milestone', 'FP-M', 20_000, 'FP-M milestone: Design signed off (reached 2026-03-30)']]);
    const made = await asActor(clerk, (tx) => createDraftInvoice(tx, clerk, rid));
    const ln = (await db().query(`SELECT milestone_id, project_id, qty, unit_price FROM customer_invoice_line WHERE invoice_id = $1`, [made.invoiceId])).rows;
    expect(ln).toHaveLength(1);
    expect(ln[0]).toMatchObject({ milestone_id: m1, project_id: ms });
    expect(Number(ln[0].qty) * Number(ln[0].unit_price)).toBe(20_000);
    expect(await contract(clerk, ms)).toMatchObject({ billed: 20_000, unbilledEarned: 0 });
    expect((await view(clerk, (await run(clerk)).id)).totals.lines).toBe(0); // not again
    await expect(asActor(clerk, (tx) => reopenMilestone(tx, clerk, m1, 'Mistake'))).rejects.toMatchObject({ status: 409 }); // billed
    await asActor(clerk, (tx) => voidInvoice(tx, clerk, made.invoiceId!, 'Customer disputes sign-off'));
    expect(await contract(clerk, ms)).toMatchObject({ billed: 0, unbilledEarned: 20_000 });
    expect((await view(clerk, (await run(clerk)).id)).totals.lines).toBe(1); // released by the void
  });
  it('a milestone can be held and written down, with the reason kept', async () => {
    await asActor(clerk, (tx) => holdEntry(tx, clerk, { kind: 'milestone', sourceId: m1, reason: 'Waiting for the customer purchase order' }));
    expect((await contract(clerk, ms)).milestones[0]).toMatchObject({ held: true, holdReason: 'Waiting for the customer purchase order' });
    const rid = (await run(clerk)).id;
    expect((await view(clerk, rid)).totals).toMatchObject({ lines: 0, heldCount: 1, heldValue: 20_000 });
    await db().query(`DELETE FROM billing_hold WHERE source_id = $1`, [m1]);
    await asActor(finance, (tx) => adjustLine(tx, finance, rid, { key: `milestone:${m1}`, writedown: 1000, reason: 'Late by two weeks; credit agreed' }));
    const made = await asActor(clerk, (tx) => createDraftInvoice(tx, clerk, rid));
    expect(made.net).toBe(19_000);
    expect(await contract(clerk, ms)).toMatchObject({ billed: 19_000, writtenOff: 0 });
  });
  it('a milestone cannot be marked reached twice', async () => {
    await expect(asActor(clerk, (tx) => reachMilestone(tx, clerk, m1, { reachedOn: '2026-04-01' }))).rejects.toMatchObject({ status: 409 });
    await asActor(clerk, (tx) => reachMilestone(tx, clerk, m2, { reachedOn: '2026-06-30' }));
    await asActor(clerk, (tx) => reopenMilestone(tx, clerk, m2, 'Reached in error'));
    expect((await contract(clerk, ms)).milestones[1]!.status).toBe('pending');
  });
});

describe('fixed price by percent complete', () => {
  it('bills the earned share of the contract, less what was billed before', async () => {
    await asActor(clerk, (tx) => setTerms(tx, clerk, pc, { contractValue: 40_000, method: 'percent_complete', percentComplete: 25 }));
    expect(await contract(clerk, pc)).toMatchObject({ earned: 10_000, unbilledEarned: 10_000, remaining: 30_000, percentComplete: 25 });
    const r1 = (await run(clerk, { projectId: pc })).id;
    const v1 = await view(clerk, r1);
    expect(lines(v1)[0]).toMatchObject({ kind: 'percent', listAmount: 10_000, defaultDescription: 'FP-P Build (percent): 25% complete of 40000.00 contract' });
    const made1 = await asActor(clerk, (tx) => createDraftInvoice(tx, clerk, r1));
    expect(made1.net).toBe(10_000);
    expect((await view(clerk, (await run(clerk, { projectId: pc })).id)).totals.lines).toBe(0);
    // Progress to 60%: 24,000 earned, 10,000 already billed, 14,000 now.
    await asActor(clerk, (tx) => setTerms(tx, clerk, pc, { contractValue: 40_000, method: 'percent_complete', percentComplete: 60 }));
    const r2 = (await run(clerk, { projectId: pc })).id;
    const v2 = await view(clerk, r2);
    expect(lines(v2)[0]).toMatchObject({ listAmount: 14_000, defaultDescription: 'FP-P Build (percent): 60% complete of 40000.00 contract, less 10000.00 billed earlier' });
    const made2 = await asActor(clerk, (tx) => createDraftInvoice(tx, clerk, r2));
    expect(made2.net).toBe(14_000);
    expect(await contract(clerk, pc)).toMatchObject({ billed: 24_000, earned: 24_000, unbilledEarned: 0 });
  });
  it('percent complete cannot go below what has been billed, and the contract value cannot drop below it', async () => {
    await expect(asActor(clerk, (tx) => setTerms(tx, clerk, pc, { contractValue: 40_000, method: 'percent_complete', percentComplete: 50 }))).rejects.toMatchObject({ status: 422 });
    await expect(asActor(clerk, (tx) => setTerms(tx, clerk, pc, { contractValue: 20_000, method: 'percent_complete', percentComplete: 60 }))).rejects.toMatchObject({ status: 422 });
    await expect(asActor(clerk, (tx) => setTerms(tx, clerk, pc, { contractValue: 40_000, method: 'milestone' }))).rejects.toMatchObject({ status: 409 });
    await expect(asActor(clerk, (tx) => setTerms(tx, clerk, pc, { contractValue: 40_000, method: 'percent_complete', percentComplete: 101 }))).rejects.toMatchObject({ status: 422 });
  });
  it('voiding the latest invoice releases only its share; a write-off of a percent step is final until reversed', async () => {
    const inv = (await db().query(`SELECT invoice_id FROM billing_claim WHERE project_id = $1 AND source_kind = 'percent' AND released_at IS NULL ORDER BY claimed_at DESC LIMIT 1`, [pc])).rows[0].invoice_id;
    await asActor(clerk, (tx) => voidInvoice(tx, clerk, inv, 'Billed ahead of acceptance'));
    expect(await contract(clerk, pc)).toMatchObject({ billed: 10_000, unbilledEarned: 14_000 });
    const rid = (await run(clerk, { projectId: pc })).id;
    await asActor(finance, (tx) => adjustLine(tx, finance, rid, { key: `percent:${pc}`, writeOff: true, reason: 'Absorbed as a goodwill concession' }));
    await asActor(clerk, (tx) => createDraftInvoice(tx, clerk, rid)); // only a write-off: the run closes with no invoice
    const closed = await view(clerk, rid);
    expect(closed).toMatchObject({ status: 'closed', invoiceId: null, outcome: { billed: 0, writtenOff: 14_000 } });
    expect(await contract(clerk, pc)).toMatchObject({ billed: 10_000, writtenOff: 14_000, unbilledEarned: 0 });
    expect((await view(clerk, (await run(clerk, { projectId: pc })).id)).totals.lines).toBe(0);
  });
});

describe('the report of unbilled work and billed against contract', () => {
  it('shows billed against contract value for fixed-price projects', async () => {
    const r = await asActor(clerk, (tx) => unbilledWork(tx, clerk, { customerId: cust }));
    const row = r.rows.find((x) => x.number === 'FP-P')!;
    expect(row).toMatchObject({ contractValue: 40_000, billedToDate: 10_000, total: 0 });
    const m = r.rows.find((x) => x.number === 'FP-M')!;
    expect(m).toMatchObject({ contractValue: 50_000, billedToDate: 19_000, milestoneValue: 0 });
  });
  it('is limited to the sites the person works at, and a fixed-price project at another site is invisible', async () => {
    await expect(asActor(clerkB, (tx) => getBillableContract(tx, clerkB, ms))).rejects.toMatchObject({ status: 404 });
    await expect(asActor(clerkB, (tx) => setTerms(tx, clerkB, ms, { contractValue: 1, method: 'milestone' }))).rejects.toMatchObject({ status: 404 });
    expect((await asActor(clerkB, (tx) => unbilledWork(tx, clerkB, {}))).rows).toEqual([]);
  });
});
