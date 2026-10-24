import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';
import type { Actor } from '../../platform/auth/actor.js';
import type { Tx } from '../../platform/db/tx.js';
import { one } from '../../platform/db/tx.js';
import { pdfText } from '../reporting/render/pdf.js';
import { type BsCompare, type Compare, balanceSheetCompare, cashFlow, incomeStatement } from './statements.js';

/** The statements pack (D-189): profit and loss, balance sheet and cash flow for one period as a single PDF or Excel workbook. */
export interface PackQuery { from: string; to: string; compare?: Compare; facilityId?: string | null }
const bsCompare = (c?: Compare): BsCompare => (c === 'prior_year' ? 'prior_year' : c === 'prior_period' ? 'prior_month' : 'none');
const fmt = (n: number | null | undefined) => (n === null || n === undefined ? '' : n < 0 ? `(${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })})` : n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));

interface Row { label: string; values: (number | null)[]; kind?: 'head' | 'total' | 'grand' | 'line' }
interface Statement { title: string; subtitle: string; columns: string[]; rows: Row[]; notes: string[] }

export async function buildStatements(tx: Tx, actor: Actor, q: PackQuery): Promise<{ company: string; statements: Statement[]; generated: string }> {
  const company = (await one(tx, 'SELECT name FROM tenant WHERE id = $1', [actor.tenantId]))?.name ?? '';
  const pl = await incomeStatement(tx, actor, { from: q.from, to: q.to, compare: q.compare, facilityId: q.facilityId });
  const bs = await balanceSheetCompare(tx, actor, { asOf: q.to, compare: bsCompare(q.compare), facilityId: q.facilityId });
  const cf = await cashFlow(tx, actor, { from: q.from, to: q.to, facilityId: q.facilityId });
  const plRows: Row[] = [];
  for (const s of pl.sections) {
    if (!s.accounts.length) continue;
    plRows.push({ label: s.name, values: pl.columns.map(() => null), kind: 'head' });
    for (const a of s.accounts) plRows.push({ label: `${a.code} ${a.name}`, values: a.amounts, kind: 'line' });
    plRows.push({ label: `Total ${s.name.toLowerCase()}`, values: s.totals, kind: 'total' });
    if (s.name === 'Cost of goods sold') plRows.push({ label: 'Gross profit', values: pl.grossProfit, kind: 'total' });
  }
  plRows.push({ label: 'Net income', values: pl.netIncome, kind: 'grand' });
  const bsRows: Row[] = [];
  const grp = (name: string, rows: { code: string; name: string; amounts: number[] }[], totals: number[]) => {
    bsRows.push({ label: name, values: bs.columns.map(() => null), kind: 'head' });
    for (const r of rows) bsRows.push({ label: `${r.code} ${r.name}`.trim(), values: r.amounts, kind: 'line' });
    bsRows.push({ label: `Total ${name.toLowerCase()}`, values: totals, kind: 'total' });
  };
  grp('Assets', bs.assets, bs.totalAssets); grp('Liabilities', bs.liabilities, bs.totalLiabilities); grp('Equity', bs.equity, bs.totalEquity);
  bsRows.push({ label: 'Liabilities and equity', values: bs.totalLiabilities.map((v, i) => Math.round((v + bs.totalEquity[i]!) * 100) / 100), kind: 'grand' });
  const cfRows: Row[] = [{ label: 'Net income', values: [cf.netIncome], kind: 'line' }, { label: 'Operating activities', values: [null], kind: 'head' }, ...cf.operating.map((l) => ({ label: l.label, values: [l.amount], kind: 'line' as const })),
    { label: 'Cash from operating activities', values: [cf.operatingTotal], kind: 'total' }, { label: 'Investing activities', values: [null], kind: 'head' }, ...cf.investing.map((l) => ({ label: l.label, values: [l.amount], kind: 'line' as const })),
    { label: 'Cash from investing activities', values: [cf.investingTotal], kind: 'total' }, { label: 'Financing activities', values: [null], kind: 'head' }, ...cf.financing.map((l) => ({ label: l.label, values: [l.amount], kind: 'line' as const })),
    { label: 'Cash from financing activities', values: [cf.financingTotal], kind: 'total' }, { label: 'Net change in cash', values: [cf.netChange], kind: 'total' },
    { label: 'Cash at start', values: [cf.cashStart], kind: 'line' }, { label: 'Cash at end', values: [cf.cashEnd], kind: 'grand' }];
  const basis = 'Accrual basis from the built-in books: invoices count when issued, bills when approved, expense reports when approved.';
  return {
    company, generated: new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC',
    statements: [
      { title: 'Profit and loss', subtitle: `${q.from} to ${q.to}`, columns: pl.columns.map((c) => c.label), rows: plRows, notes: [basis] },
      { title: 'Balance sheet', subtitle: `As of ${q.to}`, columns: bs.columns.map((c) => c.label), rows: bsRows, notes: [...(bs.balanced.every(Boolean) ? [] : ['The balance sheet does not balance; check the journal.']), ...(bs.siteNote ? [bs.siteNote] : [])] },
      { title: 'Cash flow', subtitle: `${q.from} to ${q.to}`, columns: ['Amount'], rows: cfRows, notes: [...cf.notes, cf.ties ? 'Ties to the change in the bank accounts.' : `Does not tie to the bank accounts: difference ${fmt(cf.difference)}.`] },
    ],
  };
}

export async function statementsPdf(p: Awaited<ReturnType<typeof buildStatements>>): Promise<Buffer> {
  const doc = new PDFDocument({ size: 'LETTER', margins: { top: 48, bottom: 56, left: 54, right: 54 }, bufferPages: true, info: { Title: `Financial statements, ${p.company}`, Creator: 'ERP platform' } });
  const chunks: Buffer[] = []; doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))));
  const left = doc.page.margins.left; const width = doc.page.width - left - doc.page.margins.right;
  p.statements.forEach((s, si) => {
    if (si) doc.addPage();
    doc.fillColor('#1d2430').font('Helvetica-Bold').fontSize(16).text(pdfText(p.company), left, 48, { width });
    doc.font('Helvetica-Bold').fontSize(13).text(pdfText(s.title), { width }); doc.font('Helvetica').fontSize(9).fillColor('#5a6577').text(pdfText(s.subtitle), { width }); doc.moveDown(0.8);
    const labelW = s.columns.length > 2 ? width * 0.4 : width * 0.62; const colW = (width - labelW) / s.columns.length;
    doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#5a6577');
    const hy = doc.y; s.columns.forEach((c, i) => doc.text(pdfText(c), left + labelW + i * colW, hy, { width: colW, align: 'right' })); doc.moveDown(0.3);
    doc.moveTo(left, doc.y).lineTo(left + width, doc.y).strokeColor('#d9dee7').stroke(); doc.moveDown(0.3);
    for (const r of s.rows) {
      if (doc.y > doc.page.height - doc.page.margins.bottom - 24) doc.addPage();
      const y = doc.y; const bold = r.kind === 'head' || r.kind === 'total' || r.kind === 'grand';
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(9).fillColor(r.kind === 'head' ? '#1f5fbf' : '#1d2430').text(pdfText(r.label), left + (r.kind === 'line' ? 12 : 0), y, { width: labelW - (r.kind === 'line' ? 12 : 0) });
      const h = doc.y;
      r.values.forEach((v, i) => doc.text(fmt(v), left + labelW + i * colW, y, { width: colW, align: 'right' }));
      doc.y = h;
      if (r.kind === 'total' || r.kind === 'grand') { doc.moveTo(left + labelW, doc.y + 1).lineTo(left + width, doc.y + 1).strokeColor(r.kind === 'grand' ? '#1d2430' : '#d9dee7').stroke(); doc.moveDown(0.15); }
      doc.moveDown(0.1);
    }
    doc.moveDown(0.8).font('Helvetica').fontSize(8).fillColor('#5a6577');
    for (const n of s.notes) doc.text(pdfText(n), left, doc.y, { width });
  });
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) { doc.switchToPage(i); doc.page.margins.bottom = 0; doc.font('Helvetica').fontSize(7.5).fillColor('#8892a0').text(pdfText(`Prepared ${p.generated} from the built-in books. Unaudited management statements.  Page ${i + 1} of ${range.count}`), 54, doc.page.height - 36, { width: doc.page.width - 108, align: 'center' }); }
  doc.end();
  return done;
}

export async function statementsXlsx(p: Awaited<ReturnType<typeof buildStatements>>): Promise<Buffer> {
  const wb = new ExcelJS.Workbook(); wb.creator = 'ERP platform';
  for (const s of p.statements) {
    const ws = wb.addWorksheet(s.title);
    ws.addRow([p.company]).font = { bold: true, size: 14 }; ws.addRow([`${s.title}: ${s.subtitle}`]).font = { bold: true };
    const head = ws.addRow(['', ...s.columns]); head.font = { bold: true };
    for (const r of s.rows) { const row = ws.addRow([r.label, ...r.values.map((v) => v ?? null)]); if (r.kind && r.kind !== 'line') row.font = { bold: true }; row.eachCell((c, n) => { if (n > 1) c.numFmt = '#,##0.00;(#,##0.00)'; }); }
    ws.addRow([]); for (const n of s.notes) ws.addRow([n]).font = { italic: true };
    ws.getColumn(1).width = 46; for (let i = 2; i <= s.columns.length + 1; i++) ws.getColumn(i).width = 18;
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}
