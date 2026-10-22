import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { asActor } from '../src/platform/auth/actor.js';
import { closePools } from '../src/platform/db/pool.js';
import { LocalBlobStore } from '../src/platform/storage/blob-store.js';
import { createAsset, recordState } from '../src/modules/assets/service.js';
import { createWorkOrder } from '../src/modules/maintenance/service.js';
import ExcelJS from 'exceljs';
import { deleteView, listReports, listViews, runReport, saveView } from '../src/modules/reporting/service.js';
import { REPORTS } from '../src/modules/reporting/registry.js';
import { screenFor } from '../src/modules/reporting/drill.js';
import { axisLabel, chartSvg, layoutChart, niceTicks } from '../src/modules/reporting/render/chart.js';
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

  it('the Excel workbook holds the same rows as typed cells, links each row to its screen, and never writes formulas', async () => {
    const json = (await runReport(w.exec, 'maintenance-backlog', {}, 'json')).body as any;
    const out = await runReport(w.exec, 'maintenance-backlog', {}, 'xlsx');
    expect(out.contentType).toMatch(/spreadsheetml/);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(out.body as any);
    const ws = wb.getWorksheet('Report')!;
    expect(ws.getCell(2, 2).value).toBe(json.headline);
    let head = 0;
    ws.eachRow((row, n) => { if (!head && row.getCell(1).value === json.columns[0].label) head = n; });
    expect(head).toBeGreaterThan(0);
    const body: ExcelJS.Row[] = [];
    for (let n = head + 1; n <= head + json.rows.length; n++) body.push(ws.getRow(n));
    expect(body.map((r) => r.getCell(1).value)).toEqual(json.rows.map((r: any) => r[json.columns[0].key]));
    const open = ws.getRow(head).cellCount;
    expect(ws.getRow(head).getCell(open).value).toBe('Open');
    expect((body[0]!.getCell(open).value as any).hyperlink).toMatch(new RegExp(`/work-orders/${json.rows[0].id}$`));
    const numeric = json.columns.findIndex((c: any) => c.type !== 'text' && c.type !== 'date' && c.type !== 'datetime');
    if (numeric >= 0 && json.rows[0][json.columns[numeric].key] != null) expect(typeof body[0]!.getCell(numeric + 1).value).toBe('number');
    ws.eachRow((row) => row.eachCell((c) => expect(c.formula).toBeUndefined()));
    expect(wb.getWorksheet('Notes')!.getCell(1, 1).value).toBe('Insights');
  });

  it('every drill-down a report declares leads to a screen, except the ones without a page', () => {
    const declared = ['/api/assets/1', '/api/assets/1/reliability', '/api/work-orders/1', '/api/pm/1', '/api/continuity-plans/1', '/api/customer-invoices/1', '/api/supplier-invoices/1',
      '/api/enrollments/1', '/api/expenses/1', '/api/fmeas/1', '/api/incidents/1', '/api/moc/1', '/api/nonconformances/1', '/api/production-orders/1', '/api/purchase-requests/1', '/api/purchase-orders/1'];
    expect(declared.filter((p) => !screenFor(p))).toEqual([]);
    expect(screenFor('/api/employees/1/qualifications')).toBeNull();
    expect(REPORTS.length).toBeGreaterThan(30);
  });

  it('describes each report\'s filters from its parameters, and links rows to their screens on screen too', async () => {
    const avail = listReports().find((r) => r.id === 'asset-availability')!;
    expect(avail.filters.map((f) => [f.key, f.type])).toEqual([['facilityId', 'facility'], ['from', 'date'], ['to', 'date'], ['basis', 'choice'], ['minCoverage', 'number']]);
    expect(avail.filters.find((f) => f.key === 'minCoverage')).toMatchObject({ min: 0, max: 1, default: 0.5, ratio: true });
    expect(avail.filters.find((f) => f.key === 'basis')).toMatchObject({ values: ['calendar', 'scheduled'], default: 'scheduled' });
    expect(listReports().every((r) => r.filters.every((f) => f.type !== 'text'))).toBe(true);
    const json = (await runReport(w.admin, 'maintenance-backlog', {}, 'json')).body as any;
    expect(json.links[0]).toBe(`/work-orders/${json.rows[0].id}`);
  });

  it('saved views: private by default, shared by people who may export, validated, deleted by their owner', async () => {
    const mine = await asActor(w.managerA, (tx) => saveView(tx, w.managerA, 'maintenance-backlog', { name: 'My site', params: { facilityId: w.facilities.A, junk: '' } }));
    await expect(asActor(w.managerA, (tx) => saveView(tx, w.managerA, 'asset-availability', { name: 'Bad', params: { minCoverage: 5 } }))).rejects.toThrow(/not valid for this report/);
    await expect(asActor(w.techA, (tx) => saveView(tx, w.techA, 'maintenance-backlog', { name: 'Everyone', params: {}, shared: true }))).rejects.toThrow(/reports.export/);
    const shared = await asActor(w.exec, (tx) => saveView(tx, w.exec, 'maintenance-backlog', { name: 'Company backlog', params: {}, shared: true }));
    const seenByExec = await asActor(w.exec, (tx) => listViews(tx, w.exec, 'maintenance-backlog'));
    expect(seenByExec.map((v) => v.name)).toEqual(['Company backlog']);
    const seenByManager = await asActor(w.managerA, (tx) => listViews(tx, w.managerA, 'maintenance-backlog'));
    expect(seenByManager.map((v) => [v.name, v.mine, v.params])).toEqual([['My site', true, { facilityId: w.facilities.A }], ['Company backlog', false, {}]]);
    // Saving again under the same name updates the view.
    await asActor(w.managerA, (tx) => saveView(tx, w.managerA, 'maintenance-backlog', { name: 'my site', params: {} }));
    expect((await asActor(w.managerA, (tx) => listViews(tx, w.managerA, 'maintenance-backlog'))).filter((v) => v.mine)).toHaveLength(1);
    await expect(asActor(w.managerA, (tx) => deleteView(tx, w.managerA, shared.id))).rejects.toThrow(/tenant.admin/);
    await expect(asActor(w.exec, (tx) => deleteView(tx, w.exec, mine.id))).rejects.toThrow(/not found/);
    await asActor(w.exec, (tx) => deleteView(tx, w.exec, shared.id));
    // Another company never sees these views.
    expect(await asActor(other.admin, (tx) => listViews(tx, other.admin, 'maintenance-backlog'))).toEqual([]);
  });

  it('the chart library: nice ticks from zero, compact axis labels, extremes labelled, negative bars drawn left of zero', () => {
    expect(niceTicks(0, 87)).toEqual([0, 20, 40, 60, 80, 100]);
    expect(niceTicks(-1200, 3400)).toEqual([-2000, -1000, 0, 1000, 2000, 3000, 4000]);
    expect([axisLabel(12500, 'currency'), axisLabel(0.855, 'percent'), axisLabel(-2500, 'currency'), axisLabel(1_250_000, 'integer')]).toEqual(['$13k', '85.5%', '-$2.5k', '1.3M']);
    const chart = { kind: 'bars' as const, title: 'Net by site', category: { key: 'site', label: 'Sites' }, series: [{ key: 'net', label: 'Net' }], valueType: 'currency' as const,
      data: [{ site: 'A', net: 1200 }, { site: 'B', net: -300 }, { site: 'C', net: 450 }] };
    const l = layoutChart(chart, 600);
    const texts = l.shapes.filter((x) => x.t === 'text').map((x: any) => x.text);
    expect(texts).toContain('$1,200.00'); expect(texts).toContain('-$300.00'); expect(texts).not.toContain('$450.00'); // extremes only
    const rects = l.shapes.filter((x) => x.t === 'rect') as any[];
    const zero = (l.shapes.find((x: any) => x.t === 'line' && x.stroke === '#5b6472') as any).x1;
    expect(rects[1].x + rects[1].w).toBeCloseTo(zero, 5); // B's bar ends at zero, on the left
    expect(l.summary).toMatch(/highest A \$1,200.00, lowest B -\$300.00/);
    expect(chartSvg(chart)).toMatch(/^<figure class="chart"><figcaption>Net by site<\/figcaption><svg [^>]*role="img"/);
  });

  it('charts travel with the report into JSON, print HTML and PDF', async () => {
    const json = (await runReport(w.exec, 'maintenance-backlog', {}, 'json')).body as any;
    expect(json.charts[0]).toMatchObject({ kind: 'columns', title: 'Open work orders by age' });
    expect(json.charts[0].data.reduce((s: number, d: any) => s + d.open, 0)).toBe(json.rows.length);
    const html = (await runReport(w.exec, 'maintenance-backlog', {}, 'html')).body as string;
    expect(html).toContain('<figcaption>Open work orders by age</figcaption>');
    const pdf = (await runReport(w.exec, 'maintenance-backlog', {}, 'pdf')).body as Buffer;
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
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

describe('purchasing endpoints', () => {
  it('raises a request, approves it from the queue, orders it, prints the PO and receives it', async () => {
    const hb = auth(w.tokens.buyer!);
    const sup = (await app.inject({ method: 'POST', url: '/api/suppliers', headers: hb, payload: { code: 'MCM', name: 'McMaster Demo Supply', paymentTerms: 'Net 30' } })).json();
    const part = (await app.inject({ url: '/api/parts?q=OIL-68', headers: hb })).json()[0];
    expect((await app.inject({ method: 'PUT', url: `/api/suppliers/${sup.id}/parts/${part.id}`, headers: hb, payload: { unitPrice: 135, leadTimeDays: 3, preferred: true } })).statusCode).toBe(204);
    const loc = (await app.inject({ url: '/api/stock-locations', headers: hb })).json().find((l: any) => l.code === 'A-STORE');
    const pr = await app.inject({ method: 'POST', url: '/api/purchase-requests', headers: auth(w.tokens.techA!), payload: {
      facilityId: w.facilities.A, title: 'Hydraulic oil', lines: [{ partId: part.id, qty: 4, locationId: loc.id }] } });
    expect(pr.statusCode).toBe(201);
    const sub = (await app.inject({ method: 'POST', url: `/api/purchase-requests/${pr.json().id}/submit`, headers: auth(w.tokens.techA!) })).json();
    expect(sub.total).toBe(540);
    const step = (await app.inject({ url: '/api/approvals/queue', headers: auth(w.tokens.managerA!) })).json().find((q: any) => q.subjectId === pr.json().id);
    expect(step.subject).toMatchObject({ number: pr.json().number, total: 540, spend_type: 'opex' });
    await app.inject({ method: 'POST', url: `/api/approvals/steps/${step.stepId}/decide`, headers: auth(w.tokens.managerA!), payload: { decision: 'approve' } });
    const ord = await app.inject({ method: 'POST', url: `/api/purchase-requests/${pr.json().id}/order`, headers: hb, payload: {} });
    expect(ord.statusCode).toBe(201);
    const po = ord.json().orders[0];
    const pdf = await app.inject({ url: `/api/purchase-orders/${po.id}/pdf`, headers: hb });
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect(pdf.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
    const detail = (await app.inject({ url: `/api/purchase-orders/${po.id}`, headers: hb })).json();
    const rec = await app.inject({ method: 'POST', url: `/api/purchase-orders/${po.id}/receive`, headers: auth(w.tokens.managerA!), payload: { lines: [{ orderLineId: detail.lines[0].id, qty: 4 }] } });
    expect(rec.json().status).toBe('received');
    expect((await app.inject({ url: '/api/reports/purchasing-status?format=pdf', headers: hb })).rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
    expect((await app.inject({ url: `/api/purchase-orders/${po.id}`, headers: auth(other.tokens.admin!) })).statusCode).toBe(404);
  });
});

describe('accounts payable and integration endpoints', () => {
  it('captures an invoice with its PDF, approves it, exports it to a file and reports aging', async () => {
    const ha = auth(w.tokens.admin!);
    const hf = auth(w.tokens.finance!);
    const po = (await app.inject({ url: '/api/purchase-orders', headers: ha })).json().find((o: any) => o.supplier_name === 'McMaster Demo Supply');
    const draft = (await app.inject({ url: `/api/purchase-orders/${po.id}/invoice-draft`, headers: ha })).json();
    const inv = await app.inject({ method: 'POST', url: '/api/supplier-invoices', headers: ha, payload: {
      supplierId: draft.supplier_id, purchaseOrderId: po.id, invoiceNumber: 'MCM-77', invoiceDate: '2026-10-15',
      lines: draft.lines.map((l: any) => ({ poLineId: l.po_line_id, qty: l.toInvoice, unitPrice: l.unit_price })),
      file: { name: 'MCM-77.pdf', mime: 'application/pdf', contentBase64: Buffer.from('%PDF-1.4 invoice').toString('base64') } } });
    expect(inv.statusCode).toBe(201);
    expect(inv.json().due_date).toBe('2026-11-14');
    const file = await app.inject({ url: `/api/supplier-invoices/${inv.json().id}/file`, headers: hf });
    expect(file.headers['content-type']).toBe('application/pdf');
    expect((await app.inject({ method: 'POST', url: `/api/supplier-invoices/${inv.json().id}/approve`, headers: ha, payload: {} })).statusCode).toBe(422); // captured it
    expect((await app.inject({ method: 'POST', url: `/api/supplier-invoices/${inv.json().id}/approve`, headers: hf, payload: {} })).json()).toMatchObject({ total: 540, matched: true });
    expect((await app.inject({ method: 'POST', url: '/api/integrations', headers: hf, payload: { provider: 'file_export' } })).statusCode).toBe(403);
    const conn = (await app.inject({ method: 'POST', url: '/api/integrations', headers: ha, payload: { provider: 'file_export', backfill: 'all' } })).json();
    expect((await app.inject({ method: 'PUT', url: '/api/account-mappings/inventory', headers: ha, payload: { externalCode: '1400', externalName: 'Inventory' } })).statusCode).toBe(204);
    expect((await app.inject({ method: 'POST', url: '/api/integrations/sync', headers: ha })).json()).toMatchObject({ delivered: 1 });
    const files = (await app.inject({ url: `/api/integrations/${conn.id}/files`, headers: ha })).json();
    const csv = await app.inject({ url: `/api/export-files/${files[0].id}`, headers: ha });
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.body).toContain('MCM-77');
    const aging = (await app.inject({ url: '/api/reports/ap-aging', headers: hf })).json();
    expect(aging.rows.find((r: any) => r.invoice_number === 'MCM-77')).toMatchObject({ stage: 'In accounting, unpaid', amount: 540 });
    expect((await app.inject({ url: `/api/supplier-invoices/${inv.json().id}`, headers: auth(other.tokens.admin!) })).statusCode).toBe(404);
  });
});
