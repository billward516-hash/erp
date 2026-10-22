/**
 * Harborview Property Group: a landlord with four properties in two portfolios, run mostly through contractors.
 * Everything a customer would bring is loaded through the import pipeline from samples/imports/harborview in the
 * shape property-management systems export it (property directory, unit directory, equipment list, vendor list).
 */
import type { Actor } from '../src/platform/auth/actor.js';
import { asActor, loadActor } from '../src/platform/auth/actor.js';
import { getAdminPool } from '../src/platform/db/pool.js';
import { createUserWithToken, provisionTenant } from '../src/platform/tenancy/provision.js';
import { approveInvoice, captureInvoice } from '../src/modules/ap/service.js';
import { createWorkOrder, transitionWorkOrder } from '../src/modules/maintenance/service.js';
import { dispatchVendor, recordVendorUpdate } from '../src/modules/maintenance/vendors.js';
import { createRequestLink, submitPublicRequest } from '../src/modules/sites/service.js';
import { log, runImport } from './seed-lib.js';

export async function seedHarborview() {
  const db = getAdminPool();
  const t = await provisionTenant(db, { slug: 'harborview', name: 'Harborview Property Group', legalEntity: 'Harborview Property Group LLC',
    facilities: [{ code: 'HQ', name: 'Harborview office', timezone: 'America/New_York', kind: 'office' }] });
  const tokens: Record<string, string> = {};
  const mk = async (label: string, email: string, name: string, roles: { role: string; facility: string | null; group?: string }[]) => {
    const u = await createUserWithToken(db, t.tenantId, { email, displayName: name, roles });
    tokens[label] = u.token;
    return u.userId;
  };
  const adminId = await mk('riya (Harborview admin, other tenant)', 'riya.patel@harborview.example', 'Riya Patel', [{ role: 'admin', facility: null }]);
  const admin = (await loadActor(t.tenantId, adminId))!;

  log('Harborview: property directory, units, equipment and vendors (import pipeline)');
  await runImport(admin, { file: 'harborview/01_property_directory.csv', target: 'sites', sourceSystem: 'pm-property-directory' });
  await runImport(admin, { file: 'harborview/02_unit_directory.csv', target: 'assets', sourceSystem: 'pm-unit-directory', profile: 'harborview/profiles/unit-directory.json' });
  await runImport(admin, { file: 'harborview/03_building_equipment.csv', target: 'assets', sourceSystem: 'pm-equipment-list', profile: 'harborview/profiles/building-equipment.json' });
  await runImport(admin, { file: 'harborview/04_vendor_list.csv', target: 'suppliers', sourceSystem: 'pm-vendor-list', profile: 'harborview/profiles/vendor-list.json' });

  const q = async (sql: string, p: unknown[]) => (await db.query(sql, p)).rows;
  const group = async (code: string) => (await q('SELECT id FROM facility_group WHERE tenant_id = $1 AND code = $2', [t.tenantId, code]))[0].id as string;
  const site = async (code: string) => (await q('SELECT id FROM facility WHERE tenant_id = $1 AND code = $2', [t.tenantId, code]))[0].id as string;
  const asset = async (tag: string) => (await q('SELECT id FROM asset WHERE tenant_id = $1 AND asset_tag = $2', [t.tenantId, tag]))[0].id as string;
  const vendor = async (code: string) => (await q('SELECT id FROM supplier WHERE tenant_id = $1 AND code = $2', [t.tenantId, code]))[0].id as string;
  const backdate = (id: string, hoursAgo: number) => db.query(`UPDATE work_order SET created_at = now() - make_interval(hours => $2) WHERE id = $1`, [id, hoursAgo]);

  const devId = await mk('dev (property manager, Ohio residential portfolio)', 'dev.okafor@harborview.example', 'Dev Okafor', [{ role: 'property_manager', facility: null, group: await group('OH-RES') }]);
  const marisolId = await mk('marisol (property manager, commercial portfolio)', 'marisol.vega@harborview.example', 'Marisol Vega', [{ role: 'property_manager', facility: null, group: await group('COMMERCIAL') }]);
  const noorId = await mk('noor (Harborview finance approver)', 'noor.haddad@harborview.example', 'Noor Haddad', [{ role: 'finance_approver', facility: null }]);
  const dev = (await loadActor(t.tenantId, devId))!;
  const marisol = (await loadActor(t.tenantId, marisolId))!;
  const noor = (await loadActor(t.tenantId, noorId))!;

  log('Harborview: resident requests through a lobby link, contractor dispatch and invoices');
  const link = await asActor(dev, async (tx) => createRequestLink(tx, dev, await site('MAPLE'), 'Residents, Maple Court lobby poster'));
  tokens['maple court resident request link (no sign-in)'] = link.token;
  await submitPublicRequest(link.token, { placeId: await asset('MAPLE-101'), description: 'Water dripping from the bathroom ceiling, getting worse', name: 'Alicia Gomez (101)',
    contact: '614-555-0191', entryPermission: true, urgent: true });
  const birchLink = await asActor(dev, async (tx) => createRequestLink(tx, dev, await site('BIRCH'), 'Residents, Birch Flats'));
  await submitPublicRequest(birchLink.token, { placeId: await asset('BIRCH-COMMON'), description: 'Hallway light out on the second floor by 2B', name: 'Tom Reyes (2A)', contact: 'tom.reyes@example.com' });

  // Ceiling leak below 102: converted from the resident's request, sent to the plumber with a not-to-exceed, accepted.
  const req = (await q(`SELECT id FROM maintenance_request WHERE tenant_id = $1 AND symptom LIKE 'Water dripping%'`, [t.tenantId]))[0].id;
  const leak = await asActor(dev, async (tx) => createWorkOrder(tx, dev, { assetId: await asset('MAPLE-101'), requestId: req, title: 'Ceiling leak in 101 bathroom (likely from 201 above)', priority: 2,
    description: 'Resident Alicia Gomez 614-555-0191, may enter. Check 201 tub drain and supply.' }));
  await asActor(dev, async (tx) => dispatchVendor(tx, dev, leak.id, { supplierId: await vendor('V-1001'), nteAmount: 450, note: 'Start in 201 (vacant? no, occupied: call first)' }));
  await asActor(dev, (tx) => recordVendorUpdate(tx, dev, leak.id, { event: 'accepted', reference: 'FR-22817' }));

  // Willow garage door: raised four days ago, nobody has responded (past the 72 h target for priority 3).
  const door = await asActor(dev, async (tx) => createWorkOrder(tx, dev, { assetId: await asset('WILLOW-13'), title: 'Garage door opener not working', priority: 3 }));
  await backdate(door.id, 96);

  // Cedar Plaza RTU: done by the HVAC contractor two days ago; invoiced over the not-to-exceed, approved with a note.
  const rtu = await asActor(marisol, async (tx) => createWorkOrder(tx, marisol, { assetId: await asset('CEDAR-RTU-1'), title: 'Suite 100 not cooling', priority: 2 }));
  await asActor(marisol, async (tx) => dispatchVendor(tx, marisol, rtu.id, { supplierId: await vendor('V-1002'), nteAmount: 800 }));
  await asActor(marisol, (tx) => recordVendorUpdate(tx, marisol, rtu.id, { event: 'accepted', reference: 'BH-4410' }));
  await asActor(marisol, (tx) => recordVendorUpdate(tx, marisol, rtu.id, { event: 'completed', note: 'Replaced failed condenser fan motor and capacitor; cooling restored' }));
  await db.query(`UPDATE work_order SET created_at = now() - interval '52 hours', dispatched_at = now() - interval '51 hours', vendor_accepted_at = now() - interval '49 hours',
    responded_at = now() - interval '49 hours', started_at = now() - interval '30 hours', completed_at = now() - interval '28 hours' WHERE id = $1`, [rtu.id]);
  await asActor(admin, (tx) => transitionWorkOrder(tx, admin, rtu.id, { to: 'verified' }));
  const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
  const inv = await asActor(admin, async (tx) => captureInvoice(tx, admin, null, { supplierId: await vendor('V-1002'), workOrderId: rtu.id, invoiceNumber: 'BH-4410', invoiceDate: day(-1),
    lines: [{ description: 'Service call and diagnosis', qty: 1, unitPrice: 145 }, { description: 'Condenser fan motor 1/3 hp', qty: 1, unitPrice: 486 }, { description: 'Run capacitor', qty: 1, unitPrice: 64 },
      { description: 'Labor 2 h', qty: 2, unitPrice: 112.5 }] }));
  await asActor(noor, (tx) => approveInvoice(tx, noor, inv.id, { varianceNote: 'Marisol approved the capacitor by phone; $120 over the limit' }));
  return { tokens };
}
