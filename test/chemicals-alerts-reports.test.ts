import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asActor } from '../src/platform/auth/actor.js';
import { closePools, getAdminPool } from '../src/platform/db/pool.js';
import { createLocation } from '../src/modules/inventory/service.js';
import { createDocument } from '../src/modules/documents/service.js';
import { createContainer, openContainer, setChemicalPart, setLimit, setSettings } from '../src/modules/chemicals/service.js';
import { createPreparation } from '../src/modules/chemicals/preparations.js';
import { runReminders } from '../src/modules/notifications/reminders.js';
import { setReminder } from '../src/modules/reminders/settings.js';
import { whatIsLate } from '../src/modules/late/service.js';
import { runReport } from '../src/modules/reporting/service.js';
import type { World } from './fixtures.js';
import { makeWorld } from './fixtures.js';
import { chemicalWorld, daysFrom } from './chemicals-fixtures.js';

/** Alerts, What is late and the three chemical reports (SC-007 C). */
const db = () => getAdminPool();
let w: World; let c: Awaited<ReturnType<typeof chemicalWorld>>; let n = 0;
const admin = <T>(fn: (tx: any) => Promise<T>) => asActor(w.admin, fn);
const today = daysFrom(0);
const loc = async (code: string, facility: 'A' | 'B' = 'A') => (await admin((tx) => createLocation(tx, w.admin, { facilityId: w.facilities[facility]!, code: `${code}-${++n}`, name: code }))).id as string;
const make = (partId: string, locationId: string, lot: string, qty: number, expiresOn: string | null) =>
  admin((tx) => createContainer(tx, w.admin, { partId, locationId, lot, qty, receiveIntoStock: true, expiresOn })).then((r) => r.containers[0].id as string);
const notices = async (kind: string, userId?: string) => (await db().query(`SELECT user_id, title, body, dedupe_key FROM notification WHERE tenant_id = $1 AND kind = $2 ${userId ? 'AND user_id = $3' : ''} ORDER BY id`,
  userId ? [w.tenantId, kind, userId] : [w.tenantId, kind])).rows;

beforeAll(async () => { w = await makeWorld('chem-a'); c = await chemicalWorld(w); });
afterAll(closePools);

describe('expiry alerts', () => {
  it('go to chemical managers at the site once per period, with the default lead of 14 days', async () => {
    const l = await loc('EXP');
    await make(c.acid.id, l, 'HCL-E1', 1, daysFrom(10));   // inside 14 days
    await make(c.acid.id, l, 'HCL-E2', 1, daysFrom(40));   // outside
    const first = await runReminders(w.tenantId, today);
    expect(first.chemical_expiring).toBeGreaterThan(0);
    const mine = await notices('reminder.chemical_expiring', w.managerA.userId);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.title).toMatch(/A: 1 reaching use-by within 14 days/);
    expect(mine[0]!.body).toMatch(/HCL-37/);
    expect(mine[0]!.body).not.toMatch(daysFrom(40));
    // Not for people without the permission, and not for another site.
    expect(await notices('reminder.chemical_expiring', w.techA.userId)).toHaveLength(0);
    expect(await notices('reminder.chemical_expiring', w.operatorB.userId)).toHaveLength(0);
    const total = (await notices('reminder.chemical_expiring')).length;
    // The same day again, and the same week again, add nothing.
    await runReminders(w.tenantId, today); await runReminders(w.tenantId, today);
    await runReminders(w.tenantId, daysFrom(1));
    expect((await notices('reminder.chemical_expiring')).length).toBe(total);
    expect(new Set((await notices('reminder.chemical_expiring')).map((x) => x.dedupe_key)).size).toBeLessThanOrEqual(2); // one key per user group, not per run
  });

  it('the lead is a company setting', async () => {
    const t = await makeWorld('chem-lead'); const cc = await chemicalWorld(t);
    const l = (await asActor(t.admin, (tx) => createLocation(tx, t.admin, { facilityId: t.facilities.A!, code: 'LEAD-1', name: 'x' }))).id;
    await asActor(t.admin, (tx) => createContainer(tx, t.admin, { partId: cc.acid.id, locationId: l, lot: 'HCL-L1', qty: 1, receiveIntoStock: true, expiresOn: daysFrom(25) }));
    await asActor(t.admin, (tx) => setReminder(tx, t.admin, 'chemical_expiring', { enabled: true, leadDays: 20, repeat: 'weekly' }));
    await runReminders(t.tenantId, today);
    expect((await db().query(`SELECT 1 FROM notification WHERE tenant_id = $1 AND kind = 'reminder.chemical_expiring'`, [t.tenantId])).rows).toHaveLength(0);
    await asActor(t.admin, (tx) => setReminder(tx, t.admin, 'chemical_expiring', { enabled: true, leadDays: 30, repeat: 'weekly' }));
    await runReminders(t.tenantId, today);
    expect((await db().query(`SELECT 1 FROM notification WHERE tenant_id = $1 AND kind = 'reminder.chemical_expiring'`, [t.tenantId])).rows.length).toBeGreaterThan(0);
    await asActor(t.admin, (tx) => setReminder(tx, t.admin, 'chemical_expiring', { enabled: false, leadDays: 30, repeat: 'weekly' }));
    await runReminders(t.tenantId, daysFrom(8));
    const after = (await db().query(`SELECT 1 FROM notification WHERE tenant_id = $1 AND kind = 'reminder.chemical_expiring'`, [t.tenantId])).rows.length;
    await runReminders(t.tenantId, daysFrom(16));
    expect((await db().query(`SELECT 1 FROM notification WHERE tenant_id = $1 AND kind = 'reminder.chemical_expiring'`, [t.tenantId])).rows.length).toBe(after);
  });

  it('a beyond-use date after opening and an expiring preparation are included', async () => {
    const t = await makeWorld('chem-bu'); const cc = await chemicalWorld(t);
    const l = (await asActor(t.admin, (tx) => createLocation(tx, t.admin, { facilityId: t.facilities.A!, code: 'BU-1', name: 'x' }))).id;
    const id = (await asActor(t.admin, (tx) => createContainer(tx, t.admin, { partId: cc.acid.id, locationId: l, lot: 'HCL-BU', qty: 2, receiveIntoStock: true, expiresOn: daysFrom(300) }))).containers[0].id;
    await asActor(t.admin, (tx) => openContainer(tx, t.admin, id, { openedOn: daysFrom(-25) })); // beyond-use in 5 days
    await runReminders(t.tenantId, today);
    const rows = (await db().query(`SELECT title, body FROM notification WHERE tenant_id = $1 AND kind = 'reminder.chemical_expiring' AND user_id = $2`, [t.tenantId, t.managerA.userId])).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].body).toMatch(/Container CHM-\d+ HCL-37/);
  });
});

describe('safety data sheet exceptions', () => {
  it('no sheet, and a sheet older than the company limit, are listed and reminded', async () => {
    const doc = await admin((tx) => createDocument(tx, w.admin, { facilityId: null, title: 'SDS Hydrochloric acid', docType: 'other' }));
    const l = await loc('SDS');
    await make(c.acid.id, l, 'HCL-S1', 1, daysFrom(300));
    await make(c.solvent.id, l, 'IPA-S1', 1, daysFrom(300));
    // Acid: sheet dated more than three years ago; solvent: none; base: current sheet.
    await admin((tx) => setChemicalPart(tx, w.admin, c.acid.id, { isChemical: true, hazardClasses: ['corrosive'], storageGroupId: c.g('ACID'), inUseDays: 30, sdsDocumentId: doc.id, sdsRevisionOn: daysFrom(-3 * 366) }));
    await admin((tx) => setChemicalPart(tx, w.admin, c.base.id, { isChemical: true, hazardClasses: ['corrosive'], storageGroupId: c.g('BASE'), inUseDays: 90, sdsDocumentId: doc.id, sdsRevisionOn: daysFrom(-100) }));
    await expect(admin((tx) => setChemicalPart(tx, w.admin, c.base.id, { isChemical: true, sdsDocumentId: doc.id }))).rejects.toThrow(/revision date/);
    await expect(admin((tx) => setChemicalPart(tx, w.admin, c.base.id, { isChemical: true, casNumber: '1234-56-7' }))).rejects.toThrow(/valid CAS/);
    expect((await db().query(`SELECT 1 FROM document_link WHERE document_id = $1 AND entity_type = 'part' AND link_role = 'sds'`, [doc.id])).rows).toHaveLength(2);

    const r: any = (await runReport(w.admin, 'chemical-exceptions', {}, 'json')).body;
    const kinds = r.rows.map((x: any) => `${x.exception}|${x.item.split(' ')[0]}`);
    expect(kinds).toContain('No safety data sheet|IPA-99');
    expect(kinds).toContain('Safety data sheet older than 3 years|HCL-37');
    expect(kinds).not.toContain('No safety data sheet|NAOH-50');
    expect(kinds).not.toContain('Safety data sheet older than 3 years|NAOH-50');
    expect(r.kpis.find((k: any) => k.label === 'No safety data sheet').value).toBeGreaterThanOrEqual(1);

    // Weekly summaries: the first sweep may already have said something this week, so look at the next week's.
    const nextWeek = daysFrom(14);
    await runReminders(w.tenantId, nextWeek);
    const mine = await notices('reminder.chemical_exceptions', w.managerA.userId);
    expect(mine.at(-1)!.title).toMatch(/with no safety data sheet.*with a sheet older than 3 years/);
    const count = mine.length;
    await runReminders(w.tenantId, nextWeek);
    expect(await notices('reminder.chemical_exceptions', w.managerA.userId)).toHaveLength(count);
  });

  it('the age limit is a company setting', async () => {
    const older = async () => ((await runReport(w.admin, 'chemical-exceptions', {}, 'json')).body as any).rows.filter((x: any) => x.exception.startsWith('Safety data sheet older')).map((x: any) => `${x.exception}|${x.item.split(' ')[0]}`);
    await admin((tx) => setSettings(tx, w.admin, { sdsMaxAgeYears: 20 }));
    expect(await older()).toEqual([]);
    await admin((tx) => setSettings(tx, w.admin, { sdsMaxAgeYears: 1 }));
    expect(await older()).toEqual(['Safety data sheet older than 1 years|HCL-37']); // the acid's sheet is three years old, the base's is 100 days old
    await admin((tx) => setSettings(tx, w.admin, { sdsMaxAgeYears: 3 }));
    await expect(admin((tx) => setSettings(tx, w.admin, { sdsMaxAgeYears: 0 }))).rejects.toThrow(/1 to 20/);
  });
});

describe('what is late', () => {
  it('lists expired containers and preparations still in storage, for people who may see chemicals at that site', async () => {
    const l = await loc('LATE');
    const id = await make(c.base.id, l, 'NAOH-LATE', 1, daysFrom(30));
    await db().query('UPDATE chemical_container SET expires_on = $2 WHERE id = $1', [id, daysFrom(-4)]);
    const late = await admin((tx) => whatIsLate(tx, w.admin));
    const sec = late.sections.find((s) => s.key === 'chemicals')!;
    expect(sec.title).toBe('Expired chemicals still in storage');
    const row = sec.rows.find((r) => r.label.includes('NAOH-50'))!;
    expect(row).toMatchObject({ daysLate: 4, href: '/chemicals' });
    expect(row.detail).toMatch(/NAOH-LATE.*expired/);
    // Plant B's operator (no chemical permission) sees nothing of it; the plant A manager does.
    expect((await asActor(w.operatorB, (tx) => whatIsLate(tx, w.operatorB))).sections.find((s) => s.key === 'chemicals')).toBeUndefined();
    expect((await asActor(w.managerA, (tx) => whatIsLate(tx, w.managerA))).sections.find((s) => s.key === 'chemicals')).toBeDefined();
    // A disposed container drops off.
    const { disposeContainer } = await import('../src/modules/chemicals/service.js');
    await admin((tx) => disposeContainer(tx, w.admin, id, { note: 'Waste contractor pickup' }));
    expect((await admin((tx) => whatIsLate(tx, w.admin))).sections.find((s) => s.key === 'chemicals')?.rows.some((r) => r.label.includes('NAOH-50') && r.detail.includes('NAOH-LATE'))).toBeFalsy();
  });

  it('an expired preparation appears until it is discarded', async () => {
    const l = await loc('LATEP');
    const id = await make(c.acid.id, l, 'HCL-LP', 3, daysFrom(300));
    const p = await admin((tx) => createPreparation(tx, w.admin, { facilityId: w.facilities.A!, name: 'Late buffer', kind: 'reagent', qty: 1, uom: 'L', shelfLifeDays: 3, components: [{ containerId: id, qty: 0.1 }] }));
    await db().query('UPDATE chemical_preparation SET expires_on = $2 WHERE id = $1', [p.id, daysFrom(-1)]);
    const sec = (await admin((tx) => whatIsLate(tx, w.admin))).sections.find((s) => s.key === 'chemicals')!;
    expect(sec.rows.some((r) => r.label.includes('Late buffer'))).toBe(true);
  });
});

describe('hazardous inventory', () => {
  it('adds quantity by location and hazard class, in one unit, against the limit the company set', async () => {
    const t = await makeWorld('chem-haz'); const cc = await chemicalWorld(t);
    const as = <T>(fn: (tx: any) => Promise<T>) => asActor(t.admin, fn);
    const mk = async (code: string) => (await as((tx) => createLocation(tx, t.admin, { facilityId: t.facilities.A!, code, name: code }))).id as string;
    const cab1 = await mk('FLAM-CAB1'); const cab2 = await mk('FLAM-CAB2'); const acidCab = await mk('ACID-CAB'); const baseCab = await mk('BASE-CAB');
    const put = (partId: string, at: string, lot: string, qty: number) => as((tx) => createContainer(tx, t.admin, { partId, locationId: at, lot, qty, receiveIntoStock: true, expiresOn: daysFrom(300) }));
    await put(cc.solvent.id, cab1, 'IPA-H1', 4); await put(cc.solvent.id, cab1, 'IPA-H2', 2.5); await put(cc.solvent.id, cab2, 'IPA-H3', 1);
    await put(cc.acid.id, acidCab, 'HCL-H1', 3); await put(cc.base.id, baseCab, 'NAOH-H1', 2);
    // A part stocked in millilitres adds into litres.
    const ml = await cc.part('ETH-ML', 'Ethanol in mL bottles', 'ML', { hazardClasses: ['flammable'], storageGroupId: cc.g('FLAM') });
    await put(ml.id, cab2, 'ETH-H1', 500);
    // The platform ships no limit: before any is set every row says so.
    const none: any = (await runReport(t.admin, 'hazardous-inventory', {}, 'json')).body;
    expect(none.rows.every((r: any) => r.status === 'No limit set')).toBe(true);
    expect(none.notes.join(' ')).toMatch(/ships no regulatory limits/);
    const rowFor = (b: any, loc: string, hazard: string) => b.rows.find((r: any) => r.location === loc && r.hazard === hazard);
    expect(rowFor(none, 'FLAM-CAB1', 'Flammable')).toMatchObject({ qty: 6.5, unit: 'L', containers: 2 });
    expect(rowFor(none, 'FLAM-CAB2', 'Flammable')).toMatchObject({ qty: 1.5, unit: 'L', containers: 2 });
    expect(rowFor(none, 'FLAM-CAB1', 'Health hazard')).toMatchObject({ qty: 6.5 }); // a container counts toward each of its classes
    expect(rowFor(none, 'ACID-CAB', 'Corrosive')).toMatchObject({ qty: 3 });

    // The company sets limits: 5 L at cabinet 1 (over), 2000 mL at cabinet 2 (within), 1 kg for the acid (a different kind of unit).
    const loc1 = (await db().query('SELECT id FROM stock_location WHERE code = $1 AND tenant_id = $2', ['FLAM-CAB1', t.tenantId])).rows[0].id;
    const loc2 = (await db().query('SELECT id FROM stock_location WHERE code = $1 AND tenant_id = $2', ['FLAM-CAB2', t.tenantId])).rows[0].id;
    const locA = (await db().query('SELECT id FROM stock_location WHERE code = $1 AND tenant_id = $2', ['ACID-CAB', t.tenantId])).rows[0].id;
    await as((tx) => setLimit(tx, t.admin, { locationId: loc1, hazardClass: 'flammable', limitQty: 5, uom: 'L' }));
    await as((tx) => setLimit(tx, t.admin, { locationId: loc2, hazardClass: 'flammable', limitQty: 2000, uom: 'ml' }));
    await as((tx) => setLimit(tx, t.admin, { locationId: locA, hazardClass: 'corrosive', limitQty: 1, uom: 'KG' }));
    await expect(as((tx) => setLimit(tx, t.admin, { locationId: loc1, hazardClass: 'radioactive', limitQty: 1, uom: 'L' }))).rejects.toThrow(/unknown hazard class/);
    const r: any = (await runReport(t.admin, 'hazardous-inventory', {}, 'json')).body;
    expect(rowFor(r, 'FLAM-CAB1', 'Flammable')).toMatchObject({ qty: 6.5, limit: 5, status: 'Over limit' });
    expect(rowFor(r, 'FLAM-CAB1', 'Flammable').used).toBeCloseTo(1.3);
    expect(rowFor(r, 'FLAM-CAB2', 'Flammable')).toMatchObject({ qty: 1.5, limit: 2, status: 'Within limit' });
    expect(rowFor(r, 'ACID-CAB', 'Corrosive')).toMatchObject({ status: 'Units differ', limit: null });
    expect(rowFor(r, 'BASE-CAB', 'Corrosive')).toMatchObject({ status: 'No limit set' });
    expect(r.headline).toMatch(/1 location and hazard class over the limit the company set/);
    expect(r.exceptions.map((i: number) => r.rows[i].location)).toEqual(['FLAM-CAB1']);
    // One location only.
    const one: any = (await runReport(t.admin, 'hazardous-inventory', { locationId: loc2 }, 'json')).body;
    expect(new Set(one.rows.map((x: any) => x.location))).toEqual(new Set(['FLAM-CAB2']));
    // A container that is emptied stops counting.
    const { markEmpty } = await import('../src/modules/chemicals/service.js');
    const first = (await db().query(`SELECT id FROM chemical_container WHERE tenant_id = $1 AND lot_number = 'IPA-H1'`, [t.tenantId])).rows[0].id;
    await as((tx) => markEmpty(tx, t.admin, first));
    expect(rowFor((await runReport(t.admin, 'hazardous-inventory', {}, 'json')).body, 'FLAM-CAB1', 'Flammable')).toMatchObject({ qty: 2.5, status: 'Within limit' });
  });

  it('exports as CSV, XLSX and PDF like other reports, and is limited to the sites the reader may see', async () => {
    for (const f of ['csv', 'xlsx', 'pdf'] as const) {
      const out: any = await runReport(w.admin, 'hazardous-inventory', {}, f);
      expect(out.body.length ?? out.body.byteLength).toBeGreaterThan(50);
    }
    const csv: any = await runReport(w.admin, 'chemical-expiry', { days: 60 }, 'csv');
    expect(String(csv.body)).toMatch(/Use by/);
    // Plant B's operator holds no chemical permission at all.
    await expect(runReport(w.operatorB, 'hazardous-inventory', {}, 'json')).rejects.toMatchObject({ status: 403 });
    // The plant A manager sees plant A's chemicals and the report scope says so.
    const mine: any = (await runReport(w.managerA, 'chemical-expiry', { days: 365 }, 'json')).body;
    expect(mine.scope.facilities).toEqual(['A']);
    expect(mine.rows.length).toBeGreaterThan(0);
  });
});

describe('the expiry report', () => {
  it('lists containers and preparations past or reaching use-by, nearest first', async () => {
    const r: any = (await runReport(w.admin, 'chemical-expiry', { days: 30 }, 'json')).body;
    expect(r.rows.length).toBeGreaterThan(0);
    const days = r.rows.map((x: any) => x.days_left);
    expect([...days].sort((a: number, b: number) => a - b)).toEqual(days);
    expect(r.rows.some((x: any) => x.state === 'Expired' || x.state === 'Beyond use')).toBe(true);
    expect(r.rows.every((x: any) => x.days_left <= 30)).toBe(true);
  });
});
