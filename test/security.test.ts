import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asActor, scopeOf } from '../src/platform/auth/actor.js';
import { closePools, getPool } from '../src/platform/db/pool.js';
import { withTx } from '../src/platform/db/tx.js';
import { LocalBlobStore } from '../src/platform/storage/blob-store.js';
import { createAsset, getAsset, listAssets } from '../src/modules/assets/service.js';
import { addVersion, approveVersion, createDocument, downloadVersion } from '../src/modules/documents/service.js';
import { verifyAuditChain } from '../src/platform/audit/audit.js';
import type { World } from './fixtures.js';
import { makeWorld } from './fixtures.js';

const blobs = new LocalBlobStore('./.storage/test');
let w1: World;
let w2: World;
let assetA: string;
let assetB: string;
let versionId: string;

beforeAll(async () => {
  w1 = await makeWorld('sec1');
  w2 = await makeWorld('sec2');
  assetA = (await asActor(w1.admin, (tx) => createAsset(tx, w1.admin, { facilityId: w1.facilities.A!, assetTag: 'CNC-1', name: 'Mill A' }))).id;
  assetB = (await asActor(w1.admin, (tx) => createAsset(tx, w1.admin, { facilityId: w1.facilities.B!, assetTag: 'CNC-2', name: 'Mill B' }))).id;
  await asActor(w2.admin, (tx) => createAsset(tx, w2.admin, { facilityId: w2.facilities.A!, assetTag: 'CNC-1', name: 'Other tenant mill' }));
  versionId = await asActor(w1.admin, async (tx) => {
    const d = await createDocument(tx, w1.admin, { facilityId: w1.facilities.A!, docNumber: 'MAN-1', title: 'Mill manual', docType: 'manual' });
    const v = await addVersion(tx, w1.admin, blobs, d.id, { versionLabel: 'A', fileName: 'm.txt', mimeType: 'text/plain', content: Buffer.from('spindle') });
    return v.id;
  });
  await asActor(w1.managerA, (tx) => approveVersion(tx, w1.managerA, versionId));
});
afterAll(closePools);

describe('tenant isolation (RLS)', () => {
  it('tenant B cannot read tenant A assets, even by id', async () => {
    const rows = await asActor(w2.admin, (tx) => listAssets(tx, w2.admin, {}));
    expect(rows.map((r) => r.name)).toEqual(['Other tenant mill']);
    await expect(asActor(w2.admin, (tx) => getAsset(tx, w2.admin, assetA))).rejects.toThrow(/not found/);
  });

  it('tenant B cannot download tenant A document content', async () => {
    await expect(asActor(w2.admin, (tx) => downloadVersion(tx, w2.admin, blobs, versionId))).rejects.toThrow(/not found/);
  });

  it('tenant B cannot write rows into tenant A', async () => {
    await expect(withTx(scopeOf(w2.admin), (tx) =>
      tx.query(`INSERT INTO asset (tenant_id, facility_id, asset_tag, name) VALUES ($1, $2, 'X', 'x')`, [w1.tenantId, w1.facilities.A]))).rejects.toThrow(/row-level security/);
  });

  it('a connection with no tenant context sees nothing (background jobs must set scope)', async () => {
    const r = await getPool().query('SELECT count(*)::int AS n FROM asset');
    expect(r.rows[0].n).toBe(0);
  });

  it('the runtime role cannot modify or delete audit history', async () => {
    await expect(withTx(scopeOf(w1.admin), (tx) => tx.query('UPDATE audit_event SET action = $1', ['tampered']))).rejects.toThrow();
    await expect(withTx(scopeOf(w1.admin), (tx) => tx.query('DELETE FROM audit_event'))).rejects.toThrow();
    expect(await withTx(scopeOf(w1.admin), verifyAuditChain)).toBeNull();
  });
});

describe('facility scoping', () => {
  it('a Facility A user cannot see Facility B records', async () => {
    const rows = await asActor(w1.managerA, (tx) => listAssets(tx, w1.managerA, {}));
    expect(rows.map((r) => r.asset_tag)).toEqual(['CNC-1']);
    await expect(asActor(w1.managerA, (tx) => getAsset(tx, w1.managerA, assetB))).rejects.toThrow(/not found/);
  });

  it('a Facility A manager cannot create assets at Facility B', async () => {
    await expect(asActor(w1.managerA, (tx) => createAsset(tx, w1.managerA, { facilityId: w1.facilities.B!, assetTag: 'NOPE', name: 'x' }))).rejects.toThrow(/forbidden|permission/);
  });

  it('a corporate executive sees consolidated data across facilities', async () => {
    const rows = await asActor(w1.exec, (tx) => listAssets(tx, w1.exec, {}));
    expect(rows.map((r) => r.asset_tag).sort()).toEqual(['CNC-1', 'CNC-2']);
  });

  it('read-only roles cannot write', async () => {
    await expect(asActor(w1.exec, (tx) => createAsset(tx, w1.exec, { facilityId: w1.facilities.A!, assetTag: 'X', name: 'x' }))).rejects.toThrow(/assets.manage/);
  });
});
