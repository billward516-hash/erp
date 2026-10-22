import PDFDocument from 'pdfkit';
import { TOKENS } from '../reporting/render/format.js';
import { pdfText } from '../reporting/render/pdf.js';

const usd = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
const qty = (n: number) => Number(n).toLocaleString('en-US', { maximumFractionDigits: 3 });

/** Customer-facing quotation. Shows prices only (never cost or margin). Drafts are watermarked as previews. */
export function renderQuotePdf(q: any): Promise<Buffer> {
  const doc = new PDFDocument({ size: 'LETTER', margin: 48, info: { Title: `Quotation ${q.number} rev ${q.revision}` } });
  const chunks: Buffer[] = [];
  doc.on('data', (b: Buffer) => chunks.push(b));
  const done = new Promise<Buffer>((r) => doc.on('end', () => r(Buffer.concat(chunks))));
  const m = 48, W = doc.page.width - 2 * m;
  const t = (s: unknown) => pdfText(String(s ?? ''));
  const draft = q.preview || !['approved', 'sent', 'accepted'].includes(q.status);
  if (draft) {
    doc.save().rotate(-30, { origin: [doc.page.width / 2, doc.page.height / 2] }).fillColor(TOKENS.rule).font(TOKENS.fontBold).fontSize(64)
      .text('DRAFT PREVIEW', 0, doc.page.height / 2 - 40, { width: doc.page.width, align: 'center' }).restore();
  }
  doc.fillColor(TOKENS.accent).font(TOKENS.fontBold).fontSize(9).text('QUOTATION', m, m, { characterSpacing: 1.2 });
  doc.fillColor(TOKENS.ink).font(TOKENS.fontBold).fontSize(22).text(`${q.number}`, m, m + 14);
  doc.fillColor(TOKENS.muted).font(TOKENS.font).fontSize(9).text(`Revision ${q.revision} · ${t(q.title)}`, m, m + 42);
  doc.text(`From ${t(q.facility_name)} · prepared by ${t(q.created_by_name)}`, m, m + 54);
  const top = m + 80, half = W / 2 - 10;
  doc.fillColor(TOKENS.muted).font(TOKENS.fontBold).fontSize(8).text('FOR', m, top, { characterSpacing: 0.8 });
  doc.fillColor(TOKENS.ink).font(TOKENS.font).fontSize(10).text([q.customer_name, q.contact_name ? `Attn: ${q.contact_name}` : '', q.billing_address ?? ''].filter(Boolean).map(t).join('\n'), m, top + 12, { width: half });
  doc.fillColor(TOKENS.muted).font(TOKENS.fontBold).fontSize(8).text('TERMS', m + half + 20, top, { characterSpacing: 0.8 });
  doc.fillColor(TOKENS.ink).font(TOKENS.font).fontSize(10).text([`Valid until ${q.valid_until ?? '—'}`, `Payment: ${q.payment_terms ?? 'to be agreed'}`, 'Prices in USD, excluding applicable taxes and freight unless listed.'].map(t).join('\n'),
    m + half + 20, top + 12, { width: half });
  let y = top + 90;
  const cols = [{ k: '#', w: 0.4, a: 'left' }, { k: 'Description', w: 4.2, a: 'left' }, { k: 'Qty', w: 0.8, a: 'right' }, { k: 'UOM', w: 0.6, a: 'left' },
    { k: 'Unit price', w: 1.1, a: 'right' }, { k: 'Amount', w: 1.2, a: 'right' }] as const;
  const totalW = cols.reduce((s, c) => s + c.w, 0);
  const xs: number[] = []; let x = m;
  for (const c of cols) { xs.push(x); x += (c.w / totalW) * W; }
  const width = (i: number) => (cols[i]!.w / totalW) * W - 6;
  doc.font(TOKENS.fontBold).fontSize(8.5).fillColor(TOKENS.muted);
  cols.forEach((c, i) => doc.text(c.k, xs[i]!, y, { width: width(i), align: c.a }));
  y += 14;
  doc.moveTo(m, y).lineTo(m + W, y).lineWidth(0.8).strokeColor(TOKENS.ink).stroke();
  y += 5;
  doc.font(TOKENS.font).fontSize(9).fillColor(TOKENS.ink);
  for (const l of q.lines) {
    const cells = [String(l.line_no), l.description, qty(l.qty), l.uom ?? 'EA', usd(l.unit_price), usd(l.amount)];
    const h = Math.max(...cells.map((c, i) => doc.heightOfString(t(c), { width: width(i) })));
    if (y + h > doc.page.height - 120) { doc.addPage(); y = m; }
    cells.forEach((c, i) => doc.text(t(c), xs[i]!, y, { width: width(i), align: cols[i]!.a }));
    y += h + 6;
    doc.moveTo(m, y - 3).lineTo(m + W, y - 3).lineWidth(0.4).strokeColor(TOKENS.rule).stroke();
  }
  doc.font(TOKENS.fontBold).fontSize(12).text(`Total ${usd(q.total)}`, m, y + 6, { width: W, align: 'right' });
  if (q.notes) doc.font(TOKENS.font).fontSize(9).fillColor(TOKENS.ink).text(t(q.notes), m, y + 34, { width: W });
  doc.font(TOKENS.font).fontSize(8).fillColor(TOKENS.muted)
    .text('To accept, reply with your purchase order number referencing this quotation and revision.', m, doc.page.height - 70, { width: W });
  doc.end();
  return done;
}
