import { crc32, inflateRawSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { closePools, getAdminPool } from '../src/platform/db/pool.js';
import type { World } from './fixtures.js';
import { makeWorld } from './fixtures.js';

/** Electronic signatures and the audit pack (D-170). */
let app: FastifyInstance; let w: World;
beforeAll(async () => { app = buildApp(); w = await makeWorld('docaudit'); });
afterAll(async () => { await app.close(); await closePools(); });
const call = (token: string | undefined, method: string, url: string, payload?: unknown, headers: Record<string, string> = {}) =>
  app.inject({ method: method as any, url, headers: { authorization: `Bearer ${token}`, ...headers }, payload: payload as any });
const upload = (token: string | undefined, docId: string, label: string, text: string, extra = '') =>
  call(token, 'POST', `/api/documents/${docId}/versions?versionLabel=${label}&fileName=doc.txt${extra}`, Buffer.from(text), { 'content-type': 'text/plain' });

/** Reads a zip written by the platform: checks every entry's CRC and size and returns name → bytes. */
function readZip(buf: Buffer) {
  const end = buf.length - 22;
  expect(buf.readUInt32LE(end)).toBe(0x06054b50);
  const n = buf.readUInt16LE(end + 10); let p = buf.readUInt32LE(end + 16);
  const out = new Map<string, Buffer>();
  for (let i = 0; i < n; i++) {
    expect(buf.readUInt32LE(p)).toBe(0x02014b50);
    const method = buf.readUInt16LE(p + 10); const crc = buf.readUInt32LE(p + 16); const csize = buf.readUInt32LE(p + 20); const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28); const extraLen = buf.readUInt16LE(p + 30); const commentLen = buf.readUInt16LE(p + 32); const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    const dataAt = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(dataAt, dataAt + csize);
    const data = method === 8 ? inflateRawSync(raw) : raw;
    expect(data.length, name).toBe(size);
    expect(crc32(data), name).toBe(crc);
    out.set(name, Buffer.from(data));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

describe('electronic signatures', () => {
  it('a kind chosen by an administrator needs the signer\'s own credential, recorded with its meaning and the file checksum', async () => {
    expect((await call(w.tokens.managerA, 'PUT', '/api/document-settings', { esignTypes: ['sop'] })).statusCode).toBe(403);
    expect((await call(w.tokens.admin, 'PUT', '/api/document-settings', { esignTypes: ['no_such_kind'] })).statusCode).toBe(422);
    expect((await call(w.tokens.admin, 'PUT', '/api/document-settings', { esignTypes: ['sop'] })).json().esignTypes).toEqual(['sop']);
    const d = (await call(w.tokens.managerA, 'POST', '/api/documents', { title: 'Hot work permit', docType: 'sop', facilityId: w.facilities.A })).json();
    const v = (await upload(w.tokens.managerA, d.id, 'A', 'Fire watch for 30 minutes after.')).json();
    expect((await call(w.tokens.managerA, 'GET', `/api/documents/${d.id}`)).json().esignRequired).toBe(true);
    await call(w.tokens.managerA, 'POST', `/api/document-versions/${v.id}/submit`, { reviewerIds: [w.qualityA.userId], approverId: w.admin.userId });
    const step = (await call(w.tokens.qualityA, 'GET', '/api/approvals/queue')).json().find((q: any) => q.subjectId === v.id);
    expect(step).toMatchObject({ signatureRequired: true });
    const decide = (token: string | undefined, id: string, body: object) => call(token, 'POST', `/api/approvals/steps/${id}/decide`, { decision: 'approve', comment: 'Checked against the permit standard', ...body });
    expect((await decide(w.tokens.qualityA, step.stepId, {})).json().error.message).toMatch(/signed electronically/);
    expect((await decide(w.tokens.qualityA, step.stepId, { signature: { credential: w.tokens.admin } })).json().error.message).toMatch(/not yours/);
    expect((await decide(w.tokens.qualityA, step.stepId, { signature: { credential: 'a-wrong-credential' } })).json().error.message).toMatch(/not yours/);
    expect((await decide(w.tokens.qualityA, step.stepId, { signature: { credential: w.tokens.qualityA } })).statusCode).toBe(200);
    const approver = (await call(w.tokens.admin, 'GET', '/api/approvals/queue')).json().find((q: any) => q.subjectId === v.id);
    expect((await decide(w.tokens.admin, approver.stepId, { signature: { credential: w.tokens.admin } })).statusCode).toBe(200);
    const doc = (await call(w.tokens.managerA, 'GET', `/api/documents/${d.id}`)).json();
    expect(doc.signatures.map((s: any) => [s.signer_name, s.meaning])).toEqual([['qualityA', 'reviewed'], ['admin', 'approved']]);
    const rows = (await getAdminPool().query(`SELECT * FROM document_signature WHERE version_id = $1 ORDER BY signed_at`, [v.id])).rows;
    expect(rows[0].version_sha256).toBe(doc.versions[0].sha256);
    expect(rows[1].signature_hash).toMatch(/^[0-9a-f]{64}$/);
    await expect(getAdminPool().query(`UPDATE document_signature SET meaning = 'reviewed' WHERE version_id = $1`, [v.id])).rejects.toThrow(/cannot be changed or removed/);
    await expect(getAdminPool().query(`DELETE FROM document_signature WHERE version_id = $1`, [v.id])).rejects.toThrow(/cannot be changed or removed/);
  });

  it('the one-step approval needs the signature too; kinds not chosen need none', async () => {
    const d = (await call(w.tokens.managerA, 'POST', '/api/documents', { title: 'Confined space entry', docType: 'sop', facilityId: w.facilities.A })).json();
    const v = (await upload(w.tokens.managerA, d.id, 'A', 'Test the air first.')).json();
    expect((await call(w.tokens.admin, 'POST', `/api/document-versions/${v.id}/approve`, {})).json().error.message).toMatch(/signed electronically/);
    expect((await call(w.tokens.admin, 'POST', `/api/document-versions/${v.id}/approve`, { signature: { credential: w.tokens.admin } })).statusCode).toBe(200);
    const wi = (await call(w.tokens.managerA, 'POST', '/api/documents', { title: 'Stack the pallets', docType: 'work_instruction', facilityId: w.facilities.A })).json();
    const wv = (await upload(w.tokens.managerA, wi.id, 'A', 'Four high.')).json();
    expect((await call(w.tokens.admin, 'POST', `/api/document-versions/${wv.id}/approve`, {})).statusCode).toBe(200);
  });
});

describe('the audit pack', () => {
  it('is a zip with the master list, revisions, approvals, signatures, acknowledgements, audit log and the released files, each checked', async () => {
    expect((await call(w.tokens.techA, 'GET', '/api/document-audit-pack')).statusCode).toBe(403);
    const res = await call(w.tokens.admin, 'GET', '/api/document-audit-pack');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/zip');
    expect(res.headers['content-disposition']).toMatch(/document-audit-pack-\d{4}-\d{2}-\d{2}\.zip/);
    const files = readZip(res.rawPayload);
    expect([...files.keys()]).toEqual(expect.arrayContaining(['README.txt', 'manifest.json', 'master-list.csv', 'revisions.csv', 'reviews-and-approvals.csv', 'signatures.csv', 'acknowledgements.csv', 'audit-log.csv', 'obsolete-register.csv']));
    const manifest = JSON.parse(files.get('manifest.json')!.toString('utf8'));
    expect(manifest).toMatchObject({ auditChain: { intact: true, firstBrokenEventId: null }, signaturesIntact: true, counts: expect.objectContaining({ documents: 3, revisions: 3, signatures: 3, files: 3, filesOmitted: 0 }) });
    // Every file in the pack matches the checksum the manifest records, and released files match their recorded checksum.
    for (const f of manifest.files) expect(createHash('sha256').update(files.get(f.path)!).digest('hex'), f.path).toBe(f.sha256);
    const master = files.get('master-list.csv')!.toString('utf8');
    expect(master).toContain('Hot work permit');
    expect(master).toContain('Confined space entry');
    expect(files.get('signatures.csv')!.toString('utf8')).toMatch(/qualityA,reviewed.*,true/s);
    expect(files.get('reviews-and-approvals.csv')!.toString('utf8')).toContain('Checked against the permit standard');
    const fileNames = [...files.keys()].filter((n) => n.startsWith('files/'));
    expect(fileNames.length).toBeGreaterThanOrEqual(3);
    expect(files.get(fileNames.find((n) => n.includes('rev-1-doc.txt'))!)!.length).toBeGreaterThan(0);
    expect(files.get('audit-log.csv')!.toString('utf8')).toContain('document.signed');
  });

  it('one document\'s pack holds only that document, and each pack is itself recorded in the audit trail', async () => {
    const d = (await call(w.tokens.managerA, 'POST', '/api/documents', { title: 'Single document pack', docType: 'procedure', facilityId: w.facilities.A })).json();
    const v = (await upload(w.tokens.managerA, d.id, 'A', 'Only this one.')).json();
    await call(w.tokens.admin, 'POST', `/api/document-versions/${v.id}/approve`, {});
    const res = await call(w.tokens.managerA, 'GET', `/api/documents/${d.id}/audit-pack`);
    expect(res.statusCode, res.body).toBe(200);
    const files = readZip(res.rawPayload);
    expect(files.get('master-list.csv')!.toString('utf8').split('\r\n').filter(Boolean)).toHaveLength(2); // header and one document
    expect(JSON.parse(files.get('manifest.json')!.toString('utf8')).scope).toBe(`document ${d.doc_number}`);
    expect((await call(w.tokens.techA, 'GET', `/api/documents/${d.id}/audit-pack`)).statusCode).toBe(403);
    const logged = (await getAdminPool().query(`SELECT count(*)::int AS n FROM audit_event WHERE tenant_id = $1 AND action = 'document.audit_pack'`, [w.tenantId])).rows[0].n;
    expect(logged).toBeGreaterThanOrEqual(2);
  });
});
