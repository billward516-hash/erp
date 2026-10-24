import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { asActor } from '../src/platform/auth/actor.js';
import { closePools } from '../src/platform/db/pool.js';
import { forgetEdition } from '../src/platform/edition.js';
import { forgetFeatures } from '../src/platform/features.js';
import { setFeature } from '../src/modules/features/service.js';
import { getSample, listSamples } from '../src/modules/lab/samples.js';
import { runReminders } from '../src/modules/notifications/reminders.js';
import { getReport } from '../src/modules/reporting/registry.js';
import type { Lab } from './lab-fixtures.js';
import { day, db, enterPassing, makeLab, passing, sampleWithTest, tokenFor } from './lab-fixtures.js';

let app: FastifyInstance; let l: Lab; let other: Lab;
const tok: Record<string, string> = {};
const call = (who: string, method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) => app.inject({ method, url, headers: { authorization: `Bearer ${tok[who]}` }, payload: payload as any });

beforeAll(async () => {
  app = buildApp();
  l = await makeLab('labacc'); other = await makeLab('labother');
  for (const k of ['analyst', 'unqualified', 'reviewer', 'manager', 'quality', 'managerB'] as const) tok[k] = await tokenFor(l, l[k].userId);
  tok.admin = l.w.tokens.admin!; tok.tech = l.w.tokens.techA!; tok.exec = l.w.tokens.exec!;
});
afterAll(async () => { await app.close(); await closePools(); });

describe('permissions', () => {
  it('a technician or operator with no laboratory permission sees nothing and can do nothing', async () => {
    expect((await call('tech', 'GET', '/api/lab/samples')).statusCode).toBe(403);
    expect((await call('tech', 'GET', '/api/lab/methods')).statusCode).toBe(403);
    expect((await call('tech', 'POST', '/api/lab/samples', { facilityId: l.w.facilities.A, source: 'internal', description: 'Water', dueOn: day(3) })).statusCode).toBe(403);
  });

  it('each step needs its own permission', async () => {
    const body = { facilityId: l.w.facilities.A, source: 'internal', description: 'Water sample', dueOn: day(3) };
    expect((await call('reviewer', 'POST', '/api/lab/samples', body)).statusCode).toBe(403); // reviewers do not receive samples
    expect((await call('analyst', 'POST', '/api/lab/methods', { facilityId: l.w.facilities.A, code: 'X-1', name: 'Method X', analytes: [{ name: 'A', unit: 'mg' }] })).statusCode).toBe(403);
    const made = await call('analyst', 'POST', '/api/lab/samples', body);
    expect(made.statusCode).toBe(201);
    const id = made.json().id;
    expect((await call('analyst', 'POST', `/api/lab/samples/${id}/release`, {})).statusCode).toBe(403);
    expect((await call('analyst', 'POST', `/api/lab/samples/${id}/dispose`, { note: 'gone' })).statusCode).toBe(403);
    expect((await call('exec', 'GET', `/api/lab/samples/${id}`)).statusCode).toBe(403); // an executive reads quality, not the lab
  });

  it('the full flow works over HTTP: receive, test, results, review, release, certificate', async () => {
    const m = await call('manager', 'POST', '/api/lab/methods', { facilityId: l.w.facilities.A, code: 'KF-01', name: 'Karl Fischer', analytes: [{ name: 'Water', unit: '%', specHigh: 0.5 }] });
    expect(m.statusCode).toBe(201);
    const s = (await call('analyst', 'POST', '/api/lab/samples', { facilityId: l.w.facilities.A, source: 'internal', description: 'Solvent drum 7', dueOn: day(2), storageLocation: 'Cage 1', retentionUntil: day(60) })).json();
    const t = (await call('analyst', 'POST', `/api/lab/samples/${s.id}/tests`, { methodId: m.json().id })).json();
    const analyte = m.json().analytes?.[0]?.id ?? (await db().query('SELECT id FROM lab_method_analyte WHERE method_id = $1', [m.json().id])).rows[0].id;
    expect((await call('analyst', 'POST', `/api/lab/tests/${t.id}/results`, { results: [{ analyteId: analyte, value: 0.21 }] })).json()).toEqual({ complete: true, outOfSpecification: 0 });
    expect((await call('analyst', 'POST', `/api/lab/tests/${t.id}/review`, {})).statusCode).toBe(403);
    expect((await call('reviewer', 'POST', `/api/lab/tests/${t.id}/review`, { note: 'ok' })).statusCode).toBe(204);
    expect((await call('analyst', 'GET', `/api/lab/samples/${s.id}/certificate.pdf`)).statusCode).toBe(409);
    expect((await call('reviewer', 'POST', `/api/lab/samples/${s.id}/release`, {})).statusCode).toBe(204);
    const pdf = await call('analyst', 'GET', `/api/lab/samples/${s.id}/certificate.pdf`);
    expect(pdf.statusCode).toBe(200);
    expect(pdf.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
    const detail = (await call('analyst', 'GET', `/api/lab/samples/${s.id}`)).json();
    expect(detail).toMatchObject({ status: 'released', canAnalyze: true, canReview: false });
    expect((await call('analyst', 'GET', '/api/lab/options')).json()).toMatchObject({ instruments: expect.any(Array), qualifications: [{ code: 'QUAL-TITR' }] });
  });

  it('validates what it is given', async () => {
    expect((await call('analyst', 'POST', '/api/lab/samples', { facilityId: l.w.facilities.A, source: 'internal', description: 'Water', dueOn: 'next week' })).statusCode).toBe(422);
    expect((await call('manager', 'POST', '/api/lab/methods', { facilityId: l.w.facilities.A, code: 'BAD', name: 'Bad', analytes: [{ name: 'A', unit: 'mg', specLow: 5, specHigh: 1 }] })).json().error.message).toMatch(/low limit is above the high limit/);
    expect((await call('manager', 'POST', '/api/lab/methods', { facilityId: l.w.facilities.A, code: 'BAD2', name: 'Bad', analytes: [] })).statusCode).toBe(422);
  });
});

describe('site and company isolation', () => {
  let a1: any; let b1: any;
  it('a person at one site cannot see or work another site’s samples', async () => {
    a1 = (await sampleWithTest(l)).sample;
    b1 = await asActor(l.managerB, (tx) => import('../src/modules/lab/samples.js').then((m) => m.receiveSample(tx, l.managerB, { facilityId: l.w.facilities.B!, source: 'internal', description: 'Plant B sample', dueOn: day(4) })));
    expect((await asActor(l.managerB, (tx) => listSamples(tx, l.managerB))).map((s) => s.number)).toEqual([b1.number]);
    expect((await asActor(l.analyst, (tx) => listSamples(tx, l.analyst))).map((s) => s.number)).not.toContain(b1.number);
    await expect(asActor(l.managerB, (tx) => getSample(tx, l.managerB, a1.id))).rejects.toThrow(/not found/);
    await expect(asActor(l.analyst, (tx) => getSample(tx, l.analyst, b1.id))).rejects.toThrow(/not found/);
    expect((await call('analyst', 'POST', '/api/lab/samples', { facilityId: l.w.facilities.B, source: 'internal', description: 'Wrong site', dueOn: day(4) })).statusCode).toBe(403);
    expect((await call('managerB', 'GET', `/api/lab/samples/${a1.id}/certificate.pdf`)).statusCode).toBe(404);
  });

  it('a method at one site cannot be used on another site’s sample', async () => {
    await expect(asActor(l.managerB, (tx) => import('../src/modules/lab/results.js').then((m) => m.addTest(tx, l.managerB, b1.id, { methodId: l.methodId })))).rejects.toThrow(/not found/);
  });

  it('another company sees none of it, whatever the permissions', async () => {
    const mine = await asActor(l.manager, (tx) => listSamples(tx, l.manager));
    const theirs = await asActor(other.manager, (tx) => listSamples(tx, other.manager));
    expect(mine.length).toBeGreaterThan(0);
    expect(theirs.map((s) => s.id).filter((id) => mine.some((m) => m.id === id))).toEqual([]);
    await expect(asActor(other.manager, (tx) => getSample(tx, other.manager, a1.id))).rejects.toThrow(/not found/);
    const rows = (await db().query(`SELECT count(*)::int AS n FROM lab_method WHERE tenant_id = $1`, [other.w.tenantId])).rows[0].n;
    expect(rows).toBe(1);
  });

  it('every new table has row-level security on', async () => {
    const t = (await db().query(`SELECT relname FROM pg_class WHERE relname LIKE 'lab\\_%' AND relkind = 'r' AND NOT relrowsecurity`)).rows;
    expect(t).toEqual([]);
  });
});

describe('editions and feature visibility', () => {
  it('is not part of the Lite edition', async () => {
    await db().query(`UPDATE tenant_license SET edition = 'lite' WHERE tenant_id = $1`, [l.w.tenantId]);
    forgetEdition(l.w.tenantId);
    try {
      const r = await call('admin', 'GET', '/api/lab/samples');
      expect(r.statusCode).toBeGreaterThanOrEqual(400);
      expect(JSON.stringify(r.json())).toMatch(/Standard|upgrade|edition/i);
      expect((await call('admin', 'GET', '/api/reports/lab-turnaround')).statusCode).toBeGreaterThanOrEqual(400);
    } finally {
      await db().query(`UPDATE tenant_license SET edition = 'standard' WHERE tenant_id = $1`, [l.w.tenantId]);
      forgetEdition(l.w.tenantId);
    }
    expect((await call('admin', 'GET', '/api/lab/samples')).statusCode).toBe(200);
  });

  it('can be turned off on its own: the area and its reports are refused and its reminders stop', async () => {
    await asActor(l.w.admin, (tx) => setFeature(tx, l.w.admin, 'lab_samples', { mode: 'off' }));
    forgetFeatures(l.w.tenantId);
    try {
      const r = await call('admin', 'GET', '/api/lab/samples');
      expect(r.json().error.code).toBe('feature_off');
      expect((await call('admin', 'GET', '/api/reports/lab-oos')).json().error.code).toBe('feature_off');
      expect((await call('admin', 'GET', '/api/reports')).json().map((x: any) => x.id)).not.toContain('lab-workload');
    } finally {
      await asActor(l.w.admin, (tx) => setFeature(tx, l.w.admin, 'lab_samples', { mode: 'all' }));
      forgetFeatures(l.w.tenantId);
    }
    expect((await call('admin', 'GET', '/api/reports')).json().map((x: any) => x.id)).toEqual(expect.arrayContaining(['lab-turnaround', 'lab-oos', 'lab-workload']));
  });
});

describe('what is late, reminders and reports', () => {
  let late: any; let lateTest: any;
  it('an open sample past its turnaround target and its unfinished tests show on What is late, and only to people who see the lab', async () => {
    ({ sample: late, test: lateTest } = await sampleWithTest(l, { receivedOn: day(-12), dueOn: day(-4), description: 'Overdue powder', retentionUntil: day(5) }));
    const res = (await call('manager', 'GET', '/api/what-is-late')).json();
    const samples = res.sections.find((s: any) => s.key === 'lab-samples');
    expect(samples.rows).toContainEqual(expect.objectContaining({ label: expect.stringContaining(late.number), daysLate: 4, href: `/lab/samples/${late.id}` }));
    const tests = res.sections.find((s: any) => s.key === 'lab-tests');
    expect(tests.rows).toContainEqual(expect.objectContaining({ label: `${late.number} · TITR-01 v${(await db().query('SELECT version FROM lab_method WHERE id = $1', [l.methodId])).rows[0].version}`, detail: 'Waiting for results' }));
    expect((await call('tech', 'GET', '/api/what-is-late')).json().sections.map((s: any) => s.key)).not.toContain('lab-samples');
    expect((await call('managerB', 'GET', '/api/what-is-late')).json().sections.map((s: any) => s.key)).not.toContain('lab-samples');
    expect((await call('admin', 'GET', '/api/what-is-late')).json().sections.map((s: any) => s.key)).toContain('lab-samples');
  });

  it('daily reminders go to laboratory staff and managers once, and carry the retention date', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const first = await runReminders(l.w.tenantId, today);
    expect((first as any).lab_sample_due).toBeGreaterThan(0);
    expect((first as any).lab_retention_due).toBeGreaterThan(0);
    const due = (await db().query(`SELECT user_id, title, body FROM notification WHERE kind = 'reminder.lab_sample_due' AND tenant_id = $1`, [l.w.tenantId])).rows;
    expect(due.map((r) => r.user_id)).toContain(l.analyst.userId);
    expect(due.some((r) => r.body.includes(late.number))).toBe(true);
    const ret = (await db().query(`SELECT user_id, body FROM notification WHERE kind = 'reminder.lab_retention_due' AND tenant_id = $1`, [l.w.tenantId])).rows;
    expect(ret.map((r) => r.user_id)).toContain(l.manager.userId);
    expect(ret.map((r) => r.user_id)).not.toContain(l.analyst.userId); // analysts do not dispose of samples
    const again = await runReminders(l.w.tenantId, today);
    expect((again as any).lab_sample_due ?? 0).toBe(0);
    expect((again as any).lab_retention_due ?? 0).toBe(0);
  });

  it('a released or disposed sample is no longer late or due', async () => {
    await asActor(l.analyst, (tx) => import('../src/modules/lab/results.js').then((m) => m.enterResults(tx, l.analyst, lateTest.id, passing(l))));
    await asActor(l.reviewer, (tx) => import('../src/modules/lab/results.js').then((m) => m.reviewTest(tx, l.reviewer, lateTest.id)));
    await asActor(l.reviewer, (tx) => import('../src/modules/lab/samples.js').then((m) => m.releaseSample(tx, l.reviewer, late.id)));
    const keys = (await call('manager', 'GET', '/api/what-is-late')).json().sections.flatMap((s: any) => s.rows.map((r: any) => r.label));
    expect(keys.filter((k: string) => k.includes(late.number))).toEqual([]);
  });

  it('the turnaround, out-of-specification and workload reports answer with the lab’s records', async () => {
    // One on-time release, one late release, one open past target, one investigation.
    const { sample, test } = await sampleWithTest(l, { receivedOn: day(-6), dueOn: day(-1) });
    await enterPassing(l, test.id);
    await asActor(l.reviewer, (tx) => import('../src/modules/lab/results.js').then((m) => m.reviewTest(tx, l.reviewer, test.id)));
    await asActor(l.reviewer, (tx) => import('../src/modules/lab/samples.js').then((m) => m.releaseSample(tx, l.reviewer, sample.id)));
    const oos = await sampleWithTest(l);
    await asActor(l.analyst, (tx) => import('../src/modules/lab/results.js').then((m) => m.enterResults(tx, l.analyst, oos.test.id, [{ analyteId: l.titrationAnalytes.Moisture!, value: 9, instrumentId: l.balance },
      { analyteId: l.titrationAnalytes.Assay!, value: 99, instrumentId: l.balance }, { analyteId: l.titrationAnalytes.pH!, value: 7, instrumentId: l.balance }])));
    await sampleWithTest(l, { receivedOn: day(-9), dueOn: day(-5), description: 'Still open' });

    const run = (id: string, params: any = {}) => asActor(l.manager, (tx) => getReport(id)!.run(tx, l.manager, getReport(id)!.params.parse(params)));
    const turn = await run('lab-turnaround');
    expect(turn.rows.length).toBeGreaterThanOrEqual(4);
    expect(turn.kpis.find((k) => k.label === 'Open past target')!.value).toBeGreaterThanOrEqual(1);
    expect(turn.rows.find((r) => r.number === sample.number)).toMatchObject({ status: 'Released', days_to_release: 6, days_late: 1 });
    expect(turn.headline).toMatch(/past the turnaround target/);
    const o = await run('lab-oos');
    expect(o.rows).toContainEqual(expect.objectContaining({ analyte: 'Moisture', status: 'Open', limits: 'at most 2 %' }));
    expect(o.kpis.find((k) => k.label === 'Open')!.value).toBeGreaterThanOrEqual(1);
    expect(o.charts?.[0]?.data[0]).toMatchObject({ method: 'TITR-01' });
    const wl = await run('lab-workload');
    const mine = wl.rows.filter((r) => r.analyst === 'analyst' && /^TITR-01 v/.test(String(r.method)));
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.reduce((n, r) => n + Number(r.tests), 0)).toBeGreaterThanOrEqual(3);
    expect(mine.reduce((n, r) => n + Number(r.out_of_spec), 0)).toBeGreaterThanOrEqual(1);
    // Site isolation in reports: the other plant's manager sees none of site A's samples.
    const b = await asActor(l.managerB, (tx) => getReport('lab-turnaround')!.run(tx, l.managerB, getReport('lab-turnaround')!.params.parse({})));
    expect(b.rows.map((r) => r.number)).not.toContain(sample.number);
    for (const id of ['lab-turnaround', 'lab-oos', 'lab-workload']) {
      expect((await call('tech', 'GET', `/api/reports/${id}`)).statusCode).toBe(403);
      for (const f of ['csv', 'pdf', 'xlsx']) expect((await call('manager', 'GET', `/api/reports/${id}?format=${f}`)).statusCode, `${id} ${f}`).toBe(200);
    }
  });
});
