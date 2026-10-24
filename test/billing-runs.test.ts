import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asActor, loadActor } from '../src/platform/auth/actor.js';
import type { Actor } from '../src/platform/auth/actor.js';
import { closePools, getAdminPool } from '../src/platform/db/pool.js';
import { many, one } from '../src/platform/db/tx.js';
import { LocalBlobStore } from '../src/platform/storage/blob-store.js';
import { amounts, issueInvoice, updateDraft, voidInvoice } from '../src/modules/ar/service.js';
import { saveSettings } from '../src/modules/billing/rates.js';
import { adjustLine, cancelRun, createDraftInvoice, createRun, getRun, holdEntry, listRuns, releaseHold, restoreWriteOff, unbilledWork } from '../src/modules/billing/service.js';
import { runReminders } from '../src/modules/notifications/reminders.js';
import { whatIsLate } from '../src/modules/late/service.js';
import { weekStartOf } from '../src/modules/time/service.js';
import { actorWith, customer, employee, project, rate, task, week } from './billing-helpers.js';
import type { World } from './fixtures.js';
import { makeWorld } from './fixtures.js';

const blobs = new LocalBlobStore('./.storage/test');
const db = () => getAdminPool();
let w: World; let clerk: Actor; let clerkB: Actor; let viewer: Actor; let finance: Actor;
let acme: string; let other: string; let p1: string; let p2: string; let design: string; let build: string; let ann: string; let bob: string;
let ids: Record<string, string> = {};

const run = (a: Actor, input: any) => asActor(a, (tx) => createRun(tx, a, { customerId: acme, periodFrom: '2026-09-01', periodTo: '2026-09-30', ...input }));
const view = (a: Actor, id: string) => asActor(a, (tx) => getRun(tx, a, id)) as Promise<any>;
const lines = (v: any) => v.groups.flatMap((g: any) => g.tasks.flatMap((t: any) => t.lines));
const invoice = (a: Actor, id: string) => asActor(a, (tx) => createDraftInvoice(tx, a, id));

beforeAll(async () => {
  w = await makeWorld('brun');
  clerk = await actorWith(w, 'ar_clerk', 'clerk', null);
  clerkB = await actorWith(w, 'ar_clerk', 'clerkB', w.facilities.B!);
  viewer = await actorWith(w, 'executive', 'viewer', null);
  finance = w.finance;
  acme = await customer(w, 'ACME'); other = await customer(w, 'OTHER');
  p1 = await project(w, { number: 'P-1', name: 'Platform review', customerId: acme });
  p2 = await project(w, { number: 'P-2', name: 'Data audit', customerId: acme });
  design = await task(w, p1, 'Design', 1); build = await task(w, p1, 'Build', 2);
  ann = await employee(w, 'E300', 'Ann', 'Lee', 'Consultant'); bob = await employee(w, 'E301', 'Bob', 'Kim', 'Analyst');
  await rate(w, { scope: 'default', amount: 100 });
  await rate(w, { scope: 'role', role: 'Consultant', amount: 150 });
  const pf = await project(w, { number: 'PF-1', name: 'Fixed scope', customerId: acme, billingType: 'fixed_price' });
  ids.pf = pf;
  // Week of 2026-09-07: approved. Ann (150/h) and Bob (100/h).
  const a = await week(w, ann, '2026-09-07', [{ date: '2026-09-07', hours: 4, projectId: p1, taskId: design, note: 'kickoff' }, { date: '2026-09-08', hours: 2.5, projectId: p1, taskId: build },
    { date: '2026-09-09', hours: 1, projectId: p1, taskId: build, billable: false, note: 'internal' }, { date: '2026-09-10', hours: 6, projectId: pf }]);
  const b = await week(w, bob, '2026-09-07', [{ date: '2026-09-08', hours: 8, projectId: p1, taskId: design }, { date: '2026-09-09', hours: 3, projectId: p2 }]);
  ids = { ...ids, annDesign: a[0]!, annBuild: a[1]!, annNonBill: a[2]!, annFixed: a[3]!, bobDesign: b[0]!, bobP2: b[1]! };
  // Not approved, and outside the period: never offered.
  await week(w, ann, '2026-09-14', [{ date: '2026-09-14', hours: 5, projectId: p1 }], 'draft');
  await week(w, bob, '2026-09-14', [{ date: '2026-09-15', hours: 5, projectId: p1 }], 'submitted');
  await week(w, bob, '2026-08-31', [{ date: '2026-08-31', hours: 2, projectId: p1 }]);
});
afterAll(async () => { await closePools(); });

describe('a billing run lists what is approved, billable and unbilled', () => {
  it('prices approved billable time at the resolved rate and explains each rate', async () => {
    const { id } = await run(clerk, {});
    const v = await view(clerk, id);
    expect(lines(v).map((l: any) => [l.projectNumber, l.taskName, l.who, l.hours, l.unitPrice, l.listAmount])).toEqual([
      ['P-1', 'Design', 'Ann Lee', 4, 150, 600], ['P-1', 'Design', 'Bob Kim', 8, 100, 800], ['P-1', 'Build', 'Ann Lee', 2.5, 150, 375], ['P-2', null, 'Bob Kim', 3, 100, 300]]);
    expect(lines(v)[0].rateWhy).toContain('Role rate (Consultant), 150.00 an hour');
    expect(lines(v)[1].rateWhy).toContain('Company default rate');
    expect(v.totals).toMatchObject({ lines: 4, hours: 17.5, list: 2075, net: 2075, writedown: 0 });
    expect(v.groups.map((g: any) => [g.projectNumber, g.subtotal])).toEqual([['P-1', 1775], ['P-2', 300]]);
    expect(v.groups[0].tasks.map((t: any) => [t.taskName, t.subtotal])).toEqual([['Design', 1400], ['Build', 375]]);
    // Hours on a fixed-price project are covered by the contract and say so; the non-billable and unapproved entries are absent.
    expect(v.excluded).toEqual([{ reason: 'Fixed-price project: hours are covered by the contract price', entries: 1, hours: 6 }]);
  });
  it('a run for one project lists only that project', async () => {
    const { id } = await run(clerk, { projectId: p2 });
    const v = await view(clerk, id);
    expect(v.totals).toMatchObject({ lines: 1, net: 300 });
  });
  it('a project with a customer rate beats person and role rates in the run', async () => {
    await rate(w, { scope: 'customer', customerId: other, amount: 90 });
    const op = await project(w, { number: 'O-1', customerId: other });
    await week(w, ann, '2026-09-21', [{ date: '2026-09-21', hours: 2, projectId: op }]);
    const { id } = await asActor(clerk, (tx) => createRun(tx, clerk, { customerId: other, periodFrom: '2026-09-01', periodTo: '2026-09-30' }));
    const v = await view(clerk, id);
    expect(lines(v)[0]).toMatchObject({ unitPrice: 90, listAmount: 180 });
    expect(lines(v)[0].rateWhy).toContain('Customer rate (Customer OTHER)');
  });
  it('rounds hours to the nearest quarter hour when the company turns that on', async () => {
    const rc = await customer(w, 'ROUND');
    const rp = await project(w, { number: 'RD-1', customerId: rc });
    await week(w, bob, '2026-09-28', [{ date: '2026-09-28', hours: 1.1, projectId: rp }, { date: '2026-09-29', hours: 0.05, projectId: rp }]);
    const mk = async () => lines(await view(clerk, (await asActor(clerk, (tx) => createRun(tx, clerk, { customerId: rc, periodFrom: '2026-09-01', periodTo: '2026-09-30' }))).id));
    expect((await mk()).map((l: any) => [l.hours, l.listAmount])).toEqual([[1.1, 110], [0.05, 5]]); // off by default
    await asActor(finance, (tx) => saveSettings(tx, finance, { roundHoursTo: 0.25 }));
    expect((await mk()).map((l: any) => [l.recordedHours, l.hours, l.listAmount])).toEqual([[1.1, 1, 100], [0.05, 0.25, 25]]);
    await asActor(finance, (tx) => saveSettings(tx, finance, { roundHoursTo: null }));
    expect((await mk()).map((l: any) => l.hours)).toEqual([1.1, 0.05]);
    // The approved week is frozen: the hours themselves cannot be changed under a billing run.
    await expect(db().query(`UPDATE time_entry SET hours = 2 WHERE project_id = $1`, [rp])).rejects.toThrow(/cannot change/);
  });
});

describe('holds, edits, write-downs and write-offs', () => {
  let runId: string;
  beforeAll(async () => { runId = (await run(clerk, {})).id; });
  it('a held entry stays out of the totals until released', async () => {
    await asActor(clerk, (tx) => holdEntry(tx, clerk, { kind: 'time', sourceId: ids.bobP2!, reason: 'Customer disputes the hours' }));
    let v = await view(clerk, runId);
    expect(v.totals).toMatchObject({ lines: 3, net: 1775, heldCount: 1, heldValue: 300 });
    expect(lines(v).find((l: any) => l.held)).toMatchObject({ status: 'held', holdReason: 'Customer disputes the hours' });
    await expect(asActor(clerk, (tx) => holdEntry(tx, clerk, { kind: 'time', sourceId: ids.bobP2!, reason: 'again' }))).rejects.toMatchObject({ status: 409 });
    await asActor(clerk, (tx) => releaseHold(tx, clerk, { kind: 'time', sourceId: ids.bobP2! }));
    v = await view(clerk, runId);
    expect(v.totals).toMatchObject({ lines: 4, net: 2075, heldCount: 0 });
  });
  it('a description can be rewritten by billing staff', async () => {
    await asActor(clerk, (tx) => adjustLine(tx, clerk, runId, { key: `time:${ids.annDesign}`, description: 'Kickoff workshop with the steering group' }));
    const v = await view(clerk, runId);
    expect(lines(v)[0]).toMatchObject({ description: 'Kickoff workshop with the steering group', customDescription: 'Kickoff workshop with the steering group' });
  });
  it('a write-down needs the permission and a reason, lowers the total and is audited', async () => {
    const key = `time:${ids.bobDesign}`;
    await expect(asActor(clerk, (tx) => adjustLine(tx, clerk, runId, { key, writedown: 100, reason: 'Goodwill' }))).rejects.toMatchObject({ status: 403 });
    await expect(asActor(finance, (tx) => adjustLine(tx, finance, runId, { key, writedown: 100 }))).rejects.toMatchObject({ status: 422 });
    await expect(asActor(finance, (tx) => adjustLine(tx, finance, runId, { key, writedown: 800, reason: 'All of it' }))).rejects.toMatchObject({ status: 422 });
    await asActor(finance, (tx) => adjustLine(tx, finance, runId, { key, writedown: 100, reason: 'Goodwill: learning curve on the first day' }));
    const v = await view(clerk, runId);
    expect(lines(v).find((l: any) => l.key === key)).toMatchObject({ writedown: 100, net: 700, adjustReason: 'Goodwill: learning curve on the first day', status: 'billable' });
    expect(v.totals).toMatchObject({ list: 2075, writedown: 100, net: 1975 });
    const ev = await db().query(`SELECT data, actor_user_id FROM audit_event WHERE tenant_id = $1 AND action = 'billing.writedown' AND entity_id = $2`, [w.tenantId, runId]);
    expect(ev.rows).toHaveLength(1);
    expect(ev.rows[0]).toMatchObject({ actor_user_id: finance.userId, data: { key, listAmount: 800, writedown: 100, reason: 'Goodwill: learning curve on the first day' } });
    // Editing only the description later must not remove or re-audit the write-down.
    await asActor(clerk, (tx) => adjustLine(tx, clerk, runId, { key, description: 'Design workshops' }));
    expect(lines(await view(clerk, runId)).find((l: any) => l.key === key)).toMatchObject({ writedown: 100, description: 'Design workshops' });
  });
  it('a write-off removes the line from the invoice, needs the permission and a reason, and can be reversed', async () => {
    const key = `time:${ids.bobP2}`;
    await expect(asActor(clerk, (tx) => adjustLine(tx, clerk, runId, { key, writeOff: true, reason: 'Not collectable' }))).rejects.toMatchObject({ status: 403 });
    await asActor(finance, (tx) => adjustLine(tx, finance, runId, { key, writeOff: true, reason: 'Not collectable; partner agreed' }));
    const v = await view(clerk, runId);
    expect(lines(v).find((l: any) => l.key === key)).toMatchObject({ status: 'written_off', net: 0 });
    expect(v.totals).toMatchObject({ lines: 3, net: 1675, writtenOff: 300, writtenOffCount: 1 });
    expect((await db().query(`SELECT 1 FROM audit_event WHERE tenant_id = $1 AND action = 'billing.writeoff' AND entity_id = $2`, [w.tenantId, runId])).rowCount).toBe(1);
  });
  it('creating the draft invoice stamps every source, tags the lines and keeps the total', async () => {
    const r = await invoice(clerk, runId);
    expect(r).toMatchObject({ lines: 3, net: 1675, writtenOff: 300 });
    const inv = await db().query(`SELECT * FROM customer_invoice WHERE id = $1`, [r.invoiceId]);
    expect(inv.rows[0]).toMatchObject({ status: 'draft', customer_id: acme, number: null });
    const a = await asActor(clerk, (tx) => amounts(tx, r.invoiceId!));
    expect(a.subtotal).toBe(1675);
    const ls = (await db().query(`SELECT * FROM customer_invoice_line WHERE invoice_id = $1 ORDER BY line_no`, [r.invoiceId])).rows;
    expect(ls.map((l) => [l.description, Number(l.qty), Number(l.unit_price), l.time_entry_id === ids.annDesign || l.time_entry_id === ids.bobDesign || l.time_entry_id === ids.annBuild, l.billing_run_id === runId, l.project_id === p1])).toEqual([
      ['Kickoff workshop with the steering group', 4, 150, true, true, true], ['Design workshops', 8, 87.5, true, true, true], ['P-1 / Build: Ann Lee, 2026-09-08', 2.5, 150, true, true, true]]);
    const claims = (await db().query(`SELECT source_kind, status, list_amount, writedown, amount FROM billing_claim WHERE run_id = $1 AND released_at IS NULL ORDER BY status, list_amount`, [runId])).rows;
    expect(claims.map((c) => [c.status, Number(c.list_amount), Number(c.writedown), Number(c.amount)])).toEqual([['billed', 375, 0, 375], ['billed', 600, 0, 600], ['billed', 800, 100, 700], ['written_off', 300, 300, 0]]);
    const after = await view(clerk, runId);
    expect(after).toMatchObject({ status: 'invoiced', invoiceId: r.invoiceId, outcome: { billed: 1675, lines: 3, writtenDown: 100, writtenOff: 300 } });
  });
  it('the work cannot be billed twice: a second run finds nothing, and the same run cannot be invoiced again', async () => {
    const second = await run(clerk, {});
    const v = await view(clerk, second.id);
    expect(v.totals.lines).toBe(0);
    await expect(invoice(clerk, second.id)).rejects.toMatchObject({ status: 422 });
    await expect(invoice(clerk, runId)).rejects.toMatchObject({ status: 409 });
  });
  it('two runs opened together cannot both bill the same entries', async () => {
    const o = await customer(w, 'RACE');
    const rp = await project(w, { number: 'R-1', customerId: o });
    await week(w, bob, '2026-09-21', [{ date: '2026-09-22', hours: 1, projectId: rp }]);
    const a = await asActor(clerk, (tx) => createRun(tx, clerk, { customerId: o, periodFrom: '2026-09-01', periodTo: '2026-09-30' }));
    const b = await asActor(clerk, (tx) => createRun(tx, clerk, { customerId: o, periodFrom: '2026-09-01', periodTo: '2026-09-30' }));
    await invoice(clerk, a.id);
    await expect(invoice(clerk, b.id)).rejects.toMatchObject({ status: 422 }); // b is recomputed at the moment of billing: nothing left
    const dup = await db().query(`INSERT INTO billing_claim (tenant_id, source_kind, source_id, status, list_amount, amount, claimed_by, invoice_id) SELECT $1, 'time', time_entry_id, 'billed', 1, 1, $2, invoice_id FROM customer_invoice_line WHERE time_entry_id IS NOT NULL AND project_id = $3`,
      [w.tenantId, w.admin.userId, rp]).catch((e) => e);
    expect(String(dup.message ?? dup)).toMatch(/billing_claim_live_source/); // the database itself refuses a second live claim on one entry
  });
  it('a billed line cannot be edited on the invoice, but removing it releases its work', async () => {
    const r = (await db().query(`SELECT invoice_id FROM billing_run WHERE id = $1`, [runId])).rows[0];
    const line = (await db().query(`SELECT id, time_entry_id FROM customer_invoice_line WHERE invoice_id = $1 ORDER BY line_no LIMIT 1`, [r.invoice_id])).rows[0];
    await expect(asActor(clerk, (tx) => updateDraft(tx, clerk, r.invoice_id, { lines: [{ lineId: line.id, qty: 3 }] }))).rejects.toThrow(/came from billing/);
    await asActor(clerk, (tx) => updateDraft(tx, clerk, r.invoice_id, { lines: [{ lineId: line.id, qty: 0 }] }));
    const claim = (await db().query(`SELECT released_at, release_reason FROM billing_claim WHERE source_kind = 'time' AND source_id = $1 ORDER BY claimed_at`, [line.time_entry_id])).rows;
    expect(claim[0].released_at).not.toBeNull();
    const next = await view(clerk, (await run(clerk, {})).id);
    expect(lines(next).map((l: any) => l.sourceId)).toEqual([line.time_entry_id]);
  });
  it('voiding the invoice releases everything it billed and reopens the run; write-offs stay until reversed', async () => {
    const r = (await db().query(`SELECT invoice_id FROM billing_run WHERE id = $1`, [runId])).rows[0];
    await asActor(clerk, (tx) => voidInvoice(tx, clerk, r.invoice_id, 'Customer asked for a different split'));
    const run1 = await db().query(`SELECT status, invoice_id FROM billing_run WHERE id = $1`, [runId]);
    expect(run1.rows[0]).toMatchObject({ status: 'open', invoice_id: null });
    const v = await view(clerk, (await run(clerk, {})).id);
    expect(lines(v).map((l: any) => l.sourceId).sort()).toEqual([ids.annDesign, ids.annBuild, ids.bobDesign].sort());
    expect((await db().query(`SELECT count(*)::int AS n FROM billing_claim WHERE run_id = $1 AND released_at IS NULL AND status = 'written_off'`, [runId])).rows[0].n).toBe(1);
    // The reopened run still carries its edits (the description and the write-down).
    const again = await view(clerk, runId);
    expect(lines(again).find((l: any) => l.sourceId === ids.bobDesign)).toMatchObject({ writedown: 100 });
    // Reversing the write-off needs the write-off permission.
    await expect(asActor(clerk, (tx) => restoreWriteOff(tx, clerk, { kind: 'time', sourceId: ids.bobP2!, reason: 'Collected after all' }))).rejects.toMatchObject({ status: 403 });
    await asActor(finance, (tx) => restoreWriteOff(tx, finance, { kind: 'time', sourceId: ids.bobP2!, reason: 'Collected after all' }));
    expect((await db().query(`SELECT 1 FROM audit_event WHERE tenant_id = $1 AND action = 'billing.writeoff_reversed'`, [w.tenantId])).rowCount).toBe(1);
  });
  it('an issued invoice made from a run takes its number and PDF as any invoice does, and voiding it still releases the work', async () => {
    const o = await customer(w, 'ISSUE');
    const ip = await project(w, { number: 'I-1', customerId: o });
    const [e] = await week(w, bob, '2026-10-05', [{ date: '2026-10-06', hours: 2, projectId: ip }]);
    const rid = (await asActor(clerk, (tx) => createRun(tx, clerk, { customerId: o, periodFrom: '2026-10-01', periodTo: '2026-10-31' }))).id;
    const made = await invoice(clerk, rid);
    const out = await asActor(clerk, (tx) => issueInvoice(tx, clerk, blobs, made.invoiceId!));
    expect(out.number).toMatch(/^INV-/);
    expect(out.total).toBe(200);
    expect((await db().query(`SELECT 1 FROM outbox_event WHERE tenant_id = $1 AND topic = 'ar.invoice.issued' AND aggregate_id = $2`, [w.tenantId, made.invoiceId])).rowCount).toBe(1);
    await asActor(clerk, (tx) => voidInvoice(tx, clerk, made.invoiceId!, 'Issued by mistake'));
    expect((await db().query(`SELECT released_at FROM billing_claim WHERE source_id = $1`, [e])).rows[0].released_at).not.toBeNull();
  });
  it('cancelling an open run bills nothing and frees nothing it does not own', async () => {
    const x = await run(clerk, { projectId: p2 });
    await asActor(clerk, (tx) => cancelRun(tx, clerk, x.id, 'Wrong period'));
    expect((await view(clerk, x.id)).status).toBe('cancelled');
    await expect(invoice(clerk, x.id)).rejects.toMatchObject({ status: 409 });
  });
});

describe('who may do what, and where', () => {
  it('a reader sees runs but cannot prepare them; billing staff at another site see nothing of this site', async () => {
    const { id } = await run(clerk, {});
    expect((await view(viewer, id)).canManage).toBe(false);
    await expect(run(viewer, {})).rejects.toMatchObject({ status: 403 });
    await expect(asActor(viewer, (tx) => holdEntry(tx, viewer, { kind: 'time', sourceId: ids.annDesign!, reason: 'because' }))).rejects.toMatchObject({ status: 403 });
    await expect(asActor(viewer, (tx) => createDraftInvoice(tx, viewer, id))).rejects.toMatchObject({ status: 403 });
    await expect(view(clerkB, id)).rejects.toMatchObject({ status: 404 });
    expect((await asActor(clerkB, (tx) => listRuns(tx, clerkB))).length).toBe(0);
    await expect(asActor(clerkB, (tx) => createRun(tx, clerkB, { customerId: acme, projectId: p1, periodFrom: '2026-09-01', periodTo: '2026-09-30' }))).rejects.toMatchObject({ status: 404 });
    await expect(asActor(clerkB, (tx) => holdEntry(tx, clerkB, { kind: 'time', sourceId: ids.annDesign!, reason: 'because' }))).rejects.toMatchObject({ status: 404 });
    const w2 = await makeWorld('brun2');
    await expect(asActor(w2.finance, (tx) => getRun(tx, w2.finance, id))).rejects.toMatchObject({ status: 404 });
  });
  it('billing needs receivables authority to make the invoice', async () => {
    const billingOnly = await actorWith(w, 'executive', 'billingOnly', null);
    await db().query(`UPDATE role SET permissions = permissions || ARRAY['billing.manage'] WHERE tenant_id = $1 AND key = 'executive'`, [w.tenantId]);
    const a = await loadActor(w.tenantId, billingOnly.userId);
    const { id } = await asActor(a!, (tx) => createRun(tx, a!, { customerId: acme, periodFrom: '2026-09-01', periodTo: '2026-09-30' }));
    await expect(asActor(a!, (tx) => createDraftInvoice(tx, a!, id))).rejects.toMatchObject({ status: 403 });
    await db().query(`UPDATE role SET permissions = array_remove(permissions, 'billing.manage') WHERE tenant_id = $1 AND key = 'executive'`, [w.tenantId]);
  });
});

describe('unbilled work', () => {
  it('totals what is waiting by project, with held and unrated work apart', async () => {
    const cx = await customer(w, 'WIP');
    const wp = await project(w, { number: 'W-1', customerId: cx });
    const [e1] = await week(w, ann, '2026-09-28', [{ date: '2026-09-28', hours: 3, projectId: wp }, { date: '2026-09-29', hours: 1, projectId: wp }]);
    await asActor(clerk, (tx) => holdEntry(tx, clerk, { kind: 'time', sourceId: e1!, reason: 'Waiting for the purchase order' }));
    const r = await asActor(clerk, (tx) => unbilledWork(tx, clerk, { customerId: cx }));
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]).toMatchObject({ number: 'W-1', timeHours: 1, timeValue: 150, total: 150, heldValue: 450, oldest: '2026-09-29' });
    expect(r.totals).toMatchObject({ total: 150, hours: 1, held: 450 });
    expect(r.expenseColumns).toBe(true);
    await expect(asActor(clerkB, (tx) => unbilledWork(tx, clerkB, { customerId: cx }))).resolves.toMatchObject({ rows: [] });
  });
  it('reminds billing staff once about work waiting longer than the lead, and lists it in What is late', async () => {
    const first = await runReminders(w.tenantId, '2026-10-24');
    expect(first.unbilled_time).toBeGreaterThanOrEqual(1);
    const again = await runReminders(w.tenantId, '2026-10-24');
    expect(again.unbilled_time ?? 0).toBe(0);
    const n = await db().query(`SELECT title FROM notification WHERE tenant_id = $1 AND kind = 'reminder.unbilled_time'`, [w.tenantId]);
    expect(n.rows[0].title).toMatch(/approved items? at A waiting more than 30 days to be billed/);
    // What is late uses the real calendar: add work that is 45 days old today.
    const old = new Date(Date.now() - 45 * 86_400_000).toISOString().slice(0, 10);
    const lp = await project(w, { number: 'L-1', customerId: await customer(w, 'LATE'), ownerUserId: finance.userId });
    const cy = await employee(w, 'E399', 'Cy', 'Late', 'Analyst');
    await week(w, cy, weekStartOf(old), [{ date: old, hours: 2, projectId: lp }]);
    const late = await asActor(clerk, (tx) => whatIsLate(tx, clerk));
    const sec = late.sections.find((s) => s.key === 'unbilled');
    expect(sec).toBeTruthy();
    expect(sec!.rows.find((r) => r.label.startsWith('L-1'))).toMatchObject({ amount: 200, owner: 'finance' });
  });
});

describe('the expense lines adapter', () => {
  it('reads approved billable ones', async () => {
    const { forgetExpenseColumns } = await import('../src/modules/billing/sources.js');
    const ex = await customer(w, 'EXP');
    const xp = await project(w, { number: 'X-1', customerId: ex });
    forgetExpenseColumns();
    const before = await view(clerk, (await asActor(clerk, (tx) => createRun(tx, clerk, { customerId: ex, periodFrom: '2026-09-01', periodTo: '2026-09-30' }))).id);
    expect(before.expenseColumns).toBe(true);
    expect(before.totals.lines).toBe(0);
    await db().query('ALTER TABLE expense_line ADD COLUMN IF NOT EXISTS project_id uuid REFERENCES project(id), ADD COLUMN IF NOT EXISTS billable boolean NOT NULL DEFAULT false');
    forgetExpenseColumns();
    try {
      await db().query(`INSERT INTO expense_category (tenant_id, code, name) VALUES ($1, 'TESTX', 'Test travel') ON CONFLICT DO NOTHING`, [w.tenantId]);
      const cat = (await db().query(`SELECT id FROM expense_category WHERE tenant_id = $1 LIMIT 1`, [w.tenantId])).rows[0].id;
      const mk = async (status: string, billable: boolean, amount: number, n: string) => {
        const rep = (await db().query(`INSERT INTO expense_report (tenant_id, facility_id, number, user_id, title, status) VALUES ($1, $2, $3, $4, 'Trip', 'draft') RETURNING id`, [w.tenantId, w.facilities.A, n, w.admin.userId])).rows[0].id;
        const line = (await db().query(`INSERT INTO expense_line (tenant_id, report_id, line_no, spent_on, category_id, merchant, amount, project_id, billable) VALUES ($1, $2, 1, '2026-09-10', $3, 'Rail', $4, $5, $6) RETURNING id`,
          [w.tenantId, rep, cat, amount, xp, billable])).rows[0].id;
        await db().query(`UPDATE expense_report SET status = $2, paid_on = CASE WHEN $2 = 'paid' THEN current_date END, paid_by = CASE WHEN $2 = 'paid' THEN $3::uuid END, payment_method = CASE WHEN $2 = 'paid' THEN 'payroll' END WHERE id = $1`, [rep, status, w.admin.userId]);
        return line as string;
      };
      const ok = await mk('approved', true, 84.5, 'XR-1');
      await mk('submitted', true, 10, 'XR-2'); await mk('approved', false, 20, 'XR-3'); const paid = await mk('paid', true, 15.5, 'XR-4');
      const rid = (await asActor(clerk, (tx) => createRun(tx, clerk, { customerId: ex, periodFrom: '2026-09-01', periodTo: '2026-09-30' }))).id;
      const v = await view(clerk, rid);
      expect(lines(v).map((l: any) => [l.kind, l.sourceId, l.listAmount]).sort()).toEqual([['expense', ok, 84.5], ['expense', paid, 15.5]].sort());
      expect(v.totals.net).toBe(100);
      const made = await invoice(clerk, rid);
      const il = (await db().query(`SELECT expense_line_id, unit_price FROM customer_invoice_line WHERE invoice_id = $1 ORDER BY line_no`, [made.invoiceId])).rows;
      expect(il.map((x) => x.expense_line_id).sort()).toEqual([ok, paid].sort());
      await asActor(clerk, (tx) => voidInvoice(tx, clerk, made.invoiceId!, 'Test'));
      expect((await view(clerk, (await asActor(clerk, (tx) => createRun(tx, clerk, { customerId: ex, periodFrom: '2026-09-01', periodTo: '2026-09-30' }))).id)).totals.lines).toBe(2);
    } finally {
      await db().query('DELETE FROM billing_claim WHERE source_kind = $1', ['expense']);
      await db().query('UPDATE customer_invoice_line SET expense_line_id = NULL WHERE expense_line_id IS NOT NULL');
      forgetExpenseColumns();
    }
  });
});

void many; void one;
