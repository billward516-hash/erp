import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { closePools, getAdminPool } from '../src/platform/db/pool.js';
import { addWorkingDays } from '../src/modules/documents/specs.js';
import type { World } from './fixtures.js';
import { makeWorld } from './fixtures.js';

/** Review of customer specification revisions (D-169). */
let app: FastifyInstance; let w: World;
beforeAll(async () => { app = buildApp(); w = await makeWorld('specreview'); });
afterAll(async () => { await app.close(); await closePools(); });
const call = (token: string | undefined, method: string, url: string, payload?: unknown, headers: Record<string, string> = {}) =>
  app.inject({ method: method as any, url, headers: { authorization: `Bearer ${token}`, ...headers }, payload: payload as any });
const upload = (token: string | undefined, docId: string, label: string, text: string, extra = '') =>
  call(token, 'POST', `/api/documents/${docId}/versions?versionLabel=${encodeURIComponent(label)}&fileName=spec.txt${extra}`, Buffer.from(text), { 'content-type': 'text/plain' });

describe('working days', () => {
  it('counts Monday to Friday only', () => {
    expect(addWorkingDays('2026-10-21', 1)).toBe('2026-10-22'); // Wednesday → Thursday
    expect(addWorkingDays('2026-10-23', 1)).toBe('2026-10-26'); // Friday → Monday
    expect(addWorkingDays('2026-10-23', 10)).toBe('2026-11-06'); // ten working days: two weeks
    expect(addWorkingDays('2026-10-24', 1)).toBe('2026-10-26'); // received on a Saturday
  });
});

describe('a customer specification revision', () => {
  it('opens an impact review due in 10 working days, and cannot be put in force until it is decided', async () => {
    const cs = (await call(w.tokens.managerA, 'POST', '/api/documents', { title: 'Cleanliness requirements', docType: 'customer_spec', issuer: 'Lakeshore Hydraulics', issuerDocNumber: 'LH-ES-104' })).json();
    const v = (await upload(w.tokens.managerA, cs.id, '1', 'below 2 mg', '&issuerRevision=C&receivedOn=2026-10-23')).json();
    expect(v).toMatchObject({ specReviewDueOn: expect.stringContaining('2026-11-06') });
    const blocked = await call(w.tokens.admin, 'POST', `/api/document-versions/${v.id}/approve`, {});
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error.message).toMatch(/impact review is not done yet \(due 2026-11-06\)/);
    const doc = (await call(w.tokens.managerA, 'GET', `/api/documents/${cs.id}`)).json();
    const review = doc.reviews[0];
    expect(review).toMatchObject({ status: 'open', issuer_revision: 'C', received_on: expect.stringContaining('2026-10-23') });
    expect((await call(w.tokens.managerA, 'POST', `/api/spec-reviews/${review.id}/decide`, { outcome: 'no_impact', whatChanged: 'First issue', assessment: '' })).statusCode).toBe(422);
    const ok = await call(w.tokens.managerA, 'POST', `/api/spec-reviews/${review.id}/decide`, { outcome: 'no_impact', whatChanged: 'First issue to us', assessment: 'Our wash and inspection already meet 2 mg; no change.' });
    expect(ok.statusCode, ok.body).toBe(200);
    expect((await call(w.tokens.admin, 'POST', `/api/document-versions/${v.id}/approve`, {})).statusCode).toBe(200);
    // A decided review is a record.
    await expect(getAdminPool().query(`UPDATE spec_review SET assessment = 'rewritten' WHERE id = $1`, [review.id])).rejects.toThrow(/cannot be changed/);
  });

  it('a revision that needs changes names our documents to revise; each follow-up closes when that document releases a revision', async () => {
    const cs = (await call(w.tokens.managerA, 'POST', '/api/documents', { title: 'Marking requirements', docType: 'customer_spec', issuer: 'Lakeshore Hydraulics' })).json();
    const v1 = (await upload(w.tokens.managerA, cs.id, '1', 'laser mark part number', '&issuerRevision=A')).json();
    const r1 = (await call(w.tokens.managerA, 'GET', `/api/documents/${cs.id}`)).json().reviews[0];
    await call(w.tokens.managerA, 'POST', `/api/spec-reviews/${r1.id}/decide`, { outcome: 'no_impact', whatChanged: 'First issue', assessment: 'Marking station already does this.' });
    await call(w.tokens.admin, 'POST', `/api/document-versions/${v1.id}/approve`, {});
    // Our work instruction works to the spec.
    const wi = (await call(w.tokens.managerA, 'POST', '/api/documents', { title: 'Laser mark HSG-100', docType: 'work_instruction', facilityId: w.facilities.A })).json();
    const wv = (await upload(w.tokens.managerA, wi.id, 'A', 'mark PN')).json();
    await call(w.tokens.admin, 'POST', `/api/document-versions/${wv.id}/approve`, {});
    expect((await call(w.tokens.managerA, 'POST', `/api/documents/${wi.id}/links`, { entityType: 'document', entityId: cs.id, linkRole: 'works_to' })).statusCode).toBe(204);
    // Revision B adds a date code.
    const v2 = (await upload(w.tokens.managerA, cs.id, '2', 'laser mark part number and date code', '&issuerRevision=B&changeSummary=Customer%20revision%20B')).json();
    const doc = (await call(w.tokens.managerA, 'GET', `/api/documents/${cs.id}`)).json();
    expect(doc.usedBy).toEqual([expect.objectContaining({ id: wi.id, doc_number: wi.doc_number })]);
    const r2 = doc.reviews.find((r: any) => r.version_id === v2.id);
    expect(r2.previous_issuer_revision).toBe('A');
    expect((await call(w.tokens.managerA, 'POST', `/api/spec-reviews/${r2.id}/decide`, { outcome: 'changes_required', whatChanged: 'Date code added', assessment: 'The WI must add the date code.' })).json().error.message)
      .toMatch(/name the documents to revise/);
    const due = new Date(Date.now() + 20 * 86_400_000).toISOString().slice(0, 10);
    const decided = await call(w.tokens.managerA, 'POST', `/api/spec-reviews/${r2.id}/decide`, { outcome: 'changes_required', whatChanged: 'Date code added to the mark',
      assessment: 'WI must add the date code format YYWW.', customerDueOn: due, followups: [{ documentId: wi.id, ownerUserId: w.managerA.userId, dueOn: due }] });
    expect(decided.statusCode, decided.body).toBe(200);
    expect((await call(w.tokens.managerA, 'GET', '/api/spec-reviews')).json().followups.find((f: any) => f.document_id === wi.id)).toMatchObject({ spec_number: cs.doc_number });
    // The WI releases revision B: the follow-up is done with that revision.
    const wv2 = (await upload(w.tokens.managerA, wi.id, 'B', 'mark PN and YYWW', '&changeSummary=Date%20code%20per%20customer%20rev%20B')).json();
    await call(w.tokens.admin, 'POST', `/api/document-versions/${wv2.id}/approve`, {});
    const after = (await call(w.tokens.managerA, 'GET', `/api/documents/${cs.id}`)).json().reviews.find((r: any) => r.id === r2.id);
    expect(after.followups).toEqual([expect.objectContaining({ status: 'done', done_version_label: 'B' })]);
    // The evidence report: on-time rate, outcomes, follow-ups.
    const rep = (await call(w.tokens.managerA, 'GET', '/api/reports/spec-reviews')).json();
    expect(rep.headline).toMatch(/reviewed on time/);
    expect(rep.rows.find((r: any) => r.revision === 'A → B')).toMatchObject({ result: 'changes required', followups: '1 of 1 done' });
  });

  it('the review period is a company setting, changed only by administrators; internal documents open no review', async () => {
    expect((await call(w.tokens.managerA, 'PUT', '/api/document-settings', { specReviewDays: 5 })).statusCode).toBe(403);
    expect((await call(w.tokens.admin, 'PUT', '/api/document-settings', { specReviewDays: 5 })).json()).toEqual({ specReviewDays: 5, ackDays: 7, esignTypes: [] });
    const cs = (await call(w.tokens.managerA, 'POST', '/api/documents', { title: 'Packaging spec', docType: 'customer_spec', issuer: 'Acme' })).json();
    expect((await upload(w.tokens.managerA, cs.id, '1', 'box', '&issuerRevision=1&receivedOn=2026-10-23')).json().specReviewDueOn).toContain('2026-10-30');
    const sop = (await call(w.tokens.managerA, 'POST', '/api/documents', { title: 'Housekeeping', docType: 'sop', facilityId: w.facilities.A })).json();
    expect((await upload(w.tokens.managerA, sop.id, 'A', 'sweep')).json().specReviewId).toBeNull();
    await call(w.tokens.admin, 'PUT', '/api/document-settings', { specReviewDays: 10 });
  });
});
