import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { closePools, getAdminPool } from '../src/platform/db/pool.js';
import type { World } from './fixtures.js';
import { makeWorld } from './fixtures.js';

/** The document server (D-168): numbering, reasons for change, review and approval, effective dates, read access, view log, obsolete. */
let app: FastifyInstance; let w: World;
beforeAll(async () => { app = buildApp(); w = await makeWorld('docserver'); });
afterAll(async () => { await app.close(); await closePools(); });
const call = (token: string | undefined, method: string, url: string, payload?: unknown, headers: Record<string, string> = {}) =>
  app.inject({ method: method as any, url, headers: { authorization: `Bearer ${token}`, ...headers }, payload: payload as any });
const upload = (token: string | undefined, docId: string, label: string, text: string, extra = '') =>
  call(token, 'POST', `/api/documents/${docId}/versions?versionLabel=${encodeURIComponent(label)}&fileName=doc.txt${extra}`, Buffer.from(text), { 'content-type': 'text/plain' });
const today = () => new Date().toISOString().slice(0, 10);
const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

describe('numbering, kinds and the reason for change', () => {
  it('numbers each kind in its own series; external documents need their issuer and the issuer\'s revision', async () => {
    const wi = (await call(w.tokens.managerA, 'POST', '/api/documents', { title: 'Deburr cross-drilled ports', docType: 'work_instruction', facilityId: w.facilities.A })).json();
    const tm = (await call(w.tokens.managerA, 'POST', '/api/documents', { title: 'Leak test at 6 bar', docType: 'method', facilityId: w.facilities.A })).json();
    expect(wi.doc_number).toMatch(/^WI-\d{4}$/);
    expect(tm.doc_number).toMatch(/^TM-\d{4}$/);
    const noIssuer = await call(w.tokens.managerA, 'POST', '/api/documents', { title: 'Lakeshore cleanliness spec', docType: 'customer_spec', facilityId: w.facilities.A });
    expect(noIssuer.json().error.message).toMatch(/needs its issuer/);
    const cs = (await call(w.tokens.managerA, 'POST', '/api/documents', { title: 'Lakeshore cleanliness spec', docType: 'customer_spec', facilityId: w.facilities.A,
      issuer: 'Lakeshore Hydraulics', issuerDocNumber: 'LH-ES-104' })).json();
    expect(cs).toMatchObject({ origin: 'external', issuer: 'Lakeshore Hydraulics', doc_number: expect.stringMatching(/^CS-/) });
    expect((await upload(w.tokens.managerA, cs.id, 'A', 'particulate < 2 mg')).json().error.message).toMatch(/issuer's revision/);
    expect((await upload(w.tokens.managerA, cs.id, 'A', 'particulate < 2 mg', '&issuerRevision=C&receivedOn=2026-10-01')).statusCode).toBe(201);
    // From the second version on, the reason for change is required.
    await upload(w.tokens.managerA, wi.id, 'A', 'step 1');
    const v1 = (await call(w.tokens.managerA, 'GET', `/api/documents/${wi.id}`)).json().versions[0];
    await call(w.tokens.admin, 'POST', `/api/document-versions/${v1.id}/approve`, {});
    expect((await upload(w.tokens.managerA, wi.id, 'B', 'step 1 and 2')).json().error.message).toMatch(/what changed and why/);
  });
});

describe('review and approval', () => {
  it('reviewers then the approver sign with comments; the author never approves; sent back returns to draft', async () => {
    const d = (await call(w.tokens.managerA, 'POST', '/api/documents', { title: 'Spindle warm-up', docType: 'sop', facilityId: w.facilities.A })).json();
    const v = (await upload(w.tokens.managerA, d.id, 'A', 'run 10 min at 2k rpm')).json();
    expect((await call(w.tokens.managerA, 'POST', `/api/document-versions/${v.id}/approve`, {})).json().error.message).toMatch(/someone other than the author/);
    expect((await call(w.tokens.managerA, 'POST', `/api/document-versions/${v.id}/submit`, { approverId: w.managerA.userId })).json().error.message).toMatch(/other than the author/);
    expect((await call(w.tokens.managerA, 'POST', `/api/document-versions/${v.id}/submit`, { approverId: w.techA.userId })).json().error.message).toMatch(/hold document approval/);
    const sub = await call(w.tokens.managerA, 'POST', `/api/document-versions/${v.id}/submit`, { reviewerIds: [w.qualityA.userId], approverId: w.admin.userId });
    expect(sub.statusCode, sub.body).toBe(200);
    // The approver's step waits for the reviewer.
    expect((await call(w.tokens.admin, 'GET', '/api/approvals/queue')).json().some((q: any) => q.subjectId === v.id)).toBe(false);
    const rq = (await call(w.tokens.qualityA, 'GET', '/api/approvals/queue')).json().find((q: any) => q.subjectId === v.id);
    expect(rq).toMatchObject({ label: 'Review by qualityA', commentRequired: true });
    expect((await call(w.tokens.qualityA, 'POST', `/api/approvals/steps/${rq.stepId}/decide`, { decision: 'approve' })).statusCode).toBe(422);
    await call(w.tokens.qualityA, 'POST', `/api/approvals/steps/${rq.stepId}/decide`, { decision: 'approve', comment: 'Times match the spindle manual' });
    const aq = (await call(w.tokens.admin, 'GET', '/api/approvals/queue')).json().find((q: any) => q.subjectId === v.id);
    expect(aq.label).toBe('Approval by admin');
    await call(w.tokens.admin, 'POST', `/api/approvals/steps/${aq.stepId}/decide`, { decision: 'reject', comment: 'Add the coolant check' });
    expect((await call(w.tokens.managerA, 'GET', `/api/documents/${d.id}`)).json().versions[0]).toMatchObject({ status: 'draft' });
    // Resubmitted and approved: released, signed by the approver.
    await call(w.tokens.managerA, 'POST', `/api/document-versions/${v.id}/submit`, { approverId: w.admin.userId });
    const aq2 = (await call(w.tokens.admin, 'GET', '/api/approvals/queue')).json().find((q: any) => q.subjectId === v.id);
    await call(w.tokens.admin, 'POST', `/api/approvals/steps/${aq2.stepId}/decide`, { decision: 'approve', comment: 'Approved for use' });
    const doc = (await call(w.tokens.managerA, 'GET', `/api/documents/${d.id}`)).json();
    expect(doc.versions[0]).toMatchObject({ status: 'approved', approved_by: 'admin', effective_on: expect.stringContaining(today()) });
    expect(doc.current_version_id).toBe(v.id);
  });
});

describe('effective dates', () => {
  it('an approved revision waits for its date; until then everyone works to the version in force', async () => {
    const d = (await call(w.tokens.managerA, 'POST', '/api/documents', { title: 'Torque sequence', docType: 'work_instruction', facilityId: w.facilities.A })).json();
    const a = (await upload(w.tokens.managerA, d.id, 'A', 'old sequence')).json();
    await call(w.tokens.admin, 'POST', `/api/document-versions/${a.id}/approve`, {});
    const b = (await upload(w.tokens.managerA, d.id, 'B', 'new sequence', '&changeSummary=Star%20pattern%20after%20gasket%20change')).json();
    const r = (await call(w.tokens.admin, 'POST', `/api/document-versions/${b.id}/approve`, { effectiveOn: inDays(14) })).json();
    expect(r).toMatchObject({ effectiveOn: inDays(14), supersededVersionId: null });
    const tech = (await call(w.tokens.techA, 'GET', `/api/documents/${d.id}`)).json();
    expect(tech.current_version_id).toBe(a.id);
    expect(tech.versions.map((v: any) => v.version_label)).toEqual(['A']); // the future revision is not shown to the floor yet
    expect((await call(w.tokens.techA, 'GET', `/api/document-versions/${b.id}/download`)).statusCode).toBe(404);
    const list = (await call(w.tokens.managerA, 'GET', '/api/documents?status=pending')).json();
    expect(list.find((x: any) => x.id === d.id)).toMatchObject({ pending_version_label: 'B' });
    // When the date comes, B takes over and A is superseded.
    const c = await getAdminPool().connect();
    try { await c.query('BEGIN'); await c.query('SET LOCAL session_replication_role = replica'); await c.query(`UPDATE document_version SET effective_on = current_date WHERE id = $1`, [b.id]); await c.query('COMMIT'); }
    finally { c.release(); }
    const after = (await call(w.tokens.techA, 'GET', `/api/documents/${d.id}`)).json();
    expect(after.current_version_id).toBe(b.id);
    expect((await call(w.tokens.managerA, 'GET', `/api/documents/${d.id}`)).json().versions.find((v: any) => v.id === a.id).status).toBe('superseded');
  });
});

describe('read access, the view log and withdrawal', () => {
  it('a folder limited to certain roles hides its documents from everyone else; every opening is logged', async () => {
    const f = (await call(w.tokens.managerA, 'POST', '/api/document-folders', { name: 'Quality methods', readRoles: ['quality_reviewer', 'maintenance_manager'] })).json();
    expect((await call(w.tokens.managerA, 'POST', '/api/document-folders', { name: 'Bad', readRoles: ['no_such_role'] })).statusCode).toBe(422);
    const d = (await call(w.tokens.managerA, 'POST', '/api/documents', { title: 'CMM program validation', docType: 'method', facilityId: w.facilities.A, folderId: f.id })).json();
    const v = (await upload(w.tokens.managerA, d.id, 'A', 'validate against the master part')).json();
    await call(w.tokens.admin, 'POST', `/api/document-versions/${v.id}/approve`, {});
    expect((await call(w.tokens.techA, 'GET', '/api/documents?q=CMM')).json()).toEqual([]);
    expect((await call(w.tokens.techA, 'GET', `/api/documents/${d.id}`)).statusCode).toBe(403);
    expect((await call(w.tokens.techA, 'GET', `/api/document-versions/${v.id}/download`)).statusCode).toBe(403);
    expect((await call(w.tokens.qualityA, 'GET', `/api/document-versions/${v.id}/download`)).statusCode).toBe(200);
    const log = (await getAdminPool().query(`SELECT actor_user_id, data FROM audit_event WHERE tenant_id = $1 AND action = 'document.viewed' AND entity_id = $2`, [w.tenantId, d.id])).rows;
    expect(log).toEqual([expect.objectContaining({ actor_user_id: w.qualityA.userId, data: expect.objectContaining({ versionId: v.id, revision: 1 }) })]);
    // Withdrawn: needs a reason, its versions become obsolete, and it leaves the active list.
    expect((await call(w.tokens.managerA, 'POST', `/api/documents/${d.id}/obsolete`, { reason: 'x' })).statusCode).toBe(422);
    expect((await call(w.tokens.managerA, 'POST', `/api/documents/${d.id}/obsolete`, { reason: 'Replaced by the vision system method' })).statusCode).toBe(200);
    expect((await call(w.tokens.managerA, 'GET', '/api/documents?q=CMM')).json()).toEqual([]);
    expect((await call(w.tokens.managerA, 'GET', '/api/documents?q=CMM&status=obsolete')).json()).toEqual([expect.objectContaining({ id: d.id, status: 'obsolete' })]);
    expect((await call(w.tokens.managerA, 'GET', `/api/documents/${d.id}`)).json().versions[0].status).toBe('obsolete');
  });

  it('the repository answers first and released versions cannot be deleted', async () => {
    const o = (await call(w.tokens.managerA, 'GET', '/api/document-repository')).json();
    expect(o.answer).toMatch(/^\d+ controlled documents? \(\d+ external\); \d+ in review, \d+ approved and waiting for their effective date\.( \d+ specification revisions? to review for impact(, \d+ late)?\.)?$/);
    expect(o.specReviews).toMatchObject({ open: 1 }); // the cleanliness spec's first revision awaits its review
    expect(o.types.find((t: any) => t.key === 'customer_spec')).toMatchObject({ external: true });
    await expect(getAdminPool().query(`DELETE FROM document_version WHERE tenant_id = $1`, [w.tenantId])).rejects.toThrow(/cannot be deleted/);
  });
});
