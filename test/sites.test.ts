import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asActor, loadActor } from '../src/platform/auth/actor.js';
import type { Actor } from '../src/platform/auth/actor.js';
import { closePools, getAdminPool } from '../src/platform/db/pool.js';
import { createUserWithToken } from '../src/platform/tenancy/provision.js';
import { usersWithPermission } from '../src/platform/notify/notify.js';
import { createAsset } from '../src/modules/assets/service.js';
import { approveInvoice, captureInvoice, matchCheck } from '../src/modules/ap/service.js';
import { createWorkOrder, getWorkOrder, listRequests, rejectRequest, transitionWorkOrder } from '../src/modules/maintenance/service.js';
import { dispatchVendor, recordVendorUpdate, saveContractor, slaOf } from '../src/modules/maintenance/vendors.js';
import { createSupplier } from '../src/modules/purchasing/service.js';
import { getReport } from '../src/modules/reporting/registry.js';
import { createRequestLink, grantRole, listSites, publicRequestForm, revokeRequestLink, saveGroup, saveSite, submitPublicRequest } from '../src/modules/sites/service.js';
import type { World } from './fixtures.js';
import { makeWorld } from './fixtures.js';

const db = () => getAdminPool();
const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
let w: World;
let pm: Actor; let pmUserId: string;
let maple: any; let birch: any; let cedar: any;
let unit4b: string; let plumber: string;

beforeAll(async () => {
  w = await makeWorld('sites');
  maple = await asActor(w.admin, (tx) => saveSite(tx, w.admin, { code: 'MAPLE', name: 'Maple Court', kind: 'property', timezone: 'America/Chicago', address: { line1: '12 Maple St', city: 'Dayton', region: 'OH' } }));
  birch = await asActor(w.admin, (tx) => saveSite(tx, w.admin, { code: 'BIRCH', name: 'Birch Flats', kind: 'property' }));
  cedar = await asActor(w.admin, (tx) => saveSite(tx, w.admin, { code: 'CEDAR', name: 'Cedar Plaza', kind: 'property' }));
  const g = await asActor(w.admin, (tx) => saveGroup(tx, w.admin, { code: 'EAST', name: 'East portfolio', kind: 'portfolio', facilityIds: [maple.id, birch.id] }));
  const u = await createUserWithToken(db(), w.tenantId, { email: `pm-${Date.now()}@s.example`, displayName: 'Pat Manager', roles: [] });
  pmUserId = u.userId;
  await asActor(w.admin, (tx) => grantRole(tx, w.admin, { userId: u.userId, roleKey: 'property_manager', groupId: g.id }));
  pm = (await loadActor(w.tenantId, u.userId))!;
  const building = await asActor(w.admin, (tx) => createAsset(tx, w.admin, { facilityId: maple.id, assetTag: 'MAPLE-B1', name: 'Building 1', assetClass: 'space' }));
  unit4b = (await asActor(w.admin, (tx) => createAsset(tx, w.admin, { facilityId: maple.id, assetTag: 'MAPLE-4B', name: 'Unit 4B', assetClass: 'space', parentAssetId: building.id }))).id;
  plumber = (await asActor(w.admin, (tx) => createSupplier(tx, w.admin, { code: 'FLOW', name: 'Flow Plumbing', email: 'dispatch@flow.example', paymentTerms: 'Net 30' }))).id;
});
afterAll(closePools);

describe('sites and portfolios', () => {
  it('a grant on a portfolio reaches its member sites and nothing else', async () => {
    expect(pm.grants.map((g) => g.facilityId).sort()).toEqual([maple.id, birch.id].sort());
    const sites = await asActor(pm, (tx) => listSites(tx, pm, { kind: 'property' }));
    expect(sites.map((s: any) => s.code)).toEqual(['BIRCH', 'MAPLE']);
    expect(sites.find((s: any) => s.code === 'MAPLE')).toMatchObject({ spaces: 2, groups: ['EAST'] });
    // Row-level security: nothing of Cedar is readable, and the grant counts for notifications.
    await expect(asActor(pm, (tx) => createAsset(tx, pm, { facilityId: cedar.id, assetTag: 'X', name: 'X' }))).rejects.toThrow();
    expect(await asActor(w.admin, (tx) => usersWithPermission(tx, 'work_orders.manage', maple.id))).toContain(pmUserId);
    expect(await asActor(w.admin, (tx) => usersWithPermission(tx, 'work_orders.manage', cedar.id))).not.toContain(pmUserId);
  });

  it('only administrators create sites; codes are unique and validated', async () => {
    await expect(asActor(pm, (tx) => saveSite(tx, pm, { code: 'OAK', name: 'Oak', kind: 'property' }))).rejects.toThrow(/tenant.admin/);
    await expect(asActor(w.admin, (tx) => saveSite(tx, w.admin, { code: 'maple', name: 'Dup', kind: 'property' }))).rejects.toThrow(/already exists/);
    await expect(asActor(w.admin, (tx) => saveSite(tx, w.admin, { code: 'BAD CODE', name: 'x', kind: 'store' }))).rejects.toThrow(/site codes/);
    await expect(asActor(w.admin, (tx) => saveSite(tx, w.admin, { code: 'TZ', name: 'x', kind: 'store', timezone: 'Mars/Olympus' }))).rejects.toThrow(/time zone/);
  });
});

describe('requests from people without a login', () => {
  let token: string;
  it('a site link opens only that site\'s spaces, takes a request, and stops working when revoked', async () => {
    const link = await asActor(pm, (tx) => createRequestLink(tx, pm, maple.id, 'Residents, Maple Court'));
    token = link.token;
    await expect(asActor(pm, (tx) => createRequestLink(tx, pm, cedar.id, 'x'))).rejects.toThrow();
    const form = await publicRequestForm(token);
    expect(form).toEqual({ site: 'Maple Court', kind: 'property', places: [{ id: expect.any(String), label: 'Building 1' }, { id: unit4b, label: 'Building 1 › Unit 4B' }] });
    await expect(submitPublicRequest(token, { placeId: unit4b, description: 'x', name: 'A', contact: '555' })).rejects.toThrow(/describe/);
    const r = await submitPublicRequest(token, { placeId: unit4b, description: 'Kitchen sink leaking under the cabinet', name: 'Jamie Lee', contact: '555-0101', entryPermission: true, urgent: true });
    expect(r.reference).toMatch(/^R-[0-9A-F]{8}$/);
    const inbox = await asActor(pm, (tx) => listRequests(tx, pm));
    expect(inbox[0]).toMatchObject({ source: 'public', requester: 'Jamie Lee', requester_contact: '555-0101', entry_permission: true, severity: 'high', asset_name: 'Unit 4B' });
    const bell = await db().query(`SELECT count(*)::int AS n FROM notification WHERE user_id = $1 AND kind = 'maintenance.request_received'`, [pmUserId]);
    expect(bell.rows[0].n).toBe(1);
    await asActor(pm, (tx) => revokeRequestLink(tx, pm, link.id));
    await expect(publicRequestForm(token)).rejects.toThrow(/not found/);
    await expect(publicRequestForm('req_not-a-real-token-at-all-0000')).rejects.toThrow(/not found/);
  });

  it('a request elsewhere cannot be sent through another site\'s link; requests can be declined with a reason', async () => {
    const other = await asActor(w.admin, (tx) => createAsset(tx, w.admin, { facilityId: birch.id, assetTag: 'BIRCH-1A', name: 'Unit 1A', assetClass: 'space' }));
    const link = await asActor(pm, (tx) => createRequestLink(tx, pm, maple.id, 'Lobby poster'));
    await expect(submitPublicRequest(link.token, { placeId: other.id, description: 'Door will not lock', name: 'B', contact: '555-0102' })).rejects.toThrow(/choose where/);
    const r = await submitPublicRequest(link.token, { placeId: unit4b, description: 'Neighbour is noisy at night', name: 'C', contact: 'c@example.com' });
    const req = (await asActor(pm, (tx) => listRequests(tx, pm))).find((x: any) => x.symptom.startsWith('Neighbour'));
    await asActor(pm, (tx) => rejectRequest(tx, pm, req.id, 'Not a maintenance issue; passed to the leasing office'));
    expect(r.reference).toBeTruthy();
  });
});

describe('contractors', () => {
  let wo: any;
  it('dispatch needs a current certificate of insurance and emails the contractor with the not-to-exceed', async () => {
    wo = await asActor(pm, (tx) => createWorkOrder(tx, pm, { assetId: unit4b, title: 'Leak under kitchen sink', priority: 2 }));
    await expect(asActor(pm, (tx) => dispatchVendor(tx, pm, wo.id, { supplierId: plumber, nteAmount: 400 }))).rejects.toThrow(/no certificate of insurance/);
    await asActor(pm, (tx) => saveContractor(tx, pm, plumber, { trades: ['Plumbing', 'plumbing', 'Drains'], insuranceExpiresOn: day(-1) }));
    await expect(asActor(pm, (tx) => dispatchVendor(tx, pm, wo.id, { supplierId: plumber, nteAmount: 400 }))).rejects.toThrow(/expired/);
    await asActor(pm, (tx) => saveContractor(tx, pm, plumber, { trades: ['plumbing', 'drains'], insuranceExpiresOn: day(200) }));
    expect(await asActor(pm, (tx) => dispatchVendor(tx, pm, wo.id, { supplierId: plumber, nteAmount: 400, note: 'Resident home after 5pm' }))).toEqual({ emailed: 'dispatch@flow.example' });
    const mail = await db().query(`SELECT subject, body_text FROM email_message WHERE tenant_id = $1 AND kind = 'vendor_dispatch'`, [w.tenantId]);
    expect(mail.rows[0].subject).toBe(`Work order ${wo.number} at Maple Court`);
    expect(mail.rows[0].body_text).toMatch(/Not to exceed: \$400\.00[\s\S]*Resident home after 5pm/);
    expect((await asActor(pm, (tx) => getWorkOrder(tx, pm, wo.id)))).toMatchObject({ status: 'scheduled', vendor_status: 'dispatched', vendor_name: 'Flow Plumbing' });
  });

  it('acceptance stops the response clock; completion by the contractor completes the job; someone else verifies', async () => {
    await expect(asActor(pm, (tx) => recordVendorUpdate(tx, pm, wo.id, { event: 'completed' }))).rejects.toThrow(/remedy/);
    await asActor(pm, (tx) => recordVendorUpdate(tx, pm, wo.id, { event: 'accepted', reference: 'FLOW-7781' }));
    await expect(asActor(pm, (tx) => recordVendorUpdate(tx, pm, wo.id, { event: 'declined' }))).rejects.toThrow(/not yet accepted/);
    await asActor(pm, (tx) => recordVendorUpdate(tx, pm, wo.id, { event: 'completed', note: 'Replaced P-trap and supply line' }));
    const v = await asActor(pm, (tx) => getWorkOrder(tx, pm, wo.id));
    expect(v).toMatchObject({ status: 'completed', vendor_status: 'completed', vendor_reference: 'FLOW-7781', remedy: 'Replaced P-trap and supply line (contractor)' });
    expect(v.sla).toMatchObject({ respond: { state: 'met' }, complete: { state: 'met' } });
    await expect(asActor(pm, (tx) => transitionWorkOrder(tx, pm, wo.id, { to: 'verified' }))).rejects.toThrow(/someone other/);
  });

  it('the contractor\'s invoice ties to the work order and is held to the not-to-exceed', async () => {
    const inv = await asActor(w.admin, (tx) => captureInvoice(tx, w.admin, null, { supplierId: plumber, workOrderId: wo.id, invoiceNumber: 'F-1001', invoiceDate: day(0),
      lines: [{ description: 'Labor 3 h', qty: 3, unitPrice: 95 }, { description: 'P-trap kit', qty: 1, unitPrice: 160 }] }));
    expect(inv.facility_id).toBe(maple.id);
    const m = await asActor(w.admin, (tx) => matchCheck(tx, inv.id));
    expect(m.issues).toEqual([`invoices for ${wo.number} total 445.00, over the not-to-exceed of 400.00`]);
    const finance = w.finance;
    await expect(asActor(finance, (tx) => approveInvoice(tx, finance, inv.id))).rejects.toThrow(/does not match/);
    await asActor(finance, (tx) => approveInvoice(tx, finance, inv.id, { varianceNote: 'Pat approved the extra trap by phone' }));
    const v = await asActor(w.admin, (tx) => getWorkOrder(tx, w.admin, wo.id));
    expect(v.vendorSpend).toMatchObject({ total: 445, overNte: true });
    const other = await asActor(w.admin, (tx) => createSupplier(tx, w.admin, { code: 'ACME', name: 'Acme Electric' }));
    await expect(asActor(w.admin, (tx) => captureInvoice(tx, w.admin, null, { supplierId: other.id, workOrderId: wo.id, invoiceNumber: 'A-1', invoiceDate: day(0), lines: [{ description: 'x', qty: 1, unitPrice: 1 }] })))
      .rejects.toThrow(/different contractor/);
  });

  it('service levels: missed and at-risk states, and the report by contractor', async () => {
    const levels = new Map([[2, { respond_hours: 24, complete_hours: 72 }]]);
    const created = new Date(Date.now() - 30 * 3_600_000);
    expect(slaOf({ priority: 2, created_at: created, responded_at: null, completed_at: null, status: 'scheduled' }, levels)).toMatchObject({ respond: { state: 'missed' }, complete: { state: 'on_track' } });
    expect(slaOf({ priority: 2, created_at: new Date(Date.now() - 60 * 3_600_000), responded_at: created, completed_at: null, status: 'in_progress' }, levels).complete.state).toBe('at_risk');
    expect(slaOf({ priority: 4, created_at: created, responded_at: null, completed_at: null, status: 'planned' }, new Map([[4, { respond_hours: null, complete_hours: null }]])).respond.state).toBe('none');
    const def = getReport('service-levels')!;
    const r = await asActor(w.admin, (tx) => def.run(tx, w.admin, def.params.parse({ by: 'contractor' })));
    expect(r.rows).toEqual([expect.objectContaining({ name: 'Flow Plumbing', jobs: 1, respond_rate: 1, complete_rate: 1, spend: 445, over_nte: 1 })]);
    expect(r.insights.join(' ')).toMatch(/1 job invoiced over the not-to-exceed, by \$45\.00/);
  });
});
