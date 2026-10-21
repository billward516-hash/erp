import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { asActor } from '../src/platform/auth/actor.js';
import { closePools } from '../src/platform/db/pool.js';
import { LocalBlobStore } from '../src/platform/storage/blob-store.js';
import { createAsset, recordState } from '../src/modules/assets/service.js';
import { createWorkOrder } from '../src/modules/maintenance/service.js';
import { runReport } from '../src/modules/reporting/service.js';
import type { World } from './fixtures.js';
import { makeWorld } from './fixtures.js';

let app: FastifyInstance;
let w: World;
let other: World;
const auth = (token: string) => ({ authorization: `Bearer ${token}` });
const H = 3_600_000;

beforeAll(async () => {
  app = buildApp({ blobs: new LocalBlobStore('./.storage/test') });
  w = await makeWorld('api');
  other = await makeWorld('api-other');
  const now = Date.now();
  await asActor(w.admin, async (tx) => {
    const a = await createAsset(tx, w.admin, { facilityId: w.facilities.A!, assetTag: 'A-1', name: 'Lathe', criticality: 'high' });
    const b = await createAsset(tx, w.admin, { facilityId: w.facilities.B!, assetTag: 'B-1', name: 'Press' });
    await createAsset(tx, w.admin, { facilityId: w.facilities.A!, assetTag: 'A-2', name: 'No history' });
    // A-1: 10 days, 1 day of unplanned downtime -> availability 90% of recorded scheduled time
    await recordState(tx, w.admin, a.id, { state: 'running', at: new Date(now - 10 * 24 * H) });
    await recordState(tx, w.admin, a.id, { state: 'unplanned_downtime', at: new Date(now - 5 * 24 * H), reasonCode: 'MECH' });
    await recordState(tx, w.admin, a.id, { state: 'running', at: new Date(now - 4 * 24 * H) });
    await recordState(tx, w.admin, b.id, { state: 'running', at: new Date(now - 10 * 24 * H) });
    await createWorkOrder(tx, w.admin, { assetId: a.id, title: 'Overdue fix', priority: 1, dueAt: new Date(now - 24 * H).toISOString() });
    await createWorkOrder(tx, w.admin, { assetId: b.id, title: 'B work', dueAt: new Date(now + 24 * H).toISOString() });
  });
});
afterAll(async () => { await app.close(); await closePools(); });

describe('HTTP API', () => {
  it('requires a valid bearer token', async () => {
    expect((await app.inject({ url: '/api/assets' })).statusCode).toBe(401);
    expect((await app.inject({ url: '/api/assets', headers: auth('erp_bogus') })).statusCode).toBe(401);
    expect((await app.inject({ url: '/health' })).statusCode).toBe(200);
  });

  it('scopes API results by tenant and facility', async () => {
    const tags = async (token: string) => (await app.inject({ url: '/api/assets', headers: auth(token) })).json().map((a: any) => a.asset_tag).sort();
    expect(await tags(w.tokens.exec!)).toEqual(['A-1', 'A-2', 'B-1']);
    expect(await tags(w.tokens.managerA!)).toEqual(['A-1', 'A-2']);
    expect(await tags(other.tokens.admin!)).toEqual([]);
  });

  it('validates input and maps domain errors to status codes', async () => {
    const bad = await app.inject({ method: 'POST', url: '/api/assets', headers: auth(w.tokens.admin!), payload: { facilityId: 'nope' } });
    expect(bad.statusCode).toBe(422);
    const dup = await app.inject({ method: 'POST', url: '/api/assets', headers: auth(w.tokens.admin!), payload: { facilityId: w.facilities.A, assetTag: 'A-1', name: 'x' } });
    expect(dup.statusCode).toBe(409);
    const forbidden = await app.inject({ method: 'POST', url: '/api/assets', headers: auth(w.tokens.exec!), payload: { facilityId: w.facilities.A, assetTag: 'Z', name: 'x' } });
    expect(forbidden.statusCode).toBe(403);
  });

  it('uploads, approves and downloads a document; other tenants get 404', async () => {
    const doc = (await app.inject({ method: 'POST', url: '/api/documents', headers: auth(w.tokens.admin!),
      payload: { facilityId: w.facilities.A, docNumber: 'MAN-1', title: 'Lathe manual', docType: 'manual' } })).json();
    const v = await app.inject({ method: 'POST', url: `/api/documents/${doc.id}/versions?versionLabel=A&fileName=manual.txt`,
      headers: { ...auth(w.tokens.admin!), 'content-type': 'text/plain' }, payload: 'Check the tailstock.' });
    expect(v.statusCode).toBe(201);
    expect((await app.inject({ method: 'POST', url: `/api/document-versions/${v.json().id}/approve`, headers: auth(w.tokens.admin!) })).statusCode).toBe(200);
    const dl = await app.inject({ url: `/api/document-versions/${v.json().id}/download`, headers: auth(w.tokens.techA!) });
    expect(dl.statusCode).toBe(200);
    expect(dl.body).toBe('Check the tailstock.');
    expect(dl.headers['content-disposition']).toContain('manual.txt');
    expect((await app.inject({ url: `/api/document-versions/${v.json().id}/download`, headers: auth(other.tokens.admin!) })).statusCode).toBe(404);
  });

  it('stages and commits an import over HTTP and serves the problems CSV', async () => {
    const content = Buffer.from('Part #,Desc,Price\nP-1,Widget,$3.10\nP-2,,x\n').toString('base64');
    const staged = await app.inject({ method: 'POST', url: '/api/imports/stage', headers: auth(w.tokens.admin!),
      payload: { target: 'parts', sourceSystem: 'web', fileName: 'p.csv', contentBase64: content } });
    expect(staged.statusCode).toBe(201);
    const body = staged.json();
    expect(body.suggestion.suggestions.map((s: any) => s.field).sort()).toEqual(['description', 'part_number', 'unit_cost']);
    const problems = await app.inject({ url: `/api/imports/${body.batchId}/problems.csv`, headers: auth(w.tokens.admin!) });
    expect(problems.headers['content-type']).toContain('text/csv');
    expect(problems.body).toContain('Description is required');
    const commit = await app.inject({ method: 'POST', url: `/api/imports/${body.batchId}/commit`, headers: auth(w.tokens.admin!), payload: { allowPartial: true } });
    expect(commit.json().stats).toMatchObject({ created: 1, failed: 1 });
  });

  it('verifies the audit chain', async () => {
    const r = await app.inject({ url: '/api/audit/verify', headers: auth(w.tokens.admin!) });
    expect(r.json()).toEqual({ intact: true, firstInvalidEventId: null });
  });
});

describe('reporting', () => {
  it('produces an answer-first backlog with overdue exceptions and drill-down', async () => {
    const r = (await runReport(w.admin, 'maintenance-backlog', {}, 'json')).body as any;
    expect(r.headline).toBe('1 work order overdue of 2 open');
    expect(r.kpis.find((k: any) => k.label === 'Overdue').value).toBe(1);
    expect(r.exceptions).toEqual([0]);
    expect(r.drillDown.path).toBe('/api/work-orders/{id}');
  });

  it('availability report separates measured assets from those lacking data', async () => {
    // Default window is 30 days; A-1 has 10 days of history, so the default view excludes it (coverage < 50%).
    const def = (await runReport(w.admin, 'asset-availability', { facilityId: w.facilities.A }, 'json')).body as any;
    expect(def.rows.find((x: any) => x.asset_tag === 'A-1')).toMatchObject({ availability: null, data_quality: 'partial' });
    const r = (await runReport(w.admin, 'asset-availability', { facilityId: w.facilities.A, from: new Date(Date.now() - 10 * 24 * H).toISOString() }, 'json')).body as any;
    const a1 = r.rows.find((x: any) => x.asset_tag === 'A-1');
    expect(a1.availability).toBeCloseTo(0.9, 2);
    expect(a1.stops).toBe(1);
    const a2 = r.rows.find((x: any) => x.asset_tag === 'A-2');
    expect(a2).toMatchObject({ availability: null, data_quality: 'no state data' });
    expect(r.headline).toBe('All 1 measured asset at or above 90% availability over 10 days; A-1 accounts for 100% of unplanned downtime');
    expect(r.notes.join(' ')).toMatch(/OEE is not reported/);
  });

  it('facility-restricted users only get their facility in every format', async () => {
    const json = (await runReport(w.managerA, 'maintenance-backlog', {}, 'json')).body as any;
    expect(json.scope.facilities).toEqual(['A']);
    const csv = (await runReport(w.managerA, 'maintenance-backlog', {}, 'csv')).body as string;
    expect(csv).toContain('Overdue fix');
    expect(csv).not.toContain('B work');
    const forB = (await runReport(w.managerA, 'maintenance-backlog', { facilityId: w.facilities.B }, 'json')).body as any;
    expect(forB.rows).toHaveLength(0);
  });

  it('dashboard JSON, CSV and PDF agree on the same numbers', async () => {
    const json = (await runReport(w.exec, 'maintenance-backlog', {}, 'json')).body as any;
    const csv = (await runReport(w.exec, 'maintenance-backlog', {}, 'csv', { raw: true })).body as string;
    const lines = csv.trim().split('\r\n');
    expect(lines.length - 1).toBe(json.rows.length);
    const pdf = await runReport(w.exec, 'maintenance-backlog', {}, 'pdf');
    expect(pdf.contentType).toBe('application/pdf');
    expect((pdf.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
    const html = (await runReport(w.exec, 'asset-availability', {}, 'html')).body as string;
    expect(html).toContain('<h1>');
    expect(html).toContain('no data available (not zero)');
  });

  it('exports require the export permission and are audited', async () => {
    await expect(runReport(w.techA, 'maintenance-backlog', {}, 'csv')).rejects.toThrow(/reports.export/);
    const res = await app.inject({ url: '/api/reports/maintenance-backlog?format=pdf', headers: auth(w.tokens.exec!) });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
  });

  it('empty scope yields a clear message instead of zeros', async () => {
    const r = (await runReport(other.admin, 'asset-availability', {}, 'json')).body as any;
    expect(r.headline).toBe('Not enough recorded state history to assess availability');
    expect(r.kpis[0].value).toBeNull();
  });
});

describe('learning & qualification endpoints', () => {
  it('serves the catalog, qualification reports and a certificate PDF over HTTP', async () => {
    const h = auth(w.tokens.admin!);
    const course = (await app.inject({ method: 'POST', url: '/api/courses', headers: h, payload: { code: 'C-1', title: 'Basics' } })).json();
    const v = (await app.inject({ method: 'POST', url: `/api/courses/${course.id}/versions`, headers: h, payload: {} })).json();
    const evt = (await app.inject({ method: 'POST', url: `/api/course-versions/${v.id}/events`, headers: h, payload: { kind: 'practical_evaluation', title: 'Show me' } })).json();
    expect((await app.inject({ method: 'POST', url: `/api/course-versions/${v.id}/publish`, headers: h })).statusCode).toBe(200);
    const q = (await app.inject({ method: 'POST', url: '/api/qualifications', headers: h, payload: { code: 'Q-1', name: 'Basic', validityMonths: 12, requiresPractical: true, courseIds: [course.id] } })).json();
    const assign = (await app.inject({ method: 'POST', url: '/api/training/assign', headers: h, payload: { courseId: course.id, employeeIds: [w.techAEmployeeId] } })).json();
    const done = await app.inject({ method: 'POST', url: `/api/enrollments/${assign.enrollmentIds[0]}/events/${evt.id}/complete`, headers: auth(w.tokens.managerA!),
      payload: { outcome: 'passed', attestation: 'Performed the task unaided and safely.' } });
    expect(done.json().enrollmentStatus).toBe('completed');
    const grant = (await app.inject({ method: 'POST', url: `/api/qualifications/${q.id}/grant`, headers: auth(w.tokens.managerA!), payload: { employeeId: w.techAEmployeeId } })).json();
    const cert = (await app.inject({ method: 'POST', url: `/api/qualification-grants/${grant.id}/certificate`, headers: auth(w.tokens.managerA!) })).json();
    const pdf = await app.inject({ url: `/api/certificates/${cert.id}/pdf`, headers: auth(w.tokens.techA!) });
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect(pdf.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
    expect((await app.inject({ url: `/api/certificates/${cert.id}/pdf`, headers: auth(other.tokens.admin!) })).statusCode).toBe(404);
    const report = (await app.inject({ url: '/api/reports/qualification-status', headers: h })).json();
    expect(report.rows.map((r: any) => r.code)).toContain('Q-1');
    expect((await app.inject({ url: '/api/reports/training-compliance', headers: auth(w.tokens.techA!) })).statusCode).toBe(403);
  });
});

describe('management of change endpoints', () => {
  it('raises, screens and routes a change for approval over HTTP, and lists it in the register', async () => {
    const asset = (await app.inject({ url: '/api/assets?q=A-1', headers: auth(w.tokens.admin!) })).json()[0];
    const c = (await app.inject({ method: 'POST', url: '/api/moc', headers: auth(w.tokens.techA!), payload: {
      facilityId: w.facilities.A, title: 'New fixture plate for A-1', changeType: 'equipment', description: 'Replace the vise with a dedicated fixture plate.',
      justification: 'Cuts setup time by 40 minutes per job.', affected: [{ entityType: 'asset', entityId: asset.id }] } })).json();
    expect(c.number).toMatch(/^MOC-/);
    const questions = (await app.inject({ url: '/api/moc/screening-questions', headers: auth(w.tokens.techA!) })).json();
    const screening = Object.fromEntries(questions.map((q: any) => [q.key, false]));
    const sub = await app.inject({ method: 'POST', url: `/api/moc/${c.id}/submit`, headers: auth(w.tokens.techA!), payload: { screening } });
    expect(sub.json()).toMatchObject({ riskLevel: 'low', reviews: ['maintenance_manager'] });
    const queue = (await app.inject({ url: '/api/approvals/queue', headers: auth(w.tokens.managerA!) })).json();
    const mine = queue.find((q: any) => q.subjectId === c.id);
    expect(mine).toMatchObject({ role: 'maintenance_manager', subject: { number: c.number } });
    const d = await app.inject({ method: 'POST', url: `/api/approvals/steps/${mine.stepId}/decide`, headers: auth(w.tokens.managerA!), payload: { decision: 'approve' } });
    expect(d.json().requestStatus).toBe('pending'); // operations_manager authorization still required
    const assetView = (await app.inject({ url: `/api/assets/${asset.id}`, headers: auth(w.tokens.techA!) })).json();
    expect(assetView.openChanges.map((x: any) => x.number)).toEqual([c.number]);
    const reg = (await app.inject({ url: '/api/reports/moc-register', headers: auth(w.tokens.exec!) })).json();
    expect(reg.rows.find((r: any) => r.number === c.number)).toMatchObject({ stage: 'In review', waiting_on: 'Authorize the change' });
    expect((await app.inject({ url: `/api/moc/${c.id}`, headers: auth(other.tokens.admin!) })).statusCode).toBe(404);
  });
});

describe('inventory and PM endpoints', () => {
  it('receives stock, runs a PM plan through generation, and exports both reports', async () => {
    const h = auth(w.tokens.managerA!);
    const asset = (await app.inject({ url: '/api/assets?q=A-1', headers: auth(w.tokens.admin!) })).json()[0];
    const part = (await app.inject({ method: 'POST', url: '/api/parts', headers: auth(w.tokens.admin!), payload: { partNumber: 'OIL-68', description: 'ISO 68 hydraulic oil, 5 gal' } })).json();
    const loc = await app.inject({ method: 'POST', url: '/api/stock-locations', headers: h, payload: { facilityId: w.facilities.A, code: 'A-STORE', name: 'Storeroom' } });
    expect(loc.statusCode).toBe(201);
    const rec = await app.inject({ method: 'POST', url: '/api/inventory/receipts', headers: h, payload: { locationId: loc.json().id, partId: part.id, qty: 2, unitCost: 140 } });
    expect(rec.json()).toMatchObject({ balanceAfter: 2 });
    const over = await app.inject({ method: 'POST', url: '/api/inventory/adjustments', headers: h, payload: { locationId: loc.json().id, partId: part.id, qty: -5, reason: 'spilled drum' } });
    expect(over.statusCode).toBe(422);
    expect(over.json().error.code).toBe('insufficient_stock');
    expect((await app.inject({ method: 'PUT', url: '/api/inventory/settings', headers: h, payload: { locationId: loc.json().id, partId: part.id, reorderPoint: 2, reorderQty: 4 } })).statusCode).toBe(204);
    expect((await app.inject({ url: '/api/inventory?belowReorder=true', headers: auth(w.tokens.techA!) })).json().map((b: any) => b.part_number)).toEqual(['OIL-68']);
    expect((await app.inject({ method: 'POST', url: '/api/inventory/receipts', headers: auth(w.tokens.techA!), payload: { locationId: loc.json().id, partId: part.id, qty: 1 } })).statusCode).toBe(403);

    const plan = await app.inject({ method: 'POST', url: '/api/pm', headers: h, payload: {
      assetId: asset.id, code: 'PM-A1-Q', title: 'Quarterly oil change', triggerType: 'calendar', intervalDays: 90, firstDueOn: new Date().toISOString().slice(0, 10),
      parts: [{ partId: part.id, qty: 3 }] } });
    expect(plan.statusCode).toBe(201);
    const sched = (await app.inject({ url: '/api/pm', headers: h })).json();
    expect(sched.find((p: any) => p.code === 'PM-A1-Q')).toMatchObject({ due_state: 'due', parts_short: 1 });
    const gen = (await app.inject({ method: 'POST', url: '/api/pm/generate', headers: h, payload: {} })).json();
    expect(gen.created.map((c: any) => c.plan)).toEqual(['PM-A1-Q']);
    expect((await app.inject({ method: 'POST', url: `/api/assets/${asset.id}/meters`, headers: h, payload: { meter: 'run_hours', value: 10 } })).statusCode).toBe(201);
    expect((await app.inject({ method: 'POST', url: `/api/assets/${asset.id}/meters`, headers: h, payload: { meter: 'run_hours', value: 5 } })).statusCode).toBe(422);

    const ro = (await app.inject({ url: '/api/reports/inventory-reorder', headers: h })).json();
    expect(ro.rows[0]).toMatchObject({ part_number: 'OIL-68', on_hand: 2, pm_demand: 3, suggested_qty: 4 });
    const csvOut = await app.inject({ url: '/api/reports/pm-compliance?format=csv', headers: h });
    expect(csvOut.statusCode).toBe(200);
    expect(csvOut.body).toContain('PM-A1-Q');
    expect((await app.inject({ url: '/api/reports/inventory-reorder?format=pdf', headers: h })).rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
  });
});
