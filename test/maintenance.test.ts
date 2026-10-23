import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asActor } from '../src/platform/auth/actor.js';
import { closePools } from '../src/platform/db/pool.js';
import { one } from '../src/platform/db/tx.js';
import { LocalBlobStore } from '../src/platform/storage/blob-store.js';
import { createAsset, getAsset } from '../src/modules/assets/service.js';
import { addVersion, approveVersion, createDocument, downloadVersion, getDocument, linkDocument, searchDocuments } from '../src/modules/documents/service.js';
import { addLabor, addPart, assignTechnician, attachProcedure, createRequest, createWorkOrder, getWorkOrder, transitionWorkOrder } from '../src/modules/maintenance/service.js';
import { createPart } from '../src/modules/parts/service.js';
import type { World } from './fixtures.js';
import { makeWorld } from './fixtures.js';

const blobs = new LocalBlobStore('./.storage/test');
let w: World;
let assetId: string;
let docId: string;
let v1: string;

beforeAll(async () => {
  w = await makeWorld('mnt');
  assetId = (await asActor(w.managerA, (tx) => createAsset(tx, w.managerA, { facilityId: w.facilities.A!, assetTag: 'HMC-7', name: 'Horizontal machining center', criticality: 'high' }))).id;
  ({ docId, v1 } = await asActor(w.managerA, async (tx) => {
    const d = await createDocument(tx, w.managerA, { facilityId: w.facilities.A!, docNumber: 'TSG-7', title: 'HMC-7 spindle troubleshooting', docType: 'troubleshooting_guide', tags: ['spindle'], safetyCritical: true });
    const v = await addVersion(tx, w.managerA, blobs, d.id, { versionLabel: 'Rev A', fileName: 'tsg.txt', mimeType: 'text/plain', content: Buffer.from('Check drawbar pressure before spindle teardown.'), extractedText: 'Check drawbar pressure before spindle teardown.' });
    await linkDocument(tx, w.managerA, d.id, { entityType: 'asset', entityId: assetId });
    return { docId: d.id, v1: v.id };
  }));
});
afterAll(closePools);

describe('controlled technical documents', () => {
  it('the author of a safety-critical document cannot approve it', async () => {
    await expect(asActor(w.managerA, (tx) => approveVersion(tx, w.managerA, v1))).rejects.toThrow(/someone other than the author/);
  });

  it('technicians see only approved versions; drafts are invisible until released', async () => {
    const before = await asActor(w.techA, (tx) => searchDocuments(tx, w.techA, { entityType: 'asset', entityId: assetId }));
    expect(before).toHaveLength(0);
    await expect(asActor(w.techA, (tx) => downloadVersion(tx, w.techA, blobs, v1))).rejects.toThrow(/not found/);
    await asActor(w.admin, (tx) => approveVersion(tx, w.admin, v1));
    const asset = await asActor(w.techA, (tx) => getAsset(tx, w.techA, assetId));
    expect(asset.documents.map((d: any) => d.doc_number)).toEqual(['TSG-7']);
    const file = await asActor(w.techA, (tx) => downloadVersion(tx, w.techA, blobs, v1));
    expect(file.content.toString()).toContain('drawbar');
  });

  it('documents are searchable by content and tags', async () => {
    expect((await asActor(w.techA, (tx) => searchDocuments(tx, w.techA, { q: 'drawbar' }))).map((d) => d.doc_number)).toEqual(['TSG-7']);
    expect((await asActor(w.techA, (tx) => searchDocuments(tx, w.techA, { q: 'spindle' }))).length).toBe(1);
  });

  it('a revision supersedes the old version, keeps history, and reports impacted links', async () => {
    const v2 = await asActor(w.managerA, (tx) => addVersion(tx, w.managerA, blobs, docId, { versionLabel: 'Rev B', fileName: 'tsg.txt', mimeType: 'text/plain', content: Buffer.from('Rev B content'), changeSummary: 'Added LOTO step' }));
    const r = await asActor(w.admin, (tx) => approveVersion(tx, w.admin, v2.id));
    expect(r.supersededVersionId).toBe(v1);
    expect(r.impactedLinks).toEqual([expect.objectContaining({ entity_type: 'asset', entity_id: assetId })]);
    const asTech = await asActor(w.techA, (tx) => getDocument(tx, w.techA, docId));
    expect(asTech.versions.map((v: any) => v.version_label)).toEqual(['Rev B']);
    const asMgr = await asActor(w.managerA, (tx) => getDocument(tx, w.managerA, docId));
    expect(asMgr.versions.map((v: any) => [v.version_label, v.status])).toEqual([['Rev B', 'approved'], ['Rev A', 'superseded']]);
  });

  it('released versions are immutable at the database level', async () => {
    await expect(asActor(w.admin, (tx) => tx.query(`UPDATE document_version SET sha256 = 'x' WHERE id = $1`, [v1]))).rejects.toThrow(/immutable/);
  });
});

describe('corrective work order lifecycle', () => {
  it('request → work order → execution → independent verification → close, with costs and audit trail', async () => {
    const part = await asActor(w.admin, (tx) => createPart(tx, w.admin, { partNumber: 'BRG-6205', description: 'Bearing 6205-2RS', unitCost: 12.5 }));
    const sub = await asActor(w.admin, (tx) => createPart(tx, w.admin, { partNumber: 'BRG-6205-SKF', description: 'Bearing 6205-2RS (SKF)', unitCost: 14 }));
    const req = await asActor(w.techA, (tx) => createRequest(tx, w.techA, { assetId, symptom: 'Spindle noise at 8k rpm', severity: 'high', assetDown: true }));

    const wo = await asActor(w.managerA, (tx) => createWorkOrder(tx, w.managerA, { assetId, title: 'Spindle bearing noise', requestId: req.id }));
    expect(wo.priority).toBe(2);
    expect((await asActor(w.managerA, (tx) => getAsset(tx, w.managerA, assetId))).operational_state).toBe('unplanned_downtime');

    const procedureVersion = (await asActor(w.managerA, (tx) => getDocument(tx, w.managerA, docId))).current_version_id;
    await asActor(w.managerA, async (tx) => {
      await assignTechnician(tx, w.managerA, wo.id, w.techAEmployeeId, 'lead');
      await attachProcedure(tx, w.managerA, wo.id, procedureVersion);
      await addPart(tx, w.managerA, wo.id, { partId: part.id, qtyPlanned: 2 });
    });
    await expect(asActor(w.techA, (tx) => transitionWorkOrder(tx, w.techA, wo.id, { to: 'completed' }))).rejects.toThrow(/cannot move/);
    await asActor(w.techA, (tx) => transitionWorkOrder(tx, w.techA, wo.id, { to: 'in_progress' }));
    await expect(asActor(w.techA, (tx) => transitionWorkOrder(tx, w.techA, wo.id, { to: 'completed', remedy: 'x' }))).rejects.toThrow(/labor entry/);
    await asActor(w.techA, async (tx) => {
      await addLabor(tx, w.techA, wo.id, { workDate: '2026-10-20', hours: 3.5, hourlyRate: 48 });
      await addPart(tx, w.techA, wo.id, { partId: sub.id, qtyUsed: 2, substituteForPartId: part.id, note: 'OEM out of stock' });
    });
    await expect(asActor(w.techA, (tx) => transitionWorkOrder(tx, w.techA, wo.id, { to: 'completed' }))).rejects.toThrow(/remedy/);
    await asActor(w.techA, (tx) => transitionWorkOrder(tx, w.techA, wo.id, { to: 'completed', remedy: 'Replaced both spindle bearings', findings: 'Front bearing pitted' }));

    // Technicians cannot verify; the completer cannot verify their own work.
    await expect(asActor(w.tech2A, (tx) => transitionWorkOrder(tx, w.tech2A, wo.id, { to: 'verified' }))).rejects.toThrow(/work_orders.verify/);
    await asActor(w.managerA, (tx) => transitionWorkOrder(tx, w.managerA, wo.id, { to: 'verified', note: 'Ran 30 min at 8k, quiet' }));
    await asActor(w.managerA, (tx) => transitionWorkOrder(tx, w.managerA, wo.id, { to: 'closed' }));

    const full = await asActor(w.managerA, (tx) => getWorkOrder(tx, w.managerA, wo.id));
    expect(full.status).toBe('closed');
    expect(full.costs).toEqual({ laborHours: 3.5, laborCost: 168, partsCost: 28, currency: 'USD' });
    expect(full.parts.find((p: any) => p.qty_used > 0).substitute_for).toBe('BRG-6205');
    expect(full.procedures[0].version_label).toBe('Rev B');
    expect(full.history.map((h: any) => h.action)).toEqual([
      'work_order.created', 'work_order.assigned', 'work_order.procedure_attached', 'work_order.part_planned', 'work_order.status_changed',
      'work_order.labor_recorded', 'work_order.part_used', 'work_order.status_changed', 'work_order.status_changed', 'work_order.status_changed',
    ]);
    // Verification returned the asset to service.
    expect((await asActor(w.managerA, (tx) => getAsset(tx, w.managerA, assetId))).operational_state).toBe('available');
    const downtime = await asActor(w.managerA, (tx) => one(tx, `SELECT ended_at FROM asset_state_event WHERE id = $1`, [full.downtime_event_id]));
    expect(downtime.ended_at).not.toBeNull();
  });

  it('a pinned procedure version stays on the work order after a newer revision', async () => {
    const wo = await asActor(w.managerA, (tx) => createWorkOrder(tx, w.managerA, { assetId, title: 'Check drawbar' }));
    const current = (await asActor(w.managerA, (tx) => getDocument(tx, w.managerA, docId))).current_version_id;
    await asActor(w.managerA, (tx) => attachProcedure(tx, w.managerA, wo.id, current));
    const v3 = await asActor(w.managerA, (tx) => addVersion(tx, w.managerA, blobs, docId, { versionLabel: 'Rev C', fileName: 'tsg.txt', mimeType: 'text/plain', content: Buffer.from('c'), changeSummary: 'Torque values updated after the spindle rebuild' }));
    await asActor(w.admin, (tx) => approveVersion(tx, w.admin, v3.id));
    const full = await asActor(w.managerA, (tx) => getWorkOrder(tx, w.managerA, wo.id));
    expect(full.procedures.map((p: any) => [p.version_label, p.status])).toEqual([['Rev B', 'superseded']]);
    await expect(asActor(w.managerA, (tx) => attachProcedure(tx, w.managerA, wo.id, current))).rejects.toThrow(/only approved/);
  });
});
