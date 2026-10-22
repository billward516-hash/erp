import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asActor, loadActor } from '../src/platform/auth/actor.js';
import type { Actor } from '../src/platform/auth/actor.js';
import { closePools, getAdminPool } from '../src/platform/db/pool.js';
import { LocalBlobStore } from '../src/platform/storage/blob-store.js';
import { createUserWithToken } from '../src/platform/tenancy/provision.js';
import { recordPayment } from '../src/modules/ar/service.js';
import { createAsset } from '../src/modules/assets/service.js';
import { commitImport, stageImport } from '../src/modules/imports/service.js';
import {
  activateLease, addTurnWork, billingPreview, createLease, getLease, giveNotice, listTurns, markTurnReady, recordMoveOut, renewLease, rentRoll, runRentBilling, saveRentalUnit,
} from '../src/modules/leasing/service.js';
import { transitionWorkOrder } from '../src/modules/maintenance/service.js';
import { getReport } from '../src/modules/reporting/registry.js';
import { saveSite } from '../src/modules/sites/service.js';
import type { World } from './fixtures.js';
import { makeWorld } from './fixtures.js';
import os from 'node:os';
import path from 'node:path';

const db = () => getAdminPool();
const blobs = new LocalBlobStore(path.join(os.tmpdir(), `erp-leasing-${process.pid}`));
const iso = (d: Date) => d.toISOString().slice(0, 10);
const now = new Date();
const thisMonth = iso(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))).slice(0, 7);
const lastMonthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
const lastMonth = iso(lastMonthStart).slice(0, 7);
const daysInLastMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0)).getUTCDate();
const day = (n: number) => iso(new Date(Date.now() + n * 86_400_000));
let w: World; let pm: Actor; let site: any;
let u101: any; let u102: any; let lease: any;

beforeAll(async () => {
  w = await makeWorld('lease');
  site = await asActor(w.admin, (tx) => saveSite(tx, w.admin, { code: 'MAPLE', name: 'Maple Court', kind: 'property' }));
  const u = await createUserWithToken(db(), w.tenantId, { email: `pm-${Date.now()}@l.example`, displayName: 'PM', roles: [{ role: 'property_manager', facility: site.id }] });
  pm = (await loadActor(w.tenantId, u.userId))!;
  const s101 = await asActor(w.admin, (tx) => createAsset(tx, w.admin, { facilityId: site.id, assetTag: 'MAPLE-101', name: 'Unit 101', assetClass: 'space' }));
  const s102 = await asActor(w.admin, (tx) => createAsset(tx, w.admin, { facilityId: site.id, assetTag: 'MAPLE-102', name: 'Unit 102', assetClass: 'space' }));
  const boiler = await asActor(w.admin, (tx) => createAsset(tx, w.admin, { facilityId: site.id, assetTag: 'MAPLE-BLR', name: 'Boiler', assetClass: 'facility_system' }));
  await expect(asActor(pm, (tx) => saveRentalUnit(tx, pm, { assetId: boiler.id }))).rejects.toThrow(/not a space/);
  u101 = await asActor(pm, (tx) => saveRentalUnit(tx, pm, { assetId: s101.id, bedrooms: 1, bathrooms: 1, areaSqft: 640, marketRent: 1200 }));
  u102 = await asActor(pm, (tx) => saveRentalUnit(tx, pm, { assetId: s102.id, bedrooms: 2, bathrooms: 1, areaSqft: 880, marketRent: 1400 }));
});
afterAll(closePools);

describe('leases', () => {
  it('a lease creates the renter as a customer; only one lease holds a unit at a time', async () => {
    lease = await asActor(pm, (tx) => createLease(tx, pm, { unitId: u101.id, startDate: `${lastMonth}-16`, endDate: day(300), rentAmount: 1200, depositAmount: 1200,
      renter: { name: 'Alicia Gomez', email: 'alicia@example.com', phone: '614-555-0191' }, charges: [{ description: 'Parking space 14', amount: 50 }] }));
    expect(lease).toMatchObject({ number: expect.stringMatching(/^LSE-\d{5}$/), status: 'draft' });
    const c = await db().query('SELECT c.code, c.party_type, ct.email FROM customer c JOIN contact ct ON ct.customer_id = c.id AND ct.is_primary WHERE c.id = $1', [lease.customer_id]);
    expect(c.rows[0]).toEqual({ code: expect.stringMatching(/^R-\d{5}$/), party_type: 'individual', email: 'alicia@example.com' });
    await asActor(pm, (tx) => activateLease(tx, pm, lease.id, { depositReceivedOn: `${lastMonth}-16` }));
    const rival = await asActor(pm, (tx) => createLease(tx, pm, { unitId: u101.id, startDate: day(30), rentAmount: 1300, renter: { name: 'Someone Else' } }));
    await expect(asActor(pm, (tx) => activateLease(tx, pm, rival.id))).rejects.toThrow(/is under LSE-/);
  });

  it('rent billing prorates a mid-month move-in, bills each month once, and posts to rental income', async () => {
    const p = await asActor(pm, (tx) => billingPreview(tx, pm, { period: lastMonth }));
    const days = daysInLastMonth - 15;
    const rent = Math.round((1200 * days / daysInLastMonth) * 100) / 100;
    const park = Math.round((50 * days / daysInLastMonth) * 100) / 100;
    expect(p.leases).toEqual([expect.objectContaining({ unit: 'MAPLE-101', prorated: true, total: Math.round((rent + park) * 100) / 100 })]);
    expect(p.leases[0]!.lines[0]!.description).toMatch(new RegExp(`Rent, Unit 101 \\(MAPLE-101\\), .*: ${days} of ${daysInLastMonth} days`));
    const r1 = await asActor(pm, (tx) => runRentBilling(tx, pm, blobs, { period: lastMonth, issue: true }));
    expect(r1.created).toEqual([expect.objectContaining({ number: expect.stringMatching(/^INV-/), total: Math.round((rent + park) * 100) / 100 })]);
    expect((await asActor(pm, (tx) => runRentBilling(tx, pm, blobs, { period: lastMonth, issue: true }))).created).toEqual([]);
    const r2 = await asActor(pm, (tx) => runRentBilling(tx, pm, blobs, { period: thisMonth, issue: true }));
    expect(r2.total).toBe(1250);
    const out = await db().query(`SELECT payload FROM outbox_event WHERE tenant_id = $1 AND topic = 'ar.invoice.issued' ORDER BY id`, [w.tenantId]);
    expect(out.rows[1].payload.lines.map((l: any) => [l.accountKey, l.amount])).toEqual([['rental_income', 1200], ['tenant_charges', 50]]);
    expect(out.rows[1].payload.dueDate).toBe(`${thisMonth}-01`);
  });

  it('the rent roll shows occupancy, vacancy at market rent and rent past due after the grace period', async () => {
    const roll = await asActor(pm, (tx) => rentRoll(tx, pm));
    expect(roll.map((r) => [r.unit, r.status, r.renter, r.rent])).toEqual([['MAPLE-101', 'occupied', 'Alicia Gomez', 1200], ['MAPLE-102', 'vacant', null, null]]);
    const r101 = roll[0]!;
    expect(r101.balance).toBeGreaterThan(1250);
    // Last month's invoice is past its due date (the 1st) plus 5 grace days; this month's depends on today's date.
    expect(r101.pastDue).toBeGreaterThan(0);
    const l = await asActor(pm, (tx) => getLease(tx, pm, lease.id));
    const oldest = l.invoices[l.invoices.length - 1];
    await asActor(w.admin, (tx) => recordPayment(tx, w.admin, { customerId: lease.customer_id, receivedOn: day(0), amount: oldest.total, method: 'ach', allocations: [{ invoiceId: oldest.id, amount: oldest.total }] }));
    const after = (await asActor(pm, (tx) => rentRoll(tx, pm)))[0]!;
    expect(after.balance).toBe(1250);
    const def = getReport('rent-roll')!;
    const rep = await asActor(pm, (tx) => def.run(tx, pm, def.params.parse({})));
    expect(rep.headline).toMatch(/^50\.0% occupied \(1 of 2 rentable units\); \$1,400 a month lost to vacancy/);
  });

  it('notice, then move-out opens a unit turn; the turn is ready only when its make-ready work is done', async () => {
    await asActor(pm, (tx) => giveNotice(tx, pm, lease.id, { noticeOn: day(-20), moveOutOn: day(0) }));
    expect((await asActor(pm, (tx) => rentRoll(tx, pm)))[0]).toMatchObject({ status: 'notice', moveOutOn: day(0) });
    await expect(asActor(pm, (tx) => recordMoveOut(tx, pm, lease.id, { movedOutOn: day(3) }))).rejects.toThrow(/once it has happened/);
    const { turnId } = await asActor(pm, (tx) => recordMoveOut(tx, pm, lease.id, { movedOutOn: day(0), turnDays: 5 }));
    const wo = await asActor(pm, (tx) => addTurnWork(tx, pm, turnId, { title: 'Paint and patch, Unit 101' }));
    await expect(asActor(pm, (tx) => markTurnReady(tx, pm, turnId))).rejects.toThrow(/finish the make-ready work first/);
    const t = (await asActor(pm, (tx) => listTurns(tx, pm, { open: true })))[0];
    expect(t).toMatchObject({ asset_tag: 'MAPLE-101', target_ready_on: day(5), jobs: 1, open_jobs: 1, late: false });
    await asActor(pm, (tx) => transitionWorkOrder(tx, pm, wo.id, { to: 'cancelled', note: 'Done by the owner' }));
    await asActor(pm, (tx) => markTurnReady(tx, pm, turnId));
    // The renter is there on move-out day; the unit is vacant from the day after.
    expect((await asActor(pm, (tx) => rentRoll(tx, pm)))[0]).toMatchObject({ status: 'occupied' });
    expect((await asActor(pm, (tx) => rentRoll(tx, pm, { asOf: day(1) })))[0]).toMatchObject({ status: 'vacant', daysVacant: 1, turnId: null });
    // Billing for next month leaves the ended lease alone.
    const next = iso(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1))).slice(0, 7);
    expect((await asActor(pm, (tx) => billingPreview(tx, pm, { period: next }))).leases).toEqual([]);
  });

  it('renewal starts a new lease the day after the old one ends, with no turn in between', async () => {
    const l2 = await asActor(pm, (tx) => createLease(tx, pm, { unitId: u102.id, startDate: day(-200), endDate: day(20), rentAmount: 1350, renter: { name: 'Tom Reyes' }, charges: [{ description: 'Pet rent', amount: 35 }] }));
    await asActor(pm, (tx) => activateLease(tx, pm, l2.id));
    const n = await asActor(pm, (tx) => renewLease(tx, pm, l2.id, { endDate: day(385), rentAmount: 1400 }));
    expect(n).toMatchObject({ status: 'active', start_date: day(21), renewed_from_id: l2.id });
    const old = await asActor(pm, (tx) => getLease(tx, pm, l2.id));
    expect(old).toMatchObject({ status: 'ended', move_out_on: day(20), ended_reason: 'renewed', renewedBy: { id: n.id } });
    expect((await asActor(pm, (tx) => listTurns(tx, pm, { open: true })))).toEqual([]);
    const charges = await db().query('SELECT description, amount::float FROM lease_charge WHERE lease_id = $1', [n.id]);
    expect(charges.rows).toEqual([{ description: 'Pet rent', amount: 35 }]);
  });
});

describe('importing a rent roll', () => {
  it('rental units and leases load from another system\'s exports; re-running changes nothing', async () => {
    const s = await asActor(w.admin, (tx) => saveSite(tx, w.admin, { code: 'BIRCH', name: 'Birch Flats', kind: 'property' }));
    for (const t of ['BIRCH-1A', 'BIRCH-1B']) await asActor(w.admin, (tx) => createAsset(tx, w.admin, { facilityId: s.id, assetTag: t, name: t, assetClass: 'space' }));
    const units = Buffer.from('Unit ID,Type,Beds,Baths,Sq Ft,Market Rent\nBIRCH-1A,Apartment,1,1,700,"$1,095.00"\nBIRCH-1B,Apartment,2,1,900,"$1,325.00"\nBIRCH-9Z,Apartment,1,1,700,900\n');
    const su = await stageImport(w.admin, { target: 'rental_units', sourceSystem: 'pm', fileName: 'u.csv', content: units });
    expect(su.stats).toMatchObject({ total: 3, errors: 1 });
    await commitImport(w.admin, su.batchId, { allowPartial: true });
    const roll = Buffer.from(`Lease ID,Unit ID,Tenant,Email,Lease From,Lease To,Rent,Deposit,Move Out\nL-77,BIRCH-1A,Dana Smith,dana@example.com,${day(-400)},${day(-35)},"$1,050.00",$500.00,\nL-78,BIRCH-1B,Lee Park,,${day(-100)},${day(265)},1325,1325,${day(40)}\n`);
    const sl = await stageImport(w.admin, { target: 'leases', sourceSystem: 'pm', fileName: 'r.csv', content: roll });
    expect(sl.stats).toMatchObject({ total: 2, valid: 2, errors: 0 });
    await commitImport(w.admin, sl.batchId);
    const rr = (await asActor(w.admin, (tx) => rentRoll(tx, w.admin, { facilityId: s.id }))).map((r) => [r.unit, r.status, r.renter, r.rent, r.monthToMonth]);
    // Past its end date with no move-out the lease holds over month to month.
    expect(rr).toEqual([['BIRCH-1A', 'occupied', 'Dana Smith', 1050, true], ['BIRCH-1B', 'notice', 'Lee Park', 1325, false]]);
    const again = await stageImport(w.admin, { target: 'leases', sourceSystem: 'pm', fileName: 'r.csv', content: roll });
    expect(again.preview.map((r: any) => r.action)).toEqual(['unchanged', 'unchanged']);
  });
});
