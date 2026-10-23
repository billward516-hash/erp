import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { asActor } from '../src/platform/auth/actor.js';
import { closePools, getAdminPool } from '../src/platform/db/pool.js';
import { createCapa, getCapa, updateCapa } from '../src/modules/quality/service.js';
import { createChange } from '../src/modules/moc/service.js';
import { capaDashboard } from '../src/modules/capa/dashboard.js';
import type { World } from './fixtures.js';
import { makeWorld } from './fixtures.js';

/** The CAPA and 8D module (D-160). */
let app: FastifyInstance; let w: World;
const db = () => getAdminPool();
const open = (input: Record<string, unknown>) => asActor(w.qualityA, (tx) => createCapa(tx, w.qualityA, {
  facilityId: w.facilities.A!, title: 'Coolant concentration drifts low', problem: 'Refractometer readings trend down between top-ups.', source: 'risk', ownerUserId: w.qualityA.userId, ...input } as any));

beforeAll(async () => {
  app = buildApp();
  w = await makeWorld('capamod');
});
afterAll(async () => { await app.close(); await closePools(); });

describe('preventive actions', () => {
  it('answer a potential problem: no nonconformance, incident or complaint behind them, and no 8D', async () => {
    const p = await open({ actionType: 'preventive' });
    expect(p).toMatchObject({ action_type: 'preventive', format: 'standard', source: 'risk', number: expect.stringMatching(/^CA-/) });
    await expect(open({ actionType: 'preventive', source: 'customer_complaint' })).rejects.toThrow(/open a corrective action/);
    await expect(open({ actionType: 'preventive', format: 'eight_d' })).rejects.toThrow(/8D is for corrective actions/);
    await expect(asActor(w.qualityA, (tx) => updateCapa(tx, w.qualityA, p.id, { format: 'eight_d' }))).rejects.toThrow(/8D is for corrective actions/);
  });
});

describe('sources linked back to their record', () => {
  it('a corrective action from a change links to it; a record at another site is refused', async () => {
    const plan = { consequences: 'x x x', qmsImpact: 'x x x', resources: 'x x x', responsibilities: 'x x x' };
    const mA = await asActor(w.admin, (tx) => createChange(tx, w.admin, { ...plan, facilityId: w.facilities.A!, title: 'New deburr brush', changeType: 'process', description: 'Brush deburr on op 30 in cycle.', justification: 'Burrs on ports caused returns.' }));
    const mB = await asActor(w.admin, (tx) => createChange(tx, w.admin, { ...plan, facilityId: w.facilities.B!, title: 'Other site change', changeType: 'process', description: 'Something at plant B only.', justification: 'For the site check in the test.' }));
    await expect(open({ source: 'change', originType: 'moc_change', originId: mB.id })).rejects.toThrow(/not found|another site/); // a site the user cannot see is not found at all
    await expect(open({ source: 'change', originType: 'moc_change' })).rejects.toThrow(/both its kind and id/);
    const c = await open({ source: 'change', originType: 'moc_change', originId: mA.id, title: 'MOC did not achieve its purpose' });
    expect((await asActor(w.qualityA, (tx) => getCapa(tx, w.qualityA, c.id))).origin).toEqual({ type: 'moc_change', id: mA.id, label: `${mA.number} New deburr brush`, link: `/changes/${mA.id}` });
  });
});

describe('the dashboard', () => {
  it('answers first: open by type, overdue, how often fixes held, by step, source and age, and repeat problems', async () => {
    const sup = (await db().query(`INSERT INTO supplier (tenant_id, code, name) VALUES ($1, 'ACME', 'Acme Castings') RETURNING id`, [w.tenantId])).rows[0].id;
    for (const t of ['Porosity on lot 41', 'Porosity on lot 57']) await open({ source: 'supplier', supplierId: sup, supplierResponseDue: '2030-01-01', title: t });
    const late = await open({ title: 'Late one', dueDate: '2020-01-01' });
    // Two closed after their effectiveness check: one held, one did not.
    const held = await open({ title: 'Held' }); const failed = await open({ title: 'Did not hold' });
    await db().query(`UPDATE corrective_action SET status = 'closed', closed_at = created_at + interval '20 days', effective = (id = $1), verified_by = $3, verified_at = now() WHERE id IN ($1, $2)`,
      [held.id, failed.id, w.admin.userId]);
    const d = await asActor(w.qualityA, (tx) => capaDashboard(tx, w.qualityA));
    expect(d.kpis).toMatchObject({ open: 5, corrective: 4, preventive: 1, overdue: 1, effectivenessRate: 50, closedLastYear: 2, avgDaysToClose: 20 });
    expect(d.answer).toBe('5 open (1 preventive), 1 overdue; 50% of fixes checked in the last year held.');
    expect(d.byStep.find((s) => s.step === 'open')!.n).toBe(5);
    expect(d.bySource).toEqual(expect.arrayContaining([{ label: 'Supplier', n: 2 }, { label: 'Risk or trend', n: 2 }, { label: 'Change', n: 1 }]));
    expect(d.repeats).toEqual([expect.objectContaining({ kind: 'supplier', key: 'ACME', n: 2 })]);
    expect(d.open.find((r: any) => r.id === late.id)).toMatchObject({ overdue: true });
  });

  it('is for people who can see quality, over HTTP', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/capa-dashboard', headers: { authorization: `Bearer ${w.tokens.techA}` } })).statusCode).toBe(403);
    const r = await app.inject({ method: 'GET', url: '/api/capa-dashboard', headers: { authorization: `Bearer ${w.tokens.qualityA}` } });
    expect(r.statusCode).toBe(200);
    expect(r.json().kpis.open).toBe(5);
  });
});
