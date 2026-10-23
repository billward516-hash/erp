import PDFDocument from 'pdfkit';
import { TOKENS } from '../reporting/render/format.js';
import { pdfText } from '../reporting/render/pdf.js';

const usd = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
const qty = (n: number) => Number(n).toLocaleString('en-US', { maximumFractionDigits: 3 });
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** 15 Nov 2026: unambiguous for customers in any country. */
const longDate = (d: unknown) => {
  if (!d) return '—';
  const s = (d instanceof Date ? d.toISOString() : String(d)).slice(0, 10);
  const [y, m, day] = s.split('-').map(Number);
  return `${day} ${MONTHS[(m ?? 1) - 1]} ${y}`;
};
const days = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

/**
 * Customer-facing quotation (never cost or margin). Layout: seller and quote identity, who it is for and who prepared it, how long the
 * prices hold, the priced lines, then what is included, what is not, lead time and delivery, payment terms and notes, and a
 * signature block for acceptance. Every page carries the quote number, revision and page count. Drafts are watermarked as previews.
 */
export function renderQuotePdf(q: any): Promise<Buffer> {
  const doc = new PDFDocument({ size: 'LETTER', margin: 48, bufferPages: true, info: { Title: `Quotation ${q.number} rev ${q.revision}`, Author: pdfText(String(q.facility_name ?? '')) } });
  const chunks: Buffer[] = [];
  doc.on('data', (b: Buffer) => chunks.push(b));
  const done = new Promise<Buffer>((r) => doc.on('end', () => r(Buffer.concat(chunks))));
  const m = 48, W = doc.page.width - 2 * m, bottom = doc.page.height - 64;
  const t = (s: unknown) => pdfText(String(s ?? ''));
  const draft = q.preview || !['approved', 'sent', 'accepted'].includes(q.status);
  const issued = (q.sent_at ? new Date(q.sent_at).toISOString() : new Date().toISOString()).slice(0, 10);
  const validDays = q.valid_until ? days(issued, String(q.valid_until).slice(0, 10)) : null;
  const addr = q.facility_address && typeof q.facility_address === 'object'
    ? [q.facility_address.line1 ?? q.facility_address.street, [q.facility_address.city, q.facility_address.state, q.facility_address.postal_code ?? q.facility_address.zip].filter(Boolean).join(', ')].filter(Boolean).join(' · ') : '';

  // Seller and identity
  doc.fillColor(TOKENS.ink).font(TOKENS.fontBold).fontSize(15).text(t(q.company_name ?? q.facility_name), m, m, { width: W * 0.6 });
  doc.font(TOKENS.font).fontSize(9).fillColor(TOKENS.muted).text(t([q.company_name && q.company_name !== q.facility_name ? q.facility_name : '', addr].filter(Boolean).join(' · ')), m, doc.y + 1, { width: W * 0.6 });
  doc.fillColor(TOKENS.accent).font(TOKENS.fontBold).fontSize(9).text('QUOTATION', m + W * 0.6, m, { width: W * 0.4, align: 'right', characterSpacing: 1.4 });
  doc.fillColor(TOKENS.ink).fontSize(20).text(t(q.number), m + W * 0.6, m + 13, { width: W * 0.4, align: 'right' });
  doc.fillColor(TOKENS.muted).font(TOKENS.font).fontSize(9).text(`Revision ${q.revision} · issued ${longDate(issued)}`, m + W * 0.6, m + 38, { width: W * 0.4, align: 'right' });
  doc.moveTo(m, m + 58).lineTo(m + W, m + 58).lineWidth(1.2).strokeColor(TOKENS.accent).stroke();

  // Subject, recipient, preparer, validity
  let y = m + 72;
  doc.fillColor(TOKENS.ink).font(TOKENS.fontBold).fontSize(13).text(t(q.title), m, y, { width: W });
  y = doc.y + 10;
  const colW = (W - 24) / 3;
  const block = (x: number, label: string, lines: string[]) => {
    doc.fillColor(TOKENS.muted).font(TOKENS.fontBold).fontSize(7.5).text(label, x, y, { characterSpacing: 0.9, width: colW });
    doc.fillColor(TOKENS.ink).font(TOKENS.font).fontSize(9.5).text(lines.filter(Boolean).map(t).join('\n'), x, y + 11, { width: colW });
    return doc.y;
  };
  const a = block(m, 'PREPARED FOR', [q.customer_name, q.contact_name ? `Attention: ${q.contact_name}` : '', q.billing_address ?? '']);
  const b = block(m + colW + 12, 'PREPARED BY', [q.created_by_name, q.facility_name, q.created_by_email ?? '']);
  const c = block(m + 2 * (colW + 12), 'PRICES VALID', [q.valid_until ? `Until ${longDate(q.valid_until)}` : 'Not stated', validDays != null ? `${validDays} days from issue` : '',
    `Payment: ${q.payment_terms ?? 'to be agreed'}`, 'USD, excluding applicable taxes']);
  y = Math.max(a, b, c) + 14;

  // Lines
  const cols = [{ k: '#', w: 0.4, a: 'left' }, { k: 'Description', w: 4.2, a: 'left' }, { k: 'Qty', w: 0.8, a: 'right' }, { k: 'UOM', w: 0.6, a: 'left' },
    { k: 'Unit price', w: 1.1, a: 'right' }, { k: 'Amount', w: 1.2, a: 'right' }] as const;
  const totalW = cols.reduce((s, x) => s + x.w, 0);
  const xs: number[] = []; let x = m;
  for (const col of cols) { xs.push(x); x += (col.w / totalW) * W; }
  const width = (i: number) => (cols[i]!.w / totalW) * W - 6;
  const head = () => {
    doc.rect(m, y - 3, W, 17).fillColor(TOKENS.surface).fill();
    doc.font(TOKENS.fontBold).fontSize(8.5).fillColor(TOKENS.muted);
    cols.forEach((col, i) => doc.text(col.k, xs[i]!, y, { width: width(i), align: col.a }));
    y += 18;
  };
  head();
  doc.font(TOKENS.font).fontSize(9).fillColor(TOKENS.ink);
  for (const l of q.lines) {
    const cells = [String(l.line_no), l.description, qty(l.qty), l.uom ?? 'EA', usd(l.unit_price), usd(l.amount)];
    const h = Math.max(...cells.map((cell, i) => doc.heightOfString(t(cell), { width: width(i) })));
    if (y + h > bottom - 40) { doc.addPage(); y = m; head(); doc.font(TOKENS.font).fontSize(9).fillColor(TOKENS.ink); }
    cells.forEach((cell, i) => doc.text(t(cell), xs[i]!, y, { width: width(i), align: cols[i]!.a }));
    y += h + 6;
    doc.moveTo(m, y - 3).lineTo(m + W, y - 3).lineWidth(0.4).strokeColor(TOKENS.rule).stroke();
  }
  if (y + 30 > bottom) { doc.addPage(); y = m; }
  doc.font(TOKENS.fontBold).fontSize(12).fillColor(TOKENS.ink).text(`Total ${usd(q.total)}`, m, y + 6, { width: W, align: 'right' });
  y += 34;

  // Terms sections
  const section = (title: string, body: string | null | undefined) => {
    if (!body?.trim()) return;
    const h = doc.font(TOKENS.font).fontSize(9.5).heightOfString(t(body), { width: W }) + 20;
    if (y + h > bottom) { doc.addPage(); y = m; }
    doc.fillColor(TOKENS.muted).font(TOKENS.fontBold).fontSize(7.5).text(title.toUpperCase(), m, y, { characterSpacing: 0.9 });
    doc.fillColor(TOKENS.ink).font(TOKENS.font).fontSize(9.5).text(t(body), m, y + 11, { width: W });
    y = doc.y + 10;
  };
  section('Lead time', q.lead_time);
  section('Delivery', q.delivery_terms);
  section('Included', q.inclusions);
  section('Not included', q.exclusions);
  section('Notes', q.notes);

  // Acceptance
  const boxH = 112;
  if (y + boxH > bottom) { doc.addPage(); y = m; }
  doc.roundedRect(m, y, W, boxH, 4).lineWidth(0.8).strokeColor(TOKENS.rule).stroke();
  doc.fillColor(TOKENS.accent).font(TOKENS.fontBold).fontSize(8).text('ACCEPTANCE', m + 12, y + 10, { characterSpacing: 1 });
  doc.fillColor(TOKENS.ink).font(TOKENS.font).fontSize(8.5).text(t(`To accept ${q.number} revision ${q.revision}, sign and return this page or send your purchase order quoting ${q.number}${q.valid_until ? `, on or before ${longDate(q.valid_until)}` : ''}. Prices and terms are held only until then.`), m + 12, y + 22, { width: W - 24 });
  const line = (label: string, lx: number, lw: number, ly: number) => {
    doc.moveTo(lx, ly).lineTo(lx + lw, ly).lineWidth(0.5).strokeColor(TOKENS.muted).stroke();
    doc.fillColor(TOKENS.muted).fontSize(7.5).text(label, lx, ly + 2, { width: lw });
  };
  const half = (W - 36) / 2;
  line('Name and title', m + 12, half, y + 70); line('Signature', m + 24 + half, half, y + 70);
  line('Date', m + 12, half, y + 98); line('Purchase order number', m + 24 + half, half, y + 98);

  // Watermark and footers on every page
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(i);
    doc.page.margins.bottom = 0; // footer sits inside the bottom margin; without this pdfkit adds a page for it
    if (draft) {
      doc.save().rotate(-30, { origin: [doc.page.width / 2, doc.page.height / 2] }).fillColor(TOKENS.rule).font(TOKENS.fontBold).fontSize(64)
        .text('DRAFT PREVIEW', 0, doc.page.height / 2 - 40, { width: doc.page.width, align: 'center' }).restore();
    }
    doc.font(TOKENS.font).fontSize(7.5).fillColor(TOKENS.muted)
      .text(`${t(q.number)} revision ${q.revision}${q.valid_until ? ` · valid until ${longDate(q.valid_until)}` : ''}`, m, doc.page.height - 38, { width: W / 2, lineBreak: false })
      .text(`Page ${i + 1} of ${range.count}`, m + W / 2, doc.page.height - 38, { width: W / 2, align: 'right', lineBreak: false });
  }
  doc.end();
  return done;
}
