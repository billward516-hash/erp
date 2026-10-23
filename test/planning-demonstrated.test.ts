import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asActor } from '../src/platform/auth/actor.js';
import { closePools, getAdminPool } from '../src/platform/db/pool.js';
import { createLocation, receive } from '../src/modules/inventory/service.js';
import { createPart } from '../src/modules/parts/service.js';
import { demonstratedConsumption, saveConsumptionRate } from '../src/modules/planning/service.js';
import type { World } from './fixtures.js';
import { makeWorld } from './fixtures.js';

/** Demonstrated consumption (D-172): the monthly rate the stockroom's own issues show, against the typed rate. */
let w: World; let site: string; let loc: string;
const P: Record<string, string> = {};
beforeAll(async () => {
  w = await makeWorld('demo');
  site = w.facilities.A!;
  await asActor(w.admin, async (tx) => {
    for (const k of ['cool', 'ins', 'gas', 'wo', 'once']) P[k] = (await createPart(tx, w.admin, { partNumber: `DC-${k.toUpperCase()}`, description: k, uom: 'EA' })).id;
    loc = (await createLocation(tx, w.admin, { facilityId: site, code: 'CRIB', name: 'Crib' })).id;
    for (const k of Object.keys(P)) await receive(tx, w.admin, { locationId: loc, partId: P[k]!, qty: 1000, unitCost: 2 });
  });
});
afterAll(async () => { await closePools(); });

const issue = (part: string, qty: number, daysAgo: number, workOrderId: string | null = null) =>
  getAdminPool().query(`INSERT INTO inventory_txn (tenant_id, facility_id, location_id, part_id, txn_type, qty, unit_cost, balance_after, work_order_id, created_by, created_at)
    VALUES ($1, $2, $3, $4, 'issue', $5, 2, 0, $6, $7, now() - make_interval(days => $8))`, [w.tenantId, site, loc, part, -qty, workOrderId, w.admin.userId, daysAgo]);

describe('demonstrated consumption', () => {
  it('suggests rates from issues not tied to a work order, against the typed monthly rate', async () => {
    // cool: 30 a month for three months; typed rate 10 → raise. ins: no rate → add. gas: typed 30, uses 30 → ok.
    for (const d of [85, 55, 25]) { await issue(P.cool!, 30, d); await issue(P.ins!, 12, d); await issue(P.gas!, 30, d); }
    await issue(P.once!, 500, 10); // one issue only: not enough to call a rate
    await asActor(w.admin, async (tx) => {
      await saveConsumptionRate(tx, w.admin, { facilityId: site, partId: P.cool!, basis: 'month', rate: 10 });
      await saveConsumptionRate(tx, w.admin, { facilityId: site, partId: P.gas!, basis: 'month', rate: 30 });
    });
    const r = await asActor(w.admin, (tx) => demonstratedConsumption(tx, w.admin, site, 90));
    const by = Object.fromEntries(r.rows.map((x: any) => [x.partNumber, x]));
    expect(by['DC-COOL']).toMatchObject({ perMonth: 30, monthlyRate: 10, changePct: 200, suggestion: 'raise' });
    expect(by['DC-INS']).toMatchObject({ perMonth: 12, monthlyRate: null, suggestion: 'add', monthlyCost: 24 });
    expect(by['DC-GAS']).toMatchObject({ suggestion: 'ok' });
    expect(by['DC-ONCE']).toBeUndefined();
    expect(r.answer).toMatch(/^2 of 3 consumed parts differ from the plan: /);
  });

  it('ignores issues charged to a work order and needs the right permission', async () => {
    const wo = (await getAdminPool().query(`SELECT id FROM work_order WHERE tenant_id = $1 LIMIT 1`, [w.tenantId])).rows[0]?.id as string | undefined;
    if (wo) { for (const d of [80, 50, 20]) await issue(P.wo!, 40, d, wo); }
    const r = await asActor(w.admin, (tx) => demonstratedConsumption(tx, w.admin, site, 90));
    expect(r.rows.find((x: any) => x.partNumber === 'DC-WO')).toBeUndefined();
    await expect(asActor(w.techA, (tx) => demonstratedConsumption(tx, w.techA, site, 90))).rejects.toThrow();
  });
});
