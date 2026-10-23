import PDFDocument from 'pdfkit';
import { TOKENS } from '../reporting/render/format.js';
import { pdfText } from '../reporting/render/pdf.js';

const usd = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
const qty = (n: number) => Number(n).toLocaleString('en-US', { maximumFractionDigits: 3 });

/** Printable purchase order for the buyer to send to the supplier (the platform does not transmit orders). */
export function renderPurchaseOrderPdf(o: any): Promise<Buffer> {
  const doc = new PDFDocument({ size: 'LETTER', margin: 48, info: { Title: `Purchase order ${o.number}` } });
  const chunks: Buffer[] = [];
  doc.on('data', (b: Buffer) => chunks.push(b));
  const done = new Promise<Buffer>((r) => doc.on('end', () => r(Buffer.concat(chunks))));
  const m = 48, W = doc.page.width - 2 * m;
  const t = (s: unknown) => pdfText(String(s ?? ''));

  doc.fillColor(TOKENS.accent).font(TOKENS.fontBold).fontSize(9).text('PURCHASE ORDER', m, m, { characterSpacing: 1.2 });
  doc.fillColor(TOKENS.ink).font(TOKENS.fontBold).fontSize(22).text(o.number, m, m + 14);
  if (o.status === 'cancelled') doc.fillColor(TOKENS.bad).fontSize(12).text('CANCELLED', m, m + 20, { width: W, align: 'right' });
  doc.fillColor(TOKENS.muted).font(TOKENS.font).fontSize(9)
    .text(`Issued ${String(o.created_at instanceof Date ? o.created_at.toISOString() : o.created_at).slice(0, 10)} by ${t(o.created_by_name)}`, m, m + 44);

  const top = m + 70, half = W / 2 - 10;
  const block = (x: number, title: string, lines: string[]) => {
    doc.fillColor(TOKENS.muted).font(TOKENS.fontBold).fontSize(8).text(title.toUpperCase(), x, top, { characterSpacing: 0.8 });
    doc.fillColor(TOKENS.ink).font(TOKENS.font).fontSize(10).text(lines.filter(Boolean).map(t).join('\n'), x, top + 12, { width: half });
  };
  block(m, 'Supplier', [`${o.supplier_name} (${o.supplier_code})`, o.contact_name, o.supplier_email, o.supplier_phone]);
  block(m + half + 20, 'Ship to', [o.facility_name, `Facility ${o.facility_code}`, o.expected_on ? `Requested delivery ${o.expected_on}` : '', o.payment_terms ? `Terms: ${o.payment_terms}` : '']);

  let y = top + 84;
  const cols = [
    { k: '#', w: 0.4, a: 'left' }, { k: 'Item', w: 1.4, a: 'left' }, { k: 'Description', w: 3, a: 'left' },
    { k: 'Qty', w: 0.8, a: 'right' }, { k: 'UOM', w: 0.5, a: 'left' }, { k: 'Unit price', w: 1, a: 'right' }, { k: 'Amount', w: 1.1, a: 'right' },
  ] as const;
  const total = cols.reduce((s, c) => s + c.w, 0);
  const xs: number[] = []; let x = m;
  for (const c of cols) { xs.push(x); x += (c.w / total) * W; }
  const width = (i: number) => (cols[i]!.w / total) * W - 6;
  doc.font(TOKENS.fontBold).fontSize(8.5).fillColor(TOKENS.muted);
  cols.forEach((c, i) => doc.text(c.k, xs[i]!, y, { width: width(i), align: c.a }));
  y += 14;
  doc.moveTo(m, y).lineTo(m + W, y).lineWidth(0.8).strokeColor(TOKENS.ink).stroke();
  y += 5;
  doc.font(TOKENS.font).fontSize(9).fillColor(TOKENS.ink);
  for (const l of o.lines) {
    const cells = [String(l.line_no), l.supplier_part_number ?? l.part_number ?? '', l.description, qty(l.qty_ordered), l.uom ?? '', usd(Number(l.unit_price)), usd(l.line_total)];
    const h = Math.max(...cells.map((c, i) => doc.heightOfString(t(c), { width: width(i) })));
    if (y + h > doc.page.height - 120) { doc.addPage(); y = m; }
    cells.forEach((c, i) => doc.text(t(c), xs[i]!, y, { width: width(i), align: cols[i]!.a }));
    y += h + 6;
    doc.moveTo(m, y - 3).lineTo(m + W, y - 3).lineWidth(0.4).strokeColor(TOKENS.rule).stroke();
  }
  doc.font(TOKENS.fontBold).fontSize(11).text(`Total ${usd(o.total)} ${o.currency && o.currency !== 'USD' ? o.currency : ''}`.trim(), m, y + 6, { width: W, align: 'right' });
  if (o.notes) doc.font(TOKENS.font).fontSize(9).fillColor(TOKENS.muted).text(t(`Notes: ${o.notes}`), m, y + 30, { width: W });
  doc.font(TOKENS.font).fontSize(8).fillColor(TOKENS.muted)
    .text('Please quote the PO number on the packing slip and invoice. Invoices go to accounts payable; this document is not an invoice.', m, doc.page.height - 70, { width: W });
  doc.end();
  return done;
}
