import PDFDocument from 'pdfkit';
import { TOKENS } from '../reporting/render/format.js';
import { pdfText } from '../reporting/render/pdf.js';

const usd = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
const qty = (n: number) => Number(n).toLocaleString('en-US', { maximumFractionDigits: 3 });

/** Customer invoice, or credit memo (`kind: 'credit_memo'`, D-146), as issued (stored with its hash). Drafts are watermarked as previews. */
export function renderInvoicePdf(q: any): Promise<Buffer> {
  const credit = q.kind === 'credit_memo';
  const doc = new PDFDocument({ size: 'LETTER', margin: 48, info: { Title: `${credit ? 'Credit memo' : 'Invoice'} ${q.number ?? 'draft'}` } });
  const chunks: Buffer[] = [];
  doc.on('data', (b: Buffer) => chunks.push(b));
  const done = new Promise<Buffer>((r) => doc.on('end', () => r(Buffer.concat(chunks))));
  const m = 48, W = doc.page.width - 2 * m;
  const t = (s: unknown) => pdfText(String(s ?? ''));
  const draft = q.preview || q.status === 'draft';
  if (draft) {
    doc.save().rotate(-30, { origin: [doc.page.width / 2, doc.page.height / 2] }).fillColor(TOKENS.rule).font(TOKENS.fontBold).fontSize(64)
      .text('DRAFT PREVIEW', 0, doc.page.height / 2 - 40, { width: doc.page.width, align: 'center' }).restore();
  }
  doc.fillColor(TOKENS.accent).font(TOKENS.fontBold).fontSize(9).text(credit ? 'CREDIT MEMO' : 'INVOICE', m, m, { characterSpacing: 1.2 });
  doc.fillColor(TOKENS.ink).font(TOKENS.fontBold).fontSize(22).text(`${q.number ?? 'DRAFT'}`, m, m + 14);
  doc.fillColor(TOKENS.muted).font(TOKENS.font).fontSize(9).text(credit ? `Date ${q.invoice_date ?? '—'}${q.invoice_number ? ` · for invoice ${q.invoice_number}` : ''}`
    : `Invoice date ${q.invoice_date ?? '—'}${q.order_number ? ` · order ${q.order_number}` : ''}${q.customer_po ? ` · your PO ${t(q.customer_po)}` : ''}`, m, m + 42);
  doc.text(`From ${t(q.facility_name)}`, m, m + 54);
  const top = m + 80, half = W / 2 - 10;
  doc.fillColor(TOKENS.muted).font(TOKENS.fontBold).fontSize(8).text('BILL TO', m, top, { characterSpacing: 0.8 });
  doc.fillColor(TOKENS.ink).font(TOKENS.font).fontSize(10).text([q.customer_name, q.contact_name ? `Attn: ${q.contact_name}` : '', q.billing_address ?? ''].filter(Boolean).map(t).join('\n'), m, top + 12, { width: half });
  doc.fillColor(TOKENS.muted).font(TOKENS.fontBold).fontSize(8).text(credit ? 'REASON' : 'TERMS', m + half + 20, top, { characterSpacing: 0.8 });
  doc.fillColor(TOKENS.ink).font(TOKENS.font).fontSize(10).text((credit ? [q.reason ?? '', 'Amounts in USD.'] : [`Due ${q.due_date ?? 'on issue'}`, `Terms: ${q.payment_terms ?? 'Net 30'}`, 'Amounts in USD.']).map(t).join('\n'),
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
  doc.font(TOKENS.font).fontSize(9).fillColor(TOKENS.muted).text(`Subtotal ${usd(q.subtotal)}${q.freight ? `   Freight ${usd(q.freight)}` : ''}${q.tax ? `   Sales tax ${usd(q.tax)}` : ''}`, m, y + 4, { width: W, align: 'right' });
  doc.font(TOKENS.fontBold).fontSize(12).fillColor(TOKENS.ink).text(credit ? `Credit ${usd(q.total)}` : `Amount due ${usd(q.balance ?? q.total)}`, m, y + 20, { width: W, align: 'right' });
  if (q.notes) doc.font(TOKENS.font).fontSize(9).fillColor(TOKENS.ink).text(t(q.notes), m, y + 46, { width: W });
  doc.font(TOKENS.font).fontSize(8).fillColor(TOKENS.muted)
    .text(credit ? 'This credit is applied to your open invoices or refunded, as agreed. Questions about this credit memo: reply to the sender.'
      : 'Please reference the invoice number with your payment. Questions about this invoice: reply to the sender.', m, doc.page.height - 70, { width: W });
  doc.end();
  return done;
}
