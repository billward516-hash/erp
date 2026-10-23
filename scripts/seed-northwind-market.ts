/**
 * Northwind Market: a five-store grocery chain in two districts. Stores, equipment, temperature limits and
 * contractors come through the import pipeline from samples/imports/northwind-market; three days of the stores'
 * temperature form are generated with recent dates and imported the same way.
 */
import type { Actor } from '../src/platform/auth/actor.js';
import { asActor, loadActor } from '../src/platform/auth/actor.js';
import { getAdminPool } from '../src/platform/db/pool.js';
import { createUserWithToken, provisionTenant } from '../src/platform/tenancy/provision.js';
import { createWorkOrder } from '../src/modules/maintenance/service.js';
import { dispatchVendor } from '../src/modules/maintenance/vendors.js';
import { completeVisit, getVisit, recordVisitItem, saveTemplate, startVisit } from '../src/modules/storeops/service.js';
import { log, runImport, runImportContent } from './seed-lib.js';

const WALK = [
  { area: 'Front', text: 'Entrance, carts and vestibule clean', critical: false }, { area: 'Front', text: 'Automatic doors open and close fully', critical: false },
  { area: 'Sales floor', text: 'Aisles clear, no spills or trip hazards', critical: true }, { area: 'Sales floor', text: 'Shelf tags and prices match', critical: false },
  { area: 'Cold chain', text: 'Coolers and freezers in range; temperature logs complete', critical: true }, { area: 'Cold chain', text: 'No product above the load line in cases', critical: false },
  { area: 'Safety', text: 'Fire exits and extinguishers clear', critical: true }, { area: 'Safety', text: 'Wet-floor signs and spill kit in place', critical: false },
  { area: 'Back room', text: 'Back room organized, nothing on the floor', critical: false }, { area: 'Back room', text: 'Compactor area clean and locked', critical: false },
  { area: 'People', text: 'Schedule posted; training records current', critical: false }, { area: 'Lighting', text: 'All sales-floor and parking lights working', critical: false },
];

export async function seedNorthwindMarket() {
  const db = getAdminPool();
  const t = await provisionTenant(db, { slug: 'northwind-market', name: 'Northwind Market', legalEntity: 'Northwind Market Inc.',
    facilities: [{ code: 'HQ', name: 'Northwind support office', timezone: 'America/New_York', kind: 'office' }] });
  const tokens: Record<string, string> = {};
  const mk = async (label: string, email: string, name: string, roles: { role: string; facility: string | null; group?: string }[]) => {
    const u = await createUserWithToken(db, t.tenantId, { email, displayName: name, roles });
    tokens[label] = u.token;
    return (await loadActor(t.tenantId, u.userId))!;
  };
  const admin = await mk('avery (Northwind Market admin, other tenant)', 'avery.cole@northwind-market.example', 'Avery Cole', [{ role: 'admin', facility: null }]);

  log('Northwind Market: stores, equipment, temperature limits and contractors (import pipeline)');
  await runImport(admin, { file: 'northwind-market/01_store_list.csv', target: 'sites', sourceSystem: 'store-list', profile: 'northwind-market/profiles/store-list.json' });
  await runImport(admin, { file: 'northwind-market/02_store_equipment.csv', target: 'assets', sourceSystem: 'store-equipment', profile: 'northwind-market/profiles/store-equipment.json' });
  await runImport(admin, { file: 'northwind-market/02_store_equipment.csv', target: 'condition_points', sourceSystem: 'store-equipment', profile: 'northwind-market/profiles/store-temperature-limits.json', allowPartial: true });
  await runImport(admin, { file: 'northwind-market/03_contractors.csv', target: 'suppliers', sourceSystem: 'store-contractors', profile: 'northwind-market/profiles/contractors.json' });

  const q = async (sql: string, p: unknown[]) => (await db.query(sql, p)).rows;
  const site = async (code: string) => (await q('SELECT id FROM facility WHERE tenant_id = $1 AND code = $2', [t.tenantId, code]))[0].id as string;
  const group = async (code: string) => (await q('SELECT id FROM facility_group WHERE tenant_id = $1 AND code = $2', [t.tenantId, code]))[0].id as string;
  const asset = async (tag: string) => (await q('SELECT id FROM asset WHERE tenant_id = $1 AND asset_tag = $2', [t.tenantId, tag]))[0].id as string;
  const jo = await mk('jo (district manager, EAST district)', 'jo.rivera@northwind-market.example', 'Jo Rivera', [{ role: 'district_manager', facility: null, group: await group('EAST') }]);
  const mina = await mk('mina (store manager, S101)', 'mina.shah@northwind-market.example', 'Mina Shah', [{ role: 'store_manager', facility: await site('S101') }]);
  await mk('leo (store manager, S102)', 'leo.park@northwind-market.example', 'Leo Park', [{ role: 'store_manager', facility: await site('S102') }]);

  log('Northwind Market: three days of the store temperature form');
  // Twice a day at 06:00 and 18:00 store time. S102's produce cooler is warming since last night; S101's freezer
  // went up during a stuck defrost and came back; Express 103 stopped logging two days ago.
  const local = (d: Date) => d.toLocaleString('sv-SE', { timeZone: 'America/New_York' });
  const slots: Date[] = [];
  for (let h = 72; h >= 0; h -= 1) {
    const d = new Date(Date.now() - h * 3_600_000);
    const hh = Number(local(d).slice(11, 13));
    if (hh === 6 || hh === 18) slots.push(d);
  }
  const rows = ['Store #,Date,Time,Equipment,Temp (°F),Initials,Corrective action'];
  const points: [string, string, (i: number, n: number) => number | null, string?][] = [
    ['101', 'WIC-1', (i) => 36 + (i % 3)], ['101', 'WIF-1', (i, n) => (i === n - 3 ? 8 : -4 + (i % 2))], ['102', 'WIC-1', (i, n) => (i >= n - 2 ? 44 + (i - (n - 2)) * 2 : 37 + (i % 2))],
    ['102', 'WIF-1', (i) => -5 + (i % 2)], ['103', 'RIC-1', (i, n) => (i < n - 4 ? 38 : null)], ['201', 'WIC-1', (i) => 35 + (i % 3)], ['201', 'WIF-1', (i) => -6 + (i % 3)], ['202', 'WIC-1', (i) => 38],
  ];
  for (const [store, eq, value] of points) {
    slots.forEach((d, i) => {
      const v = value(i, slots.length);
      if (v == null) return;
      const note = store === '101' && eq === 'WIF-1' && v > 0 ? 'Defrost stuck on; reset timer, moved ice cream to back-up freezer' : store === '102' && v > 41 ? 'Told manager' : '';
      rows.push(`${store},${local(d).slice(0, 10)},${local(d).slice(11, 16)},${eq},${v},${store === '101' ? 'MS' : store === '102' ? 'LP' : 'TK'},${note}`);
    });
  }
  await runImportContent(admin, { fileName: 'temperature-form-export.csv', content: Buffer.from(rows.join('\n')), target: 'condition_readings', sourceSystem: 'temp-log-form', profile: 'northwind-market/profiles/temp-log-form.json' });

  // The warm produce cooler: the district manager sends refrigeration out with a not-to-exceed.
  const req = (await q(`SELECT id FROM maintenance_request WHERE tenant_id = $1 AND source = 'condition' AND status = 'open' AND asset_id = $2`, [t.tenantId, await asset('S102-WIC-1')]))[0];
  const wo = await asActor(jo, async (tx) => createWorkOrder(tx, jo, { assetId: await asset('S102-WIC-1'), requestId: req.id, title: 'Produce walk-in cooler running warm (46°F)', priority: 1 }));
  await asActor(jo, async (tx) => dispatchVendor(tx, jo, wo.id, { supplierId: (await q('SELECT id FROM supplier WHERE tenant_id = $1 AND code = $2', [t.tenantId, 'NW-301']))[0].id, nteAmount: 600,
    note: 'Produce moved to the dairy cooler. Store opens 7am.' }));

  log('Northwind Market: monthly store walks');
  const tpl = await asActor(jo, (tx) => saveTemplate(tx, jo, { code: 'WALK', name: 'Monthly store walk', items: WALK }));
  const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
  const walk = async (store: string, on: string, fails: Record<number, [string, string?]>, owner: Actor | null) => {
    const v = await asActor(jo, async (tx) => startVisit(tx, jo, { facilityId: await site(store), templateId: tpl.id, visitedOn: on }));
    const items = (await asActor(jo, (tx) => getVisit(tx, jo, v.id))).items;
    for (const it of items) {
      const f = fails[it.seq];
      await asActor(jo, async (tx) => recordVisitItem(tx, jo, it.id, f ? { result: 'fail', note: f[0], assetId: f[1] ? await asset(f[1]) : null } : { result: 'pass' }));
    }
    await asActor(jo, (tx) => completeVisit(tx, jo, v.id, { actionOwnerUserId: owner?.userId ?? null, summary: Object.keys(fails).length ? 'See failed items.' : 'Good walk.' }));
  };
  await walk('S101', day(-34), { 9: ['Pallets of water in the aisle to the cooler'] }, mina);
  await walk('S101', day(-3), { 2: ['Left door stops half open', 'S101-DOOR-1'], 5: ['Freezer log missing two readings last week'], 9: ['Back room aisle blocked again'] }, mina);
  await walk('S102', day(-5), {}, null);
  return { tokens };
}
