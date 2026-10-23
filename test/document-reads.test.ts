import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { closePools, getAdminPool } from '../src/platform/db/pool.js';
import type { World } from './fixtures.js';
import { makeWorld } from './fixtures.js';

/** Read and understood (D-170). */
let app: FastifyInstance; let w: World;
beforeAll(async () => { app = buildApp(); w = await makeWorld('docreads'); });
afterAll(async () => { await app.close(); await closePools(); });
const call = (token: string | undefined, method: string, url: string, payload?: unknown, headers: Record<string, string> = {}) =>
  app.inject({ method: method as any, url, headers: { authorization: `Bearer ${token}`, ...headers }, payload: payload as any });
const upload = (token: string | undefined, docId: string, label: string, text: string, extra = '') =>
  call(token, 'POST', `/api/documents/${docId}/versions?versionLabel=${label}&fileName=wi.txt${extra}`, Buffer.from(text), { 'content-type': 'text/plain' });
const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

describe('read and understood', () => {
  it('creates a reading for each person in the audience on release; acknowledging needs the revision opened first, and is a record', async () => {
    const d = (await call(w.tokens.managerA, 'POST', '/api/documents', { title: 'Lockout before cleaning', docType: 'sop', facilityId: w.facilities.A, ackRequired: true, ackRoles: ['technician'] })).json();
    const a = (await upload(w.tokens.managerA, d.id, 'A', 'Isolate, lock, tag, try.')).json();
    await call(w.tokens.admin, 'POST', `/api/document-versions/${a.id}/approve`, {});
    const mine = (await call(w.tokens.techA, 'GET', '/api/my-reads')).json();
    expect(mine).toEqual([expect.objectContaining({ document_id: d.id, version_id: a.id, doc_number: d.doc_number, overdue: false, opened: false, due_on: expect.stringContaining(inDays(7)) })]);
    expect((await call(w.tokens.tech2A, 'GET', '/api/my-reads')).json()).toHaveLength(1);
    expect((await call(w.tokens.managerA, 'GET', '/api/my-reads')).json()).toEqual([]); // not in the audience
    // The acknowledgement follows the reading.
    const early = await call(w.tokens.techA, 'POST', `/api/document-versions/${a.id}/acknowledge`);
    expect(early.statusCode).toBe(422);
    expect(early.json().error.message).toMatch(/open the document and read it first/);
    expect((await call(w.tokens.techA, 'GET', `/api/document-versions/${a.id}/download`)).statusCode).toBe(200);
    expect((await call(w.tokens.techA, 'GET', '/api/my-reads')).json()[0].opened).toBe(true);
    expect((await call(w.tokens.techA, 'POST', `/api/document-versions/${a.id}/acknowledge`)).statusCode).toBe(200);
    expect((await call(w.tokens.techA, 'POST', `/api/document-versions/${a.id}/acknowledge`)).statusCode).toBe(409);
    expect((await call(w.tokens.techA, 'GET', '/api/my-reads')).json()).toEqual([]);
    expect((await call(w.tokens.managerA, 'POST', `/api/document-versions/${a.id}/acknowledge`)).statusCode).toBe(404);
    // A record: neither changed nor removed.
    await expect(getAdminPool().query(`UPDATE document_read_obligation SET acknowledged_at = now() - interval '1 day' WHERE version_id = $1 AND acknowledged_at IS NOT NULL`, [a.id])).rejects.toThrow(/cannot be changed/);
    await expect(getAdminPool().query(`DELETE FROM document_read_obligation WHERE version_id = $1`, [a.id])).rejects.toThrow(/cannot be deleted/);
    // Managers see who has and has not read each revision.
    const doc = (await call(w.tokens.managerA, 'GET', `/api/documents/${d.id}`)).json();
    expect(doc.reads.revisions).toEqual([expect.objectContaining({ revision: 1, required: 2, acknowledged: 1, overdue: 0 })]);
    expect(doc.reads.people.map((p: any) => [p.display_name, !!p.acknowledged_at])).toEqual(expect.arrayContaining([['techA', true], ['tech2A', false]]));
    expect((await call(w.tokens.techA, 'GET', `/api/documents/${d.id}`)).json().reads.revisions).toEqual([]); // others do not see the list
  });

  it('a newer revision released before a reading was done replaces it; a future effective date sets the due date', async () => {
    const d = (await call(w.tokens.managerA, 'POST', '/api/documents', { title: 'Torque the clamp rings', docType: 'work_instruction', facilityId: w.facilities.A, ackRequired: true, ackRoles: ['technician'] })).json();
    const a = (await upload(w.tokens.managerA, d.id, 'A', '40 Nm')).json();
    await call(w.tokens.admin, 'POST', `/api/document-versions/${a.id}/approve`, {});
    const b = (await upload(w.tokens.managerA, d.id, 'B', '45 Nm', '&changeSummary=Torque%20raised%20for%20the%20new%20gasket')).json();
    await call(w.tokens.admin, 'POST', `/api/document-versions/${b.id}/approve`, { effectiveOn: inDays(14) });
    const reads = (await call(w.tokens.tech2A, 'GET', '/api/my-reads')).json().filter((r: any) => r.document_id === d.id);
    expect(reads).toEqual([expect.objectContaining({ version_id: b.id, due_on: expect.stringContaining(inDays(14)) })]); // rev A is superseded; B is due on its effective date
    expect((await call(w.tokens.tech2A, 'POST', `/api/document-versions/${a.id}/acknowledge`)).json().error.message).toMatch(/newer revision replaced this one/);
    // People asked to read a revision that is not yet in force may open it; others may not.
    expect((await call(w.tokens.tech2A, 'GET', `/api/document-versions/${b.id}/download`)).statusCode).toBe(200);
    expect((await call(w.tokens.tech2A, 'GET', `/api/documents/${d.id}`)).json().versions.map((v: any) => v.version_label)).toContain('B');
    expect((await call(w.tokens.tech2A, 'POST', `/api/document-versions/${b.id}/acknowledge`)).statusCode).toBe(200);
    expect((await call(w.tokens.operatorB, 'GET', `/api/document-versions/${b.id}/download`)).statusCode).toBeGreaterThanOrEqual(403);
  });

  it('turning the requirement on for a document already in force asks the audience to read it; unknown roles are refused', async () => {
    const d = (await call(w.tokens.managerA, 'POST', '/api/documents', { title: 'Forklift pre-shift check', docType: 'sop', facilityId: w.facilities.A })).json();
    const a = (await upload(w.tokens.managerA, d.id, 'A', 'brakes, forks, horn')).json();
    await call(w.tokens.admin, 'POST', `/api/document-versions/${a.id}/approve`, {});
    expect((await call(w.tokens.techA, 'GET', '/api/my-reads')).json().some((r: any) => r.document_id === d.id)).toBe(false);
    expect((await call(w.tokens.managerA, 'PATCH', `/api/documents/${d.id}`, { ackRequired: true, ackRoles: ['no_such_role'] })).statusCode).toBe(422);
    expect((await call(w.tokens.managerA, 'PATCH', `/api/documents/${d.id}`, { ackRequired: true, ackRoles: ['technician'] })).statusCode).toBe(200);
    expect((await call(w.tokens.techA, 'GET', '/api/my-reads')).json().some((r: any) => r.document_id === d.id)).toBe(true);
  });
});
