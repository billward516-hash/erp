import PDFDocument from 'pdfkit';
import type { Actor } from '../../platform/auth/actor.js';
import { requirePermission } from '../../platform/auth/actor.js';
import type { Tx } from '../../platform/db/tx.js';
import { many, one } from '../../platform/db/tx.js';
import { conflict, notFound } from '../../platform/errors.js';
import { TOKENS } from '../reporting/render/format.js';
import { pdfText } from '../reporting/render/pdf.js';
import { limitText } from './spec.js';

const day = (v: unknown) => (v == null ? '' : String(v instanceof Date ? v.toISOString() : v).slice(0, 10));

/** The site address as one line (the same fields the quote PDF reads). */
function addressOf(a: any): string | null {
  if (!a || typeof a !== 'object') return null;
  const line = [a.line1 ?? a.street, [a.city, a.state, a.postal_code ?? a.zip].filter(Boolean).join(', ')].filter(Boolean).join(' · ');
  return line || null;
}

export interface CertificateData {
  number: string; company: string; facility: string; facilityAddress: string | null; customer: string | null; customerReference: string | null; source: string;
  description: string; container: string | null; quantity: string | null; receivedOn: string; releasedOn: string; releasedBy: string; retentionUntil: string | null;
  tests: { method: string; version: number; name: string; document: string | null; analyst: string; reviewer: string; reviewedOn: string;
    results: { analyte: string; value: number; unit: string; limits: string; outcome: string; instrument: string | null; calDue: string | null }[] }[];
  investigations: { number: string; analyte: string; decision: string; conclusion: string; reason: string | null }[];
  summary: string;
}

/** The content of a certificate of analysis, built only from a released sample's stored, reviewed results. */
export async function certificateData(tx: Tx, actor: Actor, sampleId: string): Promise<CertificateData> {
  const s = await one(tx, `SELECT s.*, f.name AS facility_name, f.address AS facility_address, c.name AS customer_name, ru.display_name AS released_by_name, (SELECT name FROM tenant LIMIT 1) AS company
    FROM lab_sample s JOIN facility f ON f.id = s.facility_id LEFT JOIN customer c ON c.id = s.customer_id LEFT JOIN app_user ru ON ru.id = s.released_by WHERE s.id = $1`, [sampleId]);
  if (!s) throw notFound('sample');
  requirePermission(actor, 'lab.view', s.facility_id);
  if (s.status !== 'released') throw conflict(`${s.number} has not been released; a certificate of analysis is issued for a released sample`);
  const tests = await many(tx, `SELECT t.id, m.code, m.version, m.name, d.doc_number, dv.version_label, ru.display_name AS reviewer, t.reviewed_at,
      (SELECT string_agg(DISTINCT u.display_name, ', ') FROM lab_result r JOIN app_user u ON u.id = r.entered_by WHERE r.test_id = t.id AND r.superseded_at IS NULL) AS analyst
    FROM lab_test t JOIN lab_method m ON m.id = t.method_id LEFT JOIN document d ON d.id = m.document_id LEFT JOIN document_version dv ON dv.id = m.document_version_id
    LEFT JOIN app_user ru ON ru.id = t.reviewed_by WHERE t.sample_id = $1 AND t.status = 'reviewed' ORDER BY t.created_at`, [sampleId]);
  const results = await many(tx, `SELECT r.test_id, r.analyte_name, r.value::float AS value, r.unit, r.spec_low, r.spec_high, r.outcome, r.instrument_tag, r.instrument_cal_due
    FROM lab_result r JOIN lab_method_analyte a ON a.id = r.analyte_id JOIN lab_test t ON t.id = r.test_id WHERE t.sample_id = $1 AND r.superseded_at IS NULL ORDER BY a.seq`, [sampleId]);
  const inv = await many(tx, `SELECT i.number, r.analyte_name, i.decision, i.conclusion, i.invalid_reason FROM lab_investigation i JOIN lab_result r ON r.id = i.result_id
    WHERE i.sample_id = $1 AND i.status = 'closed' ORDER BY i.number`, [sampleId]);
  const failing = results.filter((r) => r.outcome === 'fail').length;
  return {
    number: s.number, company: s.company, facility: s.facility_name, facilityAddress: addressOf(s.facility_address), customer: s.customer_name ?? null, customerReference: s.customer_reference ?? null,
    source: s.source, description: s.description, container: s.container ?? null, quantity: s.quantity != null ? `${Number(s.quantity)}${s.quantity_unit ? ` ${s.quantity_unit}` : ''}` : null,
    receivedOn: day(s.received_on), releasedOn: day(s.released_at), releasedBy: s.released_by_name ?? '', retentionUntil: s.retention_until ? day(s.retention_until) : null,
    tests: tests.map((t) => ({
      method: t.code, version: t.version, name: t.name, document: t.doc_number ? `${t.doc_number}${t.version_label ? ` rev ${t.version_label}` : ''}` : null, analyst: t.analyst ?? '', reviewer: t.reviewer ?? '', reviewedOn: day(t.reviewed_at),
      results: results.filter((r) => r.test_id === t.id).map((r) => ({ analyte: r.analyte_name, value: r.value, unit: r.unit, limits: limitText(r.spec_low, r.spec_high), outcome: r.outcome === 'pass' ? 'Pass' : r.outcome === 'fail' ? 'FAIL' : 'Reported',
        instrument: r.instrument_tag ?? null, calDue: r.instrument_cal_due ? day(r.instrument_cal_due) : null })),
    })),
    investigations: inv.map((i) => ({ number: i.number, analyte: i.analyte_name, decision: i.decision === 'confirmed_oos' ? 'Confirmed out of specification' : 'Result invalidated', conclusion: i.conclusion, reason: i.invalid_reason ?? null })),
    summary: failing ? `${failing} result${failing === 1 ? ' is' : 's are'} outside the specification (investigated; see below).` : 'Every result with limits is within its specification.',
  };
}

/**
 * Certificate of analysis: one page where it fits, more when the results need them. It states what the platform's records
 * show; it is not an accredited report and the lab's own procedures decide how it is used. `compress: false` is for tests.
 */
export function renderCertificatePdf(c: CertificateData, opts: { compress?: boolean } = {}): Promise<Buffer> {
  const doc = new PDFDocument({ size: 'LETTER', margin: 48, compress: opts.compress ?? true, info: { Title: `Certificate of analysis ${c.number}`, Subject: c.description } });
  const chunks: Buffer[] = [];
  doc.on('data', (b: Buffer) => chunks.push(b));
  const done = new Promise<Buffer>((r) => doc.on('end', () => r(Buffer.concat(chunks))));
  const m = 48, W = doc.page.width - 2 * m;
  const t = (s: unknown) => pdfText(String(s ?? ''));
  const room = (h: number) => { if (doc.y + h > doc.page.height - 64) doc.addPage(); };

  doc.fillColor(TOKENS.accent).font(TOKENS.fontBold).fontSize(9).text(t(c.company).toUpperCase(), m, m, { characterSpacing: 1.2 });
  doc.fillColor(TOKENS.ink).font(TOKENS.fontBold).fontSize(20).text('Certificate of analysis', m, m + 14, { width: W });
  doc.fillColor(TOKENS.muted).font(TOKENS.font).fontSize(9).text(t(`${c.facility}${c.facilityAddress ? ` · ${c.facilityAddress}` : ''}`), { width: W });
  doc.moveDown(0.6);

  const pair = (label: string, value: string | null, x: number, y: number, w: number) => {
    doc.fillColor(TOKENS.muted).font(TOKENS.fontBold).fontSize(7.5).text(label.toUpperCase(), x, y, { width: w, characterSpacing: 0.5 });
    doc.fillColor(TOKENS.ink).font(TOKENS.font).fontSize(9.5).text(t(value || '—'), x, y + 10, { width: w });
  };
  const col = W / 3;
  let y = doc.y;
  pair('Certificate for sample', c.number, m, y, col - 8);
  pair('Customer', c.customer ?? (c.source === 'internal' ? 'Internal sample' : 'Not recorded'), m + col, y, col - 8);
  pair('Customer reference', c.customerReference, m + 2 * col, y, col - 8);
  y += 34;
  pair('Sample', c.description, m, y, col * 2 - 8);
  pair('Container and quantity', [c.container, c.quantity].filter(Boolean).join(' · ') || null, m + 2 * col, y, col - 8);
  y += 34;
  pair('Received', c.receivedOn, m, y, col - 8);
  pair('Released', `${c.releasedOn}${c.releasedBy ? ` by ${c.releasedBy}` : ''}`, m + col, y, col - 8);
  pair('Retained until', c.retentionUntil, m + 2 * col, y, col - 8);
  doc.y = y + 36;

  doc.fillColor(TOKENS.ink).font(TOKENS.fontBold).fontSize(10).text(t(c.summary), m, doc.y, { width: W });
  doc.moveDown(0.5);

  const cols = [{ k: 'analyte', l: 'Analyte', w: 1.3 }, { k: 'value', l: 'Result', w: 0.8 }, { k: 'unit', l: 'Unit', w: 0.6 }, { k: 'limits', l: 'Specification', w: 1.1 }, { k: 'outcome', l: 'Outcome', w: 0.7 },
    { k: 'instrument', l: 'Instrument', w: 0.9 }, { k: 'calDue', l: 'Calibration due', w: 1.4 }];
  const total = cols.reduce((s, x) => s + x.w, 0);
  const xs: number[] = []; let acc = m;
  for (const x of cols) { xs.push(acc); acc += (x.w / total) * W; }
  const cw = (i: number) => (cols[i]!.w / total) * W - 6;
  const headerRow = () => {
    const yy = doc.y;
    doc.fillColor(TOKENS.muted).font(TOKENS.fontBold).fontSize(7);
    cols.forEach((x, i) => doc.text(x.l.toUpperCase(), xs[i]!, yy, { width: cw(i), characterSpacing: 0.2 }));
    doc.y = yy + 12;
    doc.moveTo(m, doc.y).lineTo(m + W, doc.y).lineWidth(0.6).strokeColor(TOKENS.rule).stroke();
    doc.y += 4;
  };
  for (const test of c.tests) {
    room(80);
    doc.fillColor(TOKENS.ink).font(TOKENS.fontBold).fontSize(10).text(t(`${test.method} version ${test.version}: ${test.name}`), m, doc.y, { width: W });
    doc.fillColor(TOKENS.muted).font(TOKENS.font).fontSize(8.5).text(t(`${test.document ? `Method document ${test.document} · ` : ''}Analyst ${test.analyst || '—'} · Reviewed by ${test.reviewer || '—'} on ${test.reviewedOn}`), { width: W });
    doc.moveDown(0.3);
    headerRow();
    for (const r of test.results) {
      room(18);
      const yy = doc.y;
      const cells = [r.analyte, String(r.value), r.unit, r.limits, r.outcome, r.instrument ?? '—', r.calDue ?? '—'];
      doc.fillColor(r.outcome === 'FAIL' ? TOKENS.bad : TOKENS.ink).font(TOKENS.font).fontSize(9);
      let h = 11;
      cells.forEach((v, i) => {
        if (i === 4) doc.font(TOKENS.fontBold);
        doc.text(t(v), xs[i]!, yy, { width: cw(i) });
        h = Math.max(h, doc.y - yy);
        doc.font(TOKENS.font);
        doc.y = yy;
      });
      doc.y = yy + h + 3;
    }
    doc.moveDown(0.5);
  }
  if (c.investigations.length) {
    room(60);
    doc.fillColor(TOKENS.ink).font(TOKENS.fontBold).fontSize(10).text('Out-of-specification investigations', m, doc.y, { width: W });
    for (const i of c.investigations) {
      room(30);
      doc.fillColor(TOKENS.ink).font(TOKENS.font).fontSize(9).text(t(`${i.number} (${i.analyte}): ${i.decision}. ${i.conclusion}${i.reason ? ` Reason: ${i.reason}` : ''}`), { width: W });
    }
    doc.moveDown(0.5);
  }
  room(50);
  doc.fillColor(TOKENS.muted).font(TOKENS.font).fontSize(7.5).text(
    t(`Issued from the records of ${c.company}. Results apply to the sample as received. Pass or fail is computed against the specification limits of the method version shown at the time the result was entered. `
      + 'This certificate is a record to support the laboratory’s own quality system; it is not an accreditation or compliance statement by any external body.'), m, doc.y, { width: W });
  doc.end();
  return done;
}
