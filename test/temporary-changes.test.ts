import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { asActor } from '../src/platform/auth/actor.js';
import { closePools, getAdminPool } from '../src/platform/db/pool.js';
import { sweepTempChanges } from '../src/modules/moc/temp-changes.js';
import type { World } from './fixtures.js';
import { makeWorld } from './fixtures.js';

/** Temporary changes to a procedure, with expiry timers and alerts (SC-006 C). */
let app: FastifyInstance; let w: World; let doc: string; let approverId: string; let techId: string;
const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
const db = () => getAdminPool();
beforeAll(async () => {
  app = buildApp(); w = await makeWorld('tempchg');
  const d = (await db().query(`INSERT INTO document (tenant_id, facility_id, doc_number, title, doc_type, owner_user_id) VALUES ($1, $2, 'SOP-100', 'Torque the spindle nut', 'sop', $3) RETURNING id`, [w.tenantId, w.facilities.A, w.admin.userId])).rows[0].id;
  const v = (await db().query(`INSERT INTO document_version (tenant_id, document_id, revision, version_label, status, storage_key, file_name, mime_type, size_bytes, sha256, approved_at) VALUES ($1, $2, 1, 'A', 'approved', 'k', 'f.pdf', 'application/pdf', 1, 'x', now()) RETURNING id`, [w.tenantId, d])).rows[0].id;
  await db().query('UPDATE document SET current_version_id = $2 WHERE id = $1', [d, v]);
  doc = d;
  techId = (await db().query(`SELECT id FROM app_user WHERE tenant_id = $1 AND email LIKE 'techA@%'`, [w.tenantId])).rows[0].id;
  approverId = w.admin.userId;
});
afterAll(async () => { await app.close(); await closePools(); });
const call = (token: string | undefined, method: string, url: string, payload?: unknown) => app.inject({ method: method as any, url, headers: { authorization: `Bearer ${token}` }, payload: payload as any });
/** The deciding person is whoever the step is assigned to; here the owner is a technician and the coordinator is the admin. */
const decide = async (id: string, decision: 'approve' | 'reject') => {
  const t = (await call(w.tokens.admin, 'GET', '/api/approvals')).json();
  const mine = (t.pending ?? t).find?.((x: any) => x.subject_id === id || x.subjectId === id);
  const step = (await db().query(`SELECT s.id FROM approval_step s JOIN approval_request r ON r.id = s.request_id WHERE r.subject_id = $1 AND s.status = 'pending'`, [id])).rows[0].id;
  void mine;
  return call(w.tokens.admin, 'POST', `/api/approvals/steps/${step}/decide`, { decision, comment: 'ok' });
};
const make = async (over: any = {}, token = w.tokens.techA) => (await call(token, 'POST', '/api/temporary-changes', { facilityId: w.facilities.A, documentId: doc, title: 'Use the 36 mm socket', whatChanges: 'Use the 36 mm socket until the new 38 mm one arrives', reason: 'Socket on back-order from supplier',
  startsOn: day(0), expiresOn: day(30), ...over })).json();

describe('temporary change', () => {
  let id = '';
  it('needs a reason, a sensible period under the ceiling, an approved revision, and someone else to approve', async () => {
    expect((await call(w.tokens.techA, 'POST', '/api/temporary-changes', { facilityId: w.facilities.A, documentId: doc, title: 'Too long', whatChanges: 'Use the other socket for a year', reason: 'Long wait ahead', startsOn: day(0), expiresOn: day(200) })).statusCode).toBe(422);
    expect((await call(w.tokens.techA, 'POST', '/api/temporary-changes', { facilityId: w.facilities.A, documentId: doc, title: 'Backwards', whatChanges: 'Use the other socket please', reason: 'Because', startsOn: day(5), expiresOn: day(2) })).statusCode).toBe(422);
    const t = await make();
    id = t.id; expect(t).toMatchObject({ number: 'TC-00001', status: 'draft' });
    expect((await call(w.tokens.techA, 'POST', `/api/temporary-changes/${id}/submit`, { approverId: techId })).statusCode).toBe(422); // not themselves
    const s = await call(w.tokens.techA, 'POST', `/api/temporary-changes/${id}/submit`, { approverId });
    expect(s.statusCode, s.body).toBe(200); expect(s.json().status).toBe('pending_approval');
  });

  it('approval puts it in force and the procedure shows a banner with its end date', async () => {
    const r = await decide(id, 'approve');
    expect(r.statusCode, r.body).toBeLessThan(300);
    expect((await call(w.tokens.admin, 'GET', `/api/temporary-changes/${id}`)).json()).toMatchObject({ status: 'active', level: 'green', days_left: 30 });
    const d = (await call(w.tokens.admin, 'GET', `/api/documents/${doc}`)).json();
    expect(d.temporaryChanges).toHaveLength(1);
    expect(d.temporaryChanges[0]).toMatchObject({ number: 'TC-00001', days_left: 30, level: 'green' });
    expect(d.temporaryChanges[0].what_changes).toMatch(/36 mm socket/);
  });

  it('alerts the owner at 14, 7, 3, 1 and 0 days, once each', async () => {
    const seen: string[] = [];
    for (const left of [14, 7, 3, 1, 0]) {
      await db().query('UPDATE temporary_change SET expires_on = $2 WHERE id = $1', [id, day(left)]);
      await asActor(w.admin, (tx) => sweepTempChanges(tx, w.tenantId));
      await asActor(w.admin, (tx) => sweepTempChanges(tx, w.tenantId)); // a second run adds nothing
      seen.push(left as any);
    }
    const keys = (await db().query(`SELECT dedupe_key FROM notification WHERE tenant_id = $1 AND dedupe_key LIKE 'tc-exp:%'`, [w.tenantId])).rows.map((r) => r.dedupe_key).sort();
    expect(keys).toEqual([14, 7, 3, 1, 0].map((n) => `tc-exp:${id}:${n}`).sort());
    const approverKeys = (await db().query(`SELECT dedupe_key FROM notification WHERE tenant_id = $1 AND dedupe_key LIKE 'tc-exp-ap:%'`, [w.tenantId])).rows.length;
    expect(approverKeys).toBe(3); // the approver hears at 3, 1 and 0
    expect((await call(w.tokens.admin, 'GET', `/api/temporary-changes/${id}`)).json().level).toBe('red');
  });

  it('marks it expired after its date, lists it as late, escalates after a week, and an expired change cannot just carry on', async () => {
    await db().query('UPDATE temporary_change SET starts_on = $2, expires_on = $3 WHERE id = $1', [id, day(-40), day(-8)]);
    await asActor(w.admin, (tx) => sweepTempChanges(tx, w.tenantId));
    expect((await call(w.tokens.admin, 'GET', `/api/temporary-changes/${id}`)).json()).toMatchObject({ status: 'expired', level: 'expired' });
    const late = (await call(w.tokens.admin, 'GET', '/api/what-is-late')).json().sections.find((s: any) => s.key === 'temporary-changes');
    expect(late.rows[0]).toMatchObject({ daysLate: 8 });
    expect((await db().query(`SELECT 1 FROM notification WHERE tenant_id = $1 AND dedupe_key LIKE 'tc-late:%'`, [w.tenantId])).rowCount).toBeGreaterThan(0);
    expect((await db().query(`SELECT 1 FROM notification WHERE tenant_id = $1 AND dedupe_key LIKE 'tc-esc:%'`, [w.tenantId])).rowCount).toBeGreaterThan(0);
    expect((await call(w.tokens.techA, 'GET', `/api/documents/${doc}`)).json().temporaryChanges[0].level).toBe('expired'); // readers still see it, flagged
  });

  it('an extension needs a reason and a fresh approval; a refusal leaves it expired', async () => {
    expect((await call(w.tokens.techA, 'POST', `/api/temporary-changes/${id}/extend`, { newExpiresOn: day(20), reason: 'x', approverId })).statusCode).toBe(422);
    expect((await call(w.tokens.techA, 'POST', `/api/temporary-changes/${id}/extend`, { newExpiresOn: day(200), reason: 'Still on back-order', approverId })).statusCode).toBe(422); // over the ceiling
    const e = await call(w.tokens.techA, 'POST', `/api/temporary-changes/${id}/extend`, { newExpiresOn: day(20), reason: 'Supplier now says three more weeks', approverId });
    expect(e.statusCode, e.body).toBe(200);
    expect((await call(w.tokens.techA, 'POST', `/api/temporary-changes/${id}/extend`, { newExpiresOn: day(25), reason: 'Again', approverId })).statusCode).toBe(409); // one is already pending
    await decide(id, 'reject');
    expect((await call(w.tokens.admin, 'GET', `/api/temporary-changes/${id}`)).json()).toMatchObject({ status: 'expired', pending_expires_on: null });
    await call(w.tokens.techA, 'POST', `/api/temporary-changes/${id}/extend`, { newExpiresOn: day(20), reason: 'Supplier confirmed delivery', approverId });
    expect((await decide(id, 'approve')).statusCode).toBeLessThan(300);
    const g = (await call(w.tokens.admin, 'GET', `/api/temporary-changes/${id}`)).json();
    expect(g).toMatchObject({ status: 'active', extension_count: 1, extensions: 1 });
    expect(g.events.map((x: any) => x.kind)).toEqual(['activated', 'extension_requested', 'extension_rejected', 'extension_requested', 'extended']);
    expect(g.events.filter((x: any) => x.kind === 'extended')[0].reason).toMatch(/confirmed delivery/);
  });

  it('making it permanent opens a normal change; the banner stays until that change is approved', async () => {
    const r = await call(w.tokens.techA, 'POST', `/api/temporary-changes/${id}/make-permanent`, {});
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().change.number).toMatch(/^MOC-/);
    expect(r.json().temporaryChange.status).toBe('permanent_pending');
    expect((await call(w.tokens.admin, 'GET', `/api/documents/${doc}`)).json().temporaryChanges).toHaveLength(1);
    await db().query(`UPDATE moc_change SET status = 'approved' WHERE id = $1`, [r.json().change.id]);
    await asActor(w.admin, (tx) => sweepTempChanges(tx, w.tenantId));
    expect((await call(w.tokens.admin, 'GET', `/api/temporary-changes/${id}`)).json().status).toBe('made_permanent');
    expect((await call(w.tokens.admin, 'GET', `/api/documents/${doc}`)).json().temporaryChanges).toHaveLength(0);
  });

  it('reverting needs a confirmation and takes the banner away', async () => {
    const t = await make({ title: 'Second change' });
    await call(w.tokens.techA, 'POST', `/api/temporary-changes/${t.id}/submit`, { approverId });
    await decide(t.id, 'approve');
    expect((await call(w.tokens.admin, 'GET', `/api/documents/${doc}`)).json().temporaryChanges).toHaveLength(1);
    expect((await call(w.tokens.techA, 'POST', `/api/temporary-changes/${t.id}/revert`, { note: 'ok' })).statusCode).toBe(422);
    const r = await call(w.tokens.techA, 'POST', `/api/temporary-changes/${t.id}/revert`, { note: 'New socket arrived; procedure back to rev A and crew told' });
    expect(r.json().status).toBe('reverted');
    expect((await call(w.tokens.admin, 'GET', `/api/documents/${doc}`)).json().temporaryChanges).toHaveLength(0);
  });

  it('is isolated between companies', async () => {
    const other = await makeWorld('tempchg2');
    expect((await call(other.tokens.admin, 'GET', `/api/temporary-changes/${id}`)).statusCode).toBe(404);
  });
});
