import PDFDocument from 'pdfkit';
import { TOKENS } from '../reporting/render/format.js';

export interface CertificateView {
  number: string; issued_at: Date; issued_by: string; authorized_by: string; effective_on: string; expires_on: string | null; revoked_at: Date | null;
  employee: string; employee_number: string; code: string; qualification: string; company: string; facility: string | null;
}

/** Printable internal certificate. Shows its validity state; never implies external accreditation. */
export function certificateToPdf(c: CertificateView): Promise<Buffer> {
  const doc = new PDFDocument({ size: 'LETTER', layout: 'landscape', margin: 56, info: { Title: `Certificate ${c.number}`, Subject: c.qualification } });
  const chunks: Buffer[] = [];
  doc.on('data', (b: Buffer) => chunks.push(b));
  const done = new Promise<Buffer>((r) => doc.on('end', () => r(Buffer.concat(chunks))));
  const W = doc.page.width, H = doc.page.height, m = 56, inner = W - 2 * m;
  const today = new Date().toISOString().slice(0, 10);
  const state = c.revoked_at ? 'REVOKED' : c.expires_on && c.expires_on < today ? 'EXPIRED' : null;

  doc.rect(28, 28, W - 56, H - 56).lineWidth(1.5).strokeColor(TOKENS.accent).stroke();
  doc.rect(34, 34, W - 68, H - 68).lineWidth(0.5).strokeColor(TOKENS.rule).stroke();
  doc.fillColor(TOKENS.accent).font(TOKENS.fontBold).fontSize(10).text(c.company.toUpperCase(), m, 80, { width: inner, align: 'center', characterSpacing: 1.5 });
  doc.fillColor(TOKENS.ink).font('Times-Bold').fontSize(30).text('Certificate of Qualification', m, 110, { width: inner, align: 'center' });
  doc.fillColor(TOKENS.muted).font(TOKENS.font).fontSize(11).text('This certifies that', m, 170, { width: inner, align: 'center' });
  doc.fillColor(TOKENS.ink).font('Times-Bold').fontSize(26).text(c.employee, m, 192, { width: inner, align: 'center' });
  doc.fillColor(TOKENS.muted).font(TOKENS.font).fontSize(10).text(`Employee ${c.employee_number}${c.facility ? ` · ${c.facility}` : ''}`, m, 226, { width: inner, align: 'center' });
  doc.fillColor(TOKENS.muted).fontSize(11).text('has met the training and evaluation requirements for, and is authorized in,', m, 260, { width: inner, align: 'center' });
  doc.fillColor(TOKENS.ink).font(TOKENS.fontBold).fontSize(18).text(c.qualification, m, 282, { width: inner, align: 'center' });
  doc.fillColor(TOKENS.muted).font(TOKENS.font).fontSize(10).text(`Qualification ${c.code}`, m, 308, { width: inner, align: 'center' });

  const cols = [
    ['Effective', c.effective_on],
    ['Valid through', c.expires_on ?? 'No expiry'],
    ['Certificate no.', c.number],
    ['Authorized by', c.authorized_by],
  ];
  const cw = inner / cols.length;
  cols.forEach(([l, v], i) => {
    const x = m + i * cw;
    doc.moveTo(x + 18, 382).lineTo(x + cw - 18, 382).lineWidth(0.6).strokeColor(TOKENS.rule).stroke();
    doc.fillColor(TOKENS.ink).font(TOKENS.fontBold).fontSize(11).text(v!, x, 362, { width: cw, align: 'center' });
    doc.fillColor(TOKENS.muted).font(TOKENS.font).fontSize(8.5).text(l!, x, 388, { width: cw, align: 'center' });
  });
  doc.fillColor(TOKENS.muted).fontSize(7.5).text(
    `Issued ${c.issued_at.toISOString().slice(0, 10)} by ${c.issued_by}. Internal qualification record of ${c.company}; it is not an accreditation by any external body. ` +
    'Validity is shown as of printing; confirm current status in the platform before relying on it.',
    m + 40, H - 92, { width: inner - 80, align: 'center' });
  if (state) {
    doc.save().rotate(-18, { origin: [W / 2, H / 2] }).fillColor(TOKENS.bad).fillOpacity(0.18).font(TOKENS.fontBold).fontSize(110)
      .text(state, 0, H / 2 - 60, { width: W, align: 'center' }).restore();
  }
  doc.end();
  return done;
}
