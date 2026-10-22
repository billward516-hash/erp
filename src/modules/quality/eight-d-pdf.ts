import PDFDocument from 'pdfkit';
import { TOKENS } from '../reporting/render/format.js';
import { pdfText } from '../reporting/render/pdf.js';
import { IS_IS_NOT, IS_IS_NOT_LABEL } from './eight-d.js';

const STEP: Record<string, string> = { open: 'D1–D3', root_cause: 'D4 root causes', actions: 'D5–D7 actions', verification: 'D6 effectiveness check', closed: 'closed', cancelled: 'cancelled' };
const day = (v: unknown) => (v == null ? '' : String(v instanceof Date ? v.toISOString() : v).slice(0, 10));

/**
 * The 8D report, D0 to D8, for the customer or supplier who asked for it (the platform does not send it). Built from the
 * same record the page shows; a discipline not yet complete says what is missing rather than leaving a blank.
 */
export function renderEightDPdf(c: any): Promise<Buffer> {
  const doc = new PDFDocument({ size: 'LETTER', margin: 48, info: { Title: `8D report ${c.number}` } });
  const chunks: Buffer[] = [];
  doc.on('data', (b: Buffer) => chunks.push(b));
  const finished = new Promise<Buffer>((r) => doc.on('end', () => r(Buffer.concat(chunks))));
  const m = 48, W = doc.page.width - 2 * m;
  const t = (s: unknown) => pdfText(String(s ?? ''));
  const ds: Record<string, { done: boolean; missing: string[] }> = Object.fromEntries((c.disciplines ?? []).map((d: any) => [d.key, d]));

  doc.fillColor(TOKENS.accent).font(TOKENS.fontBold).fontSize(9).text('8D PROBLEM-SOLVING REPORT', m, m, { characterSpacing: 1.2 });
  doc.fillColor(TOKENS.ink).font(TOKENS.fontBold).fontSize(20).text(t(`${c.number}  ${c.title}`), m, m + 14, { width: W });
  doc.fillColor(TOKENS.muted).font(TOKENS.font).fontSize(9)
    .text(t(`Facility ${c.facility_code} · opened ${day(c.created_at)} · step: ${STEP[c.status] ?? c.status}${c.closed_at ? ` · closed ${day(c.closed_at)}` : ''} · printed ${day(new Date())}`), { width: W });
  doc.moveDown(0.6);

  const heading = (key: string, title: string) => {
    if (doc.y > doc.page.height - 140) doc.addPage();
    doc.moveDown(0.5);
    const y = doc.y;
    doc.moveTo(m, y).lineTo(m + W, y).lineWidth(0.6).strokeColor(TOKENS.rule).stroke();
    doc.moveDown(0.3);
    const d = ds[key];
    doc.fillColor(TOKENS.ink).font(TOKENS.fontBold).fontSize(11).text(`${key}  ${title}`, m, doc.y, { continued: !!d });
    if (d) doc.fillColor(d.done ? TOKENS.good : TOKENS.bad).font(TOKENS.font).fontSize(9).text(d.done ? '   complete' : '   incomplete');
    doc.moveDown(0.2);
  };
  const para = (label: string | null, value: unknown) => {
    doc.fillColor(TOKENS.muted).font(TOKENS.fontBold).fontSize(8);
    if (label) doc.text(label.toUpperCase(), m, doc.y, { characterSpacing: 0.6 });
    doc.fillColor(TOKENS.ink).font(TOKENS.font).fontSize(9.5).text(value == null || String(value).trim() === '' ? '—' : t(value), m, doc.y, { width: W });
    doc.moveDown(0.3);
  };
  const missing = (key: string) => {
    const d = ds[key];
    if (d && !d.done) doc.fillColor(TOKENS.bad).font(TOKENS.font).fontSize(8.5).text(t(`Missing: ${d.missing.join('; ')}`), m, doc.y, { width: W }).moveDown(0.3);
  };
  const actionsOf = (kind: string) => (c.actions ?? []).filter((a: any) => a.discipline === kind && a.status !== 'cancelled');
  const actionLines = (rows: any[], dashWhenNone = true) => {
    if (!rows.length) { if (dashWhenNone) para(null, null); return; }
    for (const a of rows) para(null, `• ${a.title}: ${a.owner_name}, due ${day(a.due_date)}, ${a.status === 'done' ? `done ${day(a.completed_at)}: ${a.completion_note}` : 'open'}`);
  };

  heading('D0', 'Source');
  para('Raised from', `${String(c.source).replace(/_/g, ' ')}${c.supplier_name ? ` (supplier ${c.supplier_name})` : ''}`);
  if (c.ncrs?.length) para('Nonconformances', c.ncrs.map((n: any) => `${n.number} ${n.title} (${n.severity}${n.qty ? `, qty ${n.qty}` : ''})`).join('; '));

  heading('D1', 'Team');
  para('Leader', c.owner_name);
  para('Champion', c.champion_name);
  para('Members', (c.team ?? []).map((m: any) => `${m.display_name}${m.expertise ? ` (${m.expertise})` : ''}`).join('; ') || null);
  missing('D1');

  heading('D2', 'Problem description');
  para('Problem statement', c.problem);
  const iin = c.is_is_not ?? {};
  const half = W / 2 - 8;
  doc.fillColor(TOKENS.muted).font(TOKENS.fontBold).fontSize(8);
  let y = doc.y;
  doc.text('IS', m + 120, y, { width: half - 60 }); doc.text('IS NOT', m + 120 + half - 50, y, { width: half - 60 });
  doc.moveDown(0.2);
  for (const k of IS_IS_NOT) {
    y = doc.y;
    doc.fillColor(TOKENS.muted).font(TOKENS.fontBold).fontSize(8.5).text(IS_IS_NOT_LABEL[k].split(' (')[0]!, m, y, { width: 110 });
    doc.fillColor(TOKENS.ink).font(TOKENS.font).fontSize(9);
    const a = t(iin[k]?.is || '—'), b = t(iin[k]?.isNot || '—');
    const h = Math.max(doc.heightOfString(a, { width: half - 60 }), doc.heightOfString(b, { width: half - 60 }), 11);
    doc.text(a, m + 120, y, { width: half - 60 }); doc.text(b, m + 120 + half - 50, y, { width: half - 60 });
    doc.y = y + h + 4; doc.x = m;
  }
  missing('D2');

  heading('D3', 'Interim containment');
  para('Containment', c.containment);
  para('How we know it works', c.containment_verification);
  actionLines(actionsOf('containment'), false);
  missing('D3');

  heading('D4', 'Root causes');
  para(`Why it happened (occurrence)${c.root_cause_method ? `, by ${String(c.root_cause_method).replace(/_/g, ' ')}` : ''}`, c.root_cause);
  para('Where it should have been caught (escape point)', c.escape_point);
  para('Why it was not caught (escape)', c.escape_root_cause);
  para('How the causes were confirmed', c.root_cause_verification);
  missing('D4');

  heading('D5', 'Permanent corrective actions');
  actionLines(actionsOf('corrective'));
  missing('D5');

  heading('D6', 'Implemented and validated');
  para('Effectiveness check', c.effectiveness_note ? `${c.effective ? 'Effective' : 'Not effective'}: ${c.effectiveness_note}${c.verified_by_name ? ` (${c.verified_by_name}, ${day(c.verified_at)})` : ''}` : null);
  missing('D6');

  heading('D7', 'Prevent recurrence');
  para('Systemic changes', c.prevention_note);
  actionLines(actionsOf('preventive'));
  if (c.readAcross?.length) para('Read-across', c.readAcross.map((r: any) => `${r.scope}: ${r.applies == null ? 'not decided' : r.applies ? 'applies' : 'does not apply'}${r.note ? `, ${r.note}` : ''}`).join('\n'));
  missing('D7');

  heading('D8', 'Team recognized');
  para(null, c.recognition_note ? `${c.recognition_note} (${day(c.recognized_at)})` : null);
  missing('D8');

  const other = (c.actions ?? []).filter((a: any) => !a.discipline && a.status !== 'cancelled');
  if (other.length) { heading('', 'Other actions'); actionLines(other); }
  doc.end();
  return finished;
}
