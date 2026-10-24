import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { asActor } from '../src/platform/auth/actor.js';
import { closePools } from '../src/platform/db/pool.js';
import { certificateData, renderCertificatePdf } from '../src/modules/lab/certificate.js';
import { closeInvestigation, enterResults, reviewTest, updateInvestigation } from '../src/modules/lab/results.js';
import { releaseSample } from '../src/modules/lab/samples.js';
import type { Lab } from './lab-fixtures.js';
import { db, enterPassing, makeLab, sampleWithTest } from './lab-fixtures.js';

let app: FastifyInstance; let l: Lab;
beforeAll(async () => { app = buildApp(); l = await makeLab('labcoa'); });
afterAll(async () => { await app.close(); await closePools(); });

/** Plain text of an uncompressed PDF: pdfkit writes standard-font text as hex strings inside TJ arrays. */
function pdfText(pdf: Buffer) {
  const raw = pdf.toString('latin1');
  const out: string[] = [];
  for (const arr of raw.matchAll(/\[([^\]]*)\]\s*TJ/g)) {
    out.push([...arr[1]!.matchAll(/<([0-9a-fA-F]*)>/g)].map((m) => Buffer.from(m[1]!, 'hex').toString('latin1')).join(''));
  }
  return out.join('\n');
}
const pages = (pdf: Buffer) => (pdf.toString('latin1').match(/\/Type \/Page\b(?!s)/g) ?? []).length;

describe('certificate of analysis', () => {
  it('is issued only for a released sample', async () => {
    const { sample, test } = await sampleWithTest(l, { customerId: (await db().query(`INSERT INTO customer (tenant_id, code, name) VALUES ($1, 'ACME', 'Acme Pharma') RETURNING id`, [l.w.tenantId])).rows[0].id, customerReference: 'PO-77' });
    await enterPassing(l, test.id);
    await expect(asActor(l.reviewer, (tx) => certificateData(tx, l.reviewer, sample.id))).rejects.toThrow(/has not been released/);
    await asActor(l.reviewer, (tx) => reviewTest(tx, l.reviewer, test.id));
    await asActor(l.reviewer, (tx) => releaseSample(tx, l.reviewer, sample.id));
    const res = await app.inject({ url: `/api/lab/samples/${sample.id}/certificate.pdf`, headers: { authorization: `Bearer ${(await token(l.analyst.userId))}` } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/pdf/);
    expect(res.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('lists customer, sample, method and version, results with limits and units, analyst, reviewer, instrument ids with calibration due dates and the release date', async () => {
    const cust = (await db().query(`SELECT id FROM customer WHERE tenant_id = $1 AND code = 'ACME'`, [l.w.tenantId])).rows[0].id;
    const { sample, test } = await sampleWithTest(l, { customerId: cust, customerReference: 'PO-78', description: 'Lot 42 white powder', container: 'HDPE jar', quantity: 250, quantityUnit: 'g' });
    await asActor(l.analyst, (tx) => enterResults(tx, l.analyst, test.id, [
      { analyteId: l.titrationAnalytes.Assay!, value: 99.2, instrumentId: l.balance }, { analyteId: l.titrationAnalytes.Moisture!, value: 1.1, instrumentId: l.balance }, { analyteId: l.titrationAnalytes.pH!, value: 6.9, instrumentId: l.balance }]));
    await asActor(l.reviewer, (tx) => reviewTest(tx, l.reviewer, test.id));
    await asActor(l.reviewer, (tx) => releaseSample(tx, l.reviewer, sample.id));
    const c = await asActor(l.reviewer, (tx) => certificateData(tx, l.reviewer, sample.id));
    const due = (await db().query(`SELECT p.next_due::text AS d FROM calibration_plan p WHERE p.asset_id = $1`, [l.balance])).rows[0].d;
    expect(c).toMatchObject({ number: sample.number, customer: 'Acme Pharma', customerReference: 'PO-78', facility: 'Plant A', releasedBy: 'reviewer' });
    expect(c.tests).toHaveLength(1);
    expect(c.tests[0]).toMatchObject({ method: 'TITR-01', analyst: 'analyst', reviewer: 'reviewer', document: 'SOP-TITR' });
    expect(c.tests[0]!.results.map((r) => [r.analyte, r.value, r.unit, r.limits, r.outcome, r.instrument, r.calDue])).toEqual([
      ['Assay', 99.2, '%', 'at least 98', 'Pass', 'BAL-1', due], ['Moisture', 1.1, '%', 'at most 2', 'Pass', 'BAL-1', due], ['pH', 6.9, 'pH', '6.5 to 7.5', 'Pass', 'BAL-1', due]]);
    expect(c.summary).toMatch(/within its specification/);

    const pdf = await renderCertificatePdf(c, { compress: false });
    const text = pdfText(pdf).replace(/\s+/g, ' ');
    for (const s of [sample.number, 'Acme Pharma', 'PO-78', 'Lot 42 white powder', 'TITR-01 version 1', 'Assay by titration', 'SOP-TITR', 'Assay', '99.2', 'at least 98', 'at most 2', '6.5 to 7.5',
      'BAL-1', due, 'analyst', 'reviewer', c.releasedOn, 'Certificate of analysis']) expect(text, s).toContain(s);
    expect(text).toMatch(/not an accreditation or compliance statement/);
    expect(text).not.toMatch(/17025|Part 11/);
    expect(pages(pdf)).toBe(1);
    expect(pages(await renderCertificatePdf(c))).toBe(1);
  });

  it('shows a confirmed out-of-specification result as FAIL, with its investigation, and leaves out superseded results', async () => {
    const { sample, test } = await sampleWithTest(l);
    await asActor(l.analyst, (tx) => enterResults(tx, l.analyst, test.id, [
      { analyteId: l.titrationAnalytes.Assay!, value: 96.1, instrumentId: l.balance }, { analyteId: l.titrationAnalytes.Moisture!, value: 1.1, instrumentId: l.balance }, { analyteId: l.titrationAnalytes.pH!, value: 7, instrumentId: l.balance }]));
    const inv = (await db().query('SELECT id, number FROM lab_investigation WHERE sample_id = $1', [sample.id])).rows[0];
    await asActor(l.analyst, (tx) => updateInvestigation(tx, l.analyst, inv.id, { cause: 'Assay is genuinely low' }));
    await asActor(l.reviewer, (tx) => closeInvestigation(tx, l.reviewer, inv.id, { decision: 'confirmed_oos', conclusion: 'Reported as found.' }));
    await asActor(l.reviewer, (tx) => reviewTest(tx, l.reviewer, test.id));
    await asActor(l.quality, (tx) => releaseSample(tx, l.quality, sample.id));
    const c = await asActor(l.reviewer, (tx) => certificateData(tx, l.reviewer, sample.id));
    expect(c.tests[0]!.results.find((r) => r.analyte === 'Assay')).toMatchObject({ value: 96.1, outcome: 'FAIL' });
    expect(c.investigations).toEqual([{ number: inv.number, analyte: 'Assay', decision: 'Confirmed out of specification', conclusion: 'Reported as found.', reason: null }]);
    expect(c.summary).toMatch(/1 result is outside the specification/);
    const text = pdfText(await renderCertificatePdf(c, { compress: false }));
    expect(text).toContain('FAIL');
    expect(text).toContain(`${inv.number} (Assay): Confirmed out of specification`);
  });

  it('runs onto a second page rather than cutting off a long list of results', async () => {
    const c = await (async () => {
      const { sample, test } = await sampleWithTest(l);
      await enterPassing(l, test.id);
      await asActor(l.reviewer, (tx) => reviewTest(tx, l.reviewer, test.id));
      await asActor(l.reviewer, (tx) => releaseSample(tx, l.reviewer, sample.id));
      return asActor(l.reviewer, (tx) => certificateData(tx, l.reviewer, sample.id));
    })();
    const many = { ...c, tests: Array.from({ length: 8 }, () => c.tests[0]!) };
    expect(pages(await renderCertificatePdf(many, { compress: false }))).toBeGreaterThan(1);
  });
});

async function token(userId: string) {
  const { generateToken, hashToken } = await import('../src/platform/auth/actor.js');
  const t = generateToken();
  await db().query('INSERT INTO api_token (tenant_id, user_id, token_hash, label) VALUES ($1, $2, $3, $4)', [l.w.tenantId, userId, hashToken(t), 'cert test']);
  return t;
}
