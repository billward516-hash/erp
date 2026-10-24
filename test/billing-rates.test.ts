import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asActor } from '../src/platform/auth/actor.js';
import type { Actor } from '../src/platform/auth/actor.js';
import { closePools, getAdminPool } from '../src/platform/db/pool.js';
import { billedHours, createRate, endRate, explainRate, getSettings, listRates, resolveRate, saveSettings } from '../src/modules/billing/rates.js';
import type { RateRow } from '../src/modules/billing/rates.js';
import { actorWith, customer, employee, project } from './billing-helpers.js';
import type { World } from './fixtures.js';
import { makeWorld } from './fixtures.js';

const row = (o: Partial<RateRow> & Pick<RateRow, 'scope' | 'amount'>): RateRow => ({ id: `${o.scope}-${o.amount}`, projectId: null, customerId: null, employeeId: null, roleKey: null, roleLabel: null, effectiveFrom: '2026-01-01', effectiveTo: null,
  note: null, createdAt: '2026-01-01T00:00:00Z', projectLabel: 'P-1 Alpha', customerLabel: 'Acme', employeeLabel: 'Ann Lee', ...o });
const ctx = { projectId: 'p1', customerId: 'c1', employeeId: 'e1', roleKey: 'consultant', date: '2026-06-15' };

describe('rate resolution order (pure)', () => {
  const all = [
    row({ scope: 'default', amount: 100 }), row({ scope: 'role', amount: 120, roleKey: 'consultant', roleLabel: 'Consultant' }), row({ scope: 'person', amount: 140, employeeId: 'e1' }),
    row({ scope: 'customer', amount: 160, customerId: 'c1' }), row({ scope: 'project', amount: 180, projectId: 'p1' }),
  ];
  it('project beats customer beats person beats role beats default', () => {
    expect(resolveRate(all, ctx)?.amount).toBe(180);
    expect(resolveRate(all.filter((r) => r.scope !== 'project'), ctx)?.amount).toBe(160);
    expect(resolveRate(all.filter((r) => !['project', 'customer'].includes(r.scope)), ctx)?.amount).toBe(140);
    expect(resolveRate(all.filter((r) => ['default', 'role'].includes(r.scope)), ctx)?.amount).toBe(120);
    expect(resolveRate(all.filter((r) => r.scope === 'default'), ctx)?.amount).toBe(100);
    expect(resolveRate([], ctx)).toBeNull();
  });
  it('a rate for another project, customer, person or role does not apply', () => {
    const other = [row({ scope: 'project', amount: 999, projectId: 'p2' }), row({ scope: 'customer', amount: 998, customerId: 'c2' }), row({ scope: 'person', amount: 997, employeeId: 'e2' }), row({ scope: 'role', amount: 996, roleKey: 'partner', roleLabel: 'Partner' })];
    expect(resolveRate(other, ctx)).toBeNull();
    expect(resolveRate([...other, row({ scope: 'default', amount: 50 })], ctx)?.amount).toBe(50);
  });
  it('effective dates: starts and ends are inclusive, and the latest start wins', () => {
    const rs = [row({ scope: 'default', amount: 100, effectiveFrom: '2026-01-01', effectiveTo: '2026-06-30' }), row({ scope: 'default', amount: 110, effectiveFrom: '2026-07-01' })];
    expect(resolveRate(rs, { ...ctx, date: '2025-12-31' })).toBeNull();
    expect(resolveRate(rs, { ...ctx, date: '2026-01-01' })?.amount).toBe(100);
    expect(resolveRate(rs, { ...ctx, date: '2026-06-30' })?.amount).toBe(100);
    expect(resolveRate(rs, { ...ctx, date: '2026-07-01' })?.amount).toBe(110);
    const overlap = [row({ scope: 'default', amount: 100, effectiveFrom: '2026-01-01' }), row({ scope: 'default', amount: 105, effectiveFrom: '2026-03-01' })];
    expect(resolveRate(overlap, ctx)?.amount).toBe(105);
  });
  it('inside a project card a person line beats a role line beats a line for everybody', () => {
    const rs = [row({ scope: 'project', amount: 150, projectId: 'p1' }), row({ scope: 'project', amount: 170, projectId: 'p1', roleKey: 'consultant', roleLabel: 'Consultant' }), row({ scope: 'project', amount: 190, projectId: 'p1', employeeId: 'e1' })];
    expect(resolveRate(rs, ctx)?.amount).toBe(190);
    expect(resolveRate(rs, { ...ctx, employeeId: 'e9' })?.amount).toBe(170);
    expect(resolveRate(rs, { ...ctx, employeeId: 'e9', roleKey: 'analyst' })?.amount).toBe(150);
  });
  it('says why', () => {
    expect(resolveRate(all, ctx)?.why).toBe('Project rate (P-1 Alpha), 180.00 an hour, in force 2026-01-01');
    expect(resolveRate(all.filter((r) => r.scope === 'role'), ctx)?.why).toContain('Role rate (Consultant)');
    expect(resolveRate([row({ scope: 'default', amount: 100, effectiveTo: '2026-12-31' })], ctx)?.why).toBe('Company default rate, 100.00 an hour, in force 2026-01-01 to 2026-12-31');
  });
});

describe('hours rounding', () => {
  it('off by default; nearest 0.25 when on, half up, never below one step', () => {
    expect(billedHours(1.1, null)).toBe(1.1);
    expect(billedHours(1.1, 0.25)).toBe(1);
    expect(billedHours(1.13, 0.25)).toBe(1.25);
    expect(billedHours(1.125, 0.25)).toBe(1.25);
    expect(billedHours(0.05, 0.25)).toBe(0.25);
    expect(billedHours(7.99, 0.25)).toBe(8);
  });
});

describe('rate cards in the database', () => {
  let w: World; let acme: string; let proj: string; let ann: string; let clerk: Actor; let siteB: Actor;
  beforeAll(async () => {
    w = await makeWorld('rates');
    acme = await customer(w, 'ACME');
    proj = await project(w, { number: 'P-1', customerId: acme });
    ann = await employee(w, 'E200', 'Ann', 'Lee', 'Consultant');
    clerk = await actorWith(w, 'ar_clerk', 'clerk', null);
    siteB = await actorWith(w, 'finance_approver', 'financeB', w.facilities.B!);
  });
  afterAll(async () => { await closePools(); });

  it('rates are kept by their own permission: a billing clerk reads but cannot set one', async () => {
    await expect(asActor(clerk, (tx) => createRate(tx, clerk, { scope: 'default', amount: 100, effectiveFrom: '2026-01-01' }))).rejects.toMatchObject({ status: 403 });
    expect((await asActor(clerk, (tx) => listRates(tx, clerk))).rates).toEqual([]);
  });
  it('a new rate ends the open one the day before, and cannot start before a later one', async () => {
    const f = w.finance;
    await asActor(f, (tx) => createRate(tx, f, { scope: 'default', amount: 100, effectiveFrom: '2026-01-01' }));
    const r = await asActor(f, (tx) => createRate(tx, f, { scope: 'default', amount: 110, effectiveFrom: '2026-07-01' }));
    expect(r.endedPrevious).toBe(1);
    const rows = (await asActor(f, (tx) => listRates(tx, f, { scope: 'default' }))).rates;
    expect(rows.map((x: any) => [x.amount, x.effectiveFrom, x.effectiveTo])).toEqual([[110, '2026-07-01', null], [100, '2026-01-01', '2026-06-30']]);
    await expect(asActor(f, (tx) => createRate(tx, f, { scope: 'default', amount: 90, effectiveFrom: '2026-03-01' }))).rejects.toMatchObject({ status: 409 });
  });
  it('shows why a rate applies, by project, customer, person and role', async () => {
    const f = w.finance;
    await asActor(f, (tx) => createRate(tx, f, { scope: 'role', role: 'Consultant', amount: 125, effectiveFrom: '2026-01-01' }));
    const e1 = await asActor(f, (tx) => explainRate(tx, f, { projectId: proj, employeeId: ann, date: '2026-08-01' }));
    expect(e1).toMatchObject({ rate: 125, scope: 'role' });
    await asActor(f, (tx) => createRate(tx, f, { scope: 'person', employeeId: ann, amount: 135, effectiveFrom: '2026-01-01' }));
    await asActor(f, (tx) => createRate(tx, f, { scope: 'customer', customerId: acme, amount: 145, effectiveFrom: '2026-01-01' }));
    expect((await asActor(f, (tx) => explainRate(tx, f, { projectId: proj, employeeId: ann, date: '2026-08-01' }))).rate).toBe(145);
    await asActor(f, (tx) => createRate(tx, f, { scope: 'project', projectId: proj, amount: 155, effectiveFrom: '2026-01-01' }));
    const e2 = await asActor(f, (tx) => explainRate(tx, f, { projectId: proj, employeeId: ann, date: '2026-08-01' }));
    expect(e2.rate).toBe(155);
    expect(e2.why).toContain('Project rate (P-1 Project P-1)');
    const none = await asActor(f, (tx) => explainRate(tx, f, { projectId: proj, employeeId: ann, date: '2025-01-01' }));
    expect(none.rate).toBeNull();
  });
  it('ending a rate stops it applying; project cards belong to a site, company cards need company-wide authority', async () => {
    const f = w.finance;
    const id = (await asActor(f, (tx) => listRates(tx, f, { scope: 'project', projectId: proj }))).rates[0].id;
    await asActor(f, (tx) => endRate(tx, f, id, '2026-08-31'));
    expect((await asActor(f, (tx) => explainRate(tx, f, { projectId: proj, employeeId: ann, date: '2026-09-01' }))).rate).toBe(145);
    // finance at site B only: cannot touch a site A project's card, nor a company-wide card.
    await expect(asActor(siteB, (tx) => createRate(tx, siteB, { scope: 'project', projectId: proj, amount: 1, effectiveFrom: '2026-01-01' }))).rejects.toMatchObject({ status: 404 }); // RLS hides the project
    await expect(asActor(siteB, (tx) => createRate(tx, siteB, { scope: 'default', amount: 1, effectiveFrom: '2027-01-01' }))).rejects.toMatchObject({ status: 403 });
  });
  it('rejects malformed cards', async () => {
    const f = w.finance;
    await expect(asActor(f, (tx) => createRate(tx, f, { scope: 'project', amount: 10, effectiveFrom: '2026-01-01' }))).rejects.toMatchObject({ status: 422 });
    await expect(asActor(f, (tx) => createRate(tx, f, { scope: 'role', amount: 10, effectiveFrom: '2026-01-01' }))).rejects.toMatchObject({ status: 422 });
    await expect(asActor(f, (tx) => createRate(tx, f, { scope: 'default', amount: -1, effectiveFrom: '2026-01-01' }))).rejects.toMatchObject({ status: 422 });
    await expect(asActor(f, (tx) => createRate(tx, f, { scope: 'person', employeeId: ann, role: 'x', amount: 10, effectiveFrom: '2026-01-01' }))).rejects.toMatchObject({ status: 422 });
  });
  it('hours rounding is a company setting, off by default, changed by the rates permission and audited', async () => {
    const f = w.finance;
    expect(await asActor(f, (tx) => getSettings(tx))).toEqual({ roundHoursTo: null, retainerIssueMode: 'draft' });
    await expect(asActor(clerk, (tx) => saveSettings(tx, clerk, { roundHoursTo: 0.25 }))).rejects.toMatchObject({ status: 403 });
    await expect(asActor(f, (tx) => saveSettings(tx, f, { roundHoursTo: 0.3 }))).rejects.toMatchObject({ status: 422 });
    await asActor(f, (tx) => saveSettings(tx, f, { roundHoursTo: 0.25 }));
    expect((await asActor(f, (tx) => getSettings(tx))).roundHoursTo).toBe(0.25);
    await asActor(f, (tx) => saveSettings(tx, f, { roundHoursTo: null }));
    const ev = await getAdminPool().query(`SELECT count(*)::int AS n FROM audit_event WHERE tenant_id = $1 AND action = 'billing.settings_changed'`, [w.tenantId]);
    expect(ev.rows[0].n).toBe(2);
  });
});
