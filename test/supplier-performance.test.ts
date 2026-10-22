import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asActor, loadActor } from '../src/platform/auth/actor.js';
import type { Actor } from '../src/platform/auth/actor.js';
import { closePools, getAdminPool } from '../src/platform/db/pool.js';
import { createUserWithToken } from '../src/platform/tenancy/provision.js';
import { runReminders } from '../src/modules/notifications/reminders.js';
import { commitImport, stageImport } from '../src/modules/imports/service.js';
import { createPart } from '../src/modules/parts/service.js';
import { createSupplier, setSupplierPrice } from '../src/modules/purchasing/service.js';
import { issueScar, recordSupplierResponse, supplierScorecards } from '../src/modules/purchasing/supplier-performance.js';
import { createNcr, getCapa } from '../src/modules/quality/service.js';
import { getReport } from '../src/modules/reporting/registry.js';
import type { World } from './fixtures.js';
import { makeWorld } from './fixtures.js';

const db = () => getAdminPool();
let w: World; let qm: Actor; let site: string; let part: string;
const S: Record<string, string> = {};
const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
let seq = 0;

/** An order line due `dueIn` days from today, with receipts [daysFromToday, qty]. Inserted directly: these tests are about measuring, not ordering. */
async function line(supplier: string, dueIn: number, qty: number, price: number, receipts: [number, number][]) {
  seq++;
  const pr = (await db().query(`INSERT INTO purchase_request (tenant_id, facility_id, number, title, requested_by, status) VALUES ($1, $2, $3, 'x', $4, 'approved') RETURNING id`,
    [w.tenantId, site, `PRT-${seq}`, w.admin.userId])).rows[0].id;
  const rl = (await db().query(`INSERT INTO purchase_request_line (tenant_id, request_id, line_no, part_id, description, qty, uom) VALUES ($1, $2, 1, $3, 'Bar', $4, 'EA') RETURNING id`,
    [w.tenantId, pr, part, qty])).rows[0].id;
  const po = (await db().query(`INSERT INTO purchase_order (tenant_id, facility_id, number, supplier_id, expected_on, created_by, created_at) VALUES ($1, $2, $3, $4, $5, $6, now() - interval '20 days') RETURNING id`,
    [w.tenantId, site, `POT-${seq}`, supplier, day(dueIn), w.admin.userId])).rows[0].id;
  const l = (await db().query(`INSERT INTO purchase_order_line (tenant_id, order_id, line_no, request_line_id, part_id, description, qty_ordered, qty_received, unit_price) VALUES ($1, $2, 1, $3, $4, 'Bar', $5, $6, $7) RETURNING id`,
    [w.tenantId, po, rl, part, qty, receipts.reduce((t, r) => t + r[1], 0), price])).rows[0].id;
  for (const [d, q] of receipts) await db().query(`INSERT INTO po_receipt (tenant_id, order_line_id, qty, received_by, received_at) VALUES ($1, $2, $3, $4, $5::date + time '10:00')`, [w.tenantId, l, q, w.admin.userId, day(d)]);
}

beforeAll(async () => {
  w = await makeWorld('sup');
  site = w.facilities.A!;
  const u = await createUserWithToken(db(), w.tenantId, { email: `qm-${Date.now()}@sup.example`, displayName: 'Quality Manager', roles: [{ role: 'quality_manager', facility: site }] });
  qm = (await loadActor(w.tenantId, u.userId))!;
  await asActor(w.admin, async (tx) => {
    part = (await createPart(tx, w.admin, { partNumber: 'BAR-1', description: 'Bar', uom: 'EA' })).id;
    S.late = (await createSupplier(tx, w.admin, { code: 'LATE', name: 'Latecomer Metals', email: 'quality@latecomer.example' })).id;
    S.good = (await createSupplier(tx, w.admin, { code: 'GOOD', name: 'Good Bar Co' })).id;
    await setSupplierPrice(tx, w.admin, S.late!, part, { unitPrice: 10 });
  });
  // Latecomer: 4 lines on time, 1 three days late, 1 open five days past due with half received; one line priced above the quote.
  for (let i = 0; i < 4; i++) await line(S.late!, -30 + i * 5, 100, 10, [[-32 + i * 5, 100]]);
  await line(S.late!, -10, 100, 10.2, [[-7, 100]]);
  await line(S.late!, -5, 100, 10, [[-8, 50]]);
  // Good Bar: 5 lines, all on time, split receipts on one.
  for (let i = 0; i < 5; i++) await line(S.good!, -40 + i * 7, 100, 9, i === 0 ? [[-45, 40], [-41, 60]] : [[-41 + i * 7, 100]]);
});
afterAll(closePools);

describe('supplier scorecards', () => {
  it('measure delivery, quality and price from orders, receipts and nonconformances', async () => {
    await asActor(qm, (tx) => createNcr(tx, qm, { facilityId: site, source: 'receiving', supplierId: S.late, partId: part, qty: 11, severity: 'major', description: 'Bar out of straightness, 11 pcs' }));
    const r = await asActor(qm, (tx) => supplierScorecards(tx, qm, { facilityId: site }));
    const late = r.suppliers.find((s) => s.code === 'LATE')!; const good = r.suppliers.find((s) => s.code === 'GOOD')!;
    // 6 lines due: 4 on time, 1 late by 3 days, 1 open 5 days past due → 66.7% on time, average 4 days late.
    expect(late.delivery).toMatchObject({ linesDue: 6, onTime: 0.667, late: 2, avgDaysLate: 4, openPastDue: 1, tone: 'poor' });
    // 550 received + 11 held at receiving = 561 inspected, 11 rejected → 19,608 ppm.
    expect(late.quality).toMatchObject({ received: 550, inspected: 561, rejected: 11, ppm: 19608, ncrs: 1, tone: 'poor' });
    expect(late.price).toMatchObject({ lines: 6, aboveQuote: 1 });
    expect(late.overall).toBe('poor');
    expect(good.delivery).toMatchObject({ linesDue: 5, onTime: 1, tone: 'good' });
    expect(good).toMatchObject({ overall: 'good' });
    expect(r.suppliers[0]!.code).toBe('LATE'); // worst first
  });
});

describe('supplier corrective action requests', () => {
  it('are issued against the supplier\'s nonconformances, emailed, answered, and chased when late', async () => {
    const ncr = (await db().query(`SELECT id FROM nonconformance WHERE supplier_id = $1`, [S.late])).rows[0].id;
    await expect(asActor(w.techA, (tx) => issueScar(tx, w.techA, { facilityId: site, supplierId: S.late!, title: 'x', problem: 'x', ownerUserId: qm.userId }))).rejects.toThrow(/quality.manage/);
    await expect(asActor(qm, (tx) => issueScar(tx, qm, { facilityId: site, supplierId: S.good!, title: 'x', problem: 'x', ownerUserId: qm.userId, ncrIds: [ncr] }))).rejects.toThrow(/different supplier/);
    const c = await asActor(qm, (tx) => issueScar(tx, qm, { facilityId: site, supplierId: S.late!, title: 'Bar straightness', problem: '11 of 100 bars out of straightness on receipt',
      ownerUserId: qm.userId, ncrIds: [ncr], responseDays: 10 }));
    expect(c).toMatchObject({ source: 'supplier', supplier_id: S.late, emailed: 'quality@latecomer.example' });
    const mail = (await db().query(`SELECT subject, body_text FROM email_message WHERE dedupe_key = $1`, [`scar:${c.id}`])).rows[0];
    expect(mail.subject).toMatch(/^Corrective action request CA-\d+: Bar straightness$/);
    expect(mail.body_text).toMatch(/NCR-\d+ .*\(qty 11\)/);
    await expect(asActor(qm, (tx) => issueScar(tx, qm, { facilityId: site, supplierId: S.late!, title: 'again', problem: 'x', ownerUserId: qm.userId, ncrIds: [ncr] }))).rejects.toThrow(/already covered/);
    // Past its response date with no answer: the owner is reminded and the supplier rates poor on response.
    await db().query(`UPDATE corrective_action SET supplier_response_due = $2 WHERE id = $1`, [c.id, day(-1)]);
    await runReminders(w.tenantId);
    expect((await db().query(`SELECT count(*)::int AS n FROM notification WHERE user_id = $1 AND kind = 'reminder.scar_overdue'`, [qm.userId])).rows[0].n).toBe(1);
    expect((await asActor(qm, (tx) => supplierScorecards(tx, qm, { supplierId: S.late }))).suppliers[0]!.scars[0]).toMatchObject({ overdue: true, responded: false });
    await asActor(qm, (tx) => recordSupplierResponse(tx, qm, c.id, { response: '8D received: straightening rolls worn; replaced, 100% check for 3 lots', rootCause: 'Worn straightening rolls' }));
    const v = await asActor(qm, (tx) => getCapa(tx, qm, c.id));
    expect(v).toMatchObject({ supplier_name: 'Latecomer Metals', root_cause: 'Worn straightening rolls', supplier_response_overdue: false });
    const def = getReport('supplier-performance')!;
    const rep = await asActor(w.admin, (tx) => def.run(tx, w.admin, def.params.parse({ facilityId: site })));
    expect(rep.headline).toBe('1 supplier rated poor: Latecomer Metals');
  });
});

describe('delivery history from the previous system', () => {
  it('imports a receipts report in its own headers and counts it in the scorecard', async () => {
    const d = (n: number) => { const x = new Date(Date.now() + n * 86_400_000); return `${x.getMonth() + 1}/${x.getDate()}/${x.getFullYear()}`; };
    const csv = Buffer.from(['Vendor,PO#,Item,Order Qty,Promise Date,GR Date,GR Qty,Rejects',
      `Good Bar Co,4500100-10,BAR-1,200,${d(-60)},${d(-62)},200,0`,
      `Good Bar Co,4500101-10,BAR-1,200,${d(-50)},${d(-44)},200,4`,
      `Good Bar Co,4500102-10,BAR-1,100,${d(-20)},,,`,
      `Nobody Inc,4500103-10,BAR-1,100,${d(-20)},,,`,
      `Good Bar Co,4500104-10,BAR-1,100,${d(-10)},${d(-11)},50,60`].join('\n'));
    const st = await stageImport(w.admin, { target: 'supplier_deliveries', sourceSystem: 'sap-me80fn', fileName: 'receipts.csv', content: csv, facilityId: site });
    expect(st.stats).toMatchObject({ total: 5, errors: 2 }); // unknown supplier; more rejected than received
    await commitImport(w.admin, st.batchId, { allowPartial: true });
    const g = (await asActor(qm, (tx) => supplierScorecards(tx, qm, { supplierId: S.good }))).suppliers[0]!;
    // Native: 5 lines on time. History: 1 on time, 1 six days late, 1 open past due → 6 of 8 on time.
    expect(g.delivery).toMatchObject({ linesDue: 8, onTime: 0.75, late: 2 });
    expect(g.legacyLines).toBe(3);
    // Received 500 native + 400 history, 4 rejected → 4,444 ppm.
    expect(g.quality).toMatchObject({ received: 900, rejected: 4, ppm: 4444 });
    // Re-importing the same report changes nothing.
    const st2 = await stageImport(w.admin, { target: 'supplier_deliveries', sourceSystem: 'sap-me80fn', fileName: 'receipts.csv', content: csv, facilityId: site });
    await commitImport(w.admin, st2.batchId, { allowPartial: true });
    expect((await db().query('SELECT count(*)::int AS n FROM supplier_delivery_history WHERE supplier_id = $1', [S.good])).rows[0].n).toBe(3);
  });
});
