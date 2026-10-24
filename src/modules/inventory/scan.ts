import PDFDocument from 'pdfkit';
import type { Actor } from '../../platform/auth/actor.js';
import { can, requirePermission } from '../../platform/auth/actor.js';
import { audit } from '../../platform/audit/audit.js';
import type { Tx } from '../../platform/db/tx.js';
import { many, one } from '../../platform/db/tx.js';
import { AppError, conflict, invalid, notFound } from '../../platform/errors.js';
import { TOKENS } from '../reporting/render/format.js';
import { pdfText } from '../reporting/render/pdf.js';
import { code128Printable, drawCode128 } from './code128.js';

/**
 * Scanning (SC-006 A). Anything a scanner reads is resolved to what it is: a storeroom location, a part (by our part number or by a
 * UPC, EAN, carton or supplier code mapped to it), a lot or serial, a purchase order or a work order. Labels we print carry a prefix so
 * a location code and a part number can never be mistaken for each other: L:CODE for a location, LOT:PART:NUMBER for a lot. Plain
 * codes (a bare part number, a supplier's UPC) resolve too, because that is what suppliers' labels have on them.
 */
const LOC = 'L:';
const LOT = 'LOT:';

export const locationLabelText = (code: string) => `${LOC}${code}`;
export const lotLabelText = (partNumber: string, lot: string) => `${LOT}${partNumber}:${lot}`;

async function onHand(tx: Tx, actor: Actor, partId: string) {
  const rows = await many(tx, `SELECT l.id AS location_id, l.code AS location, b.bin, b.qty_on_hand::float AS qty, b.facility_id FROM inventory_balance b JOIN stock_location l ON l.id = b.location_id
    WHERE b.part_id = $1 AND b.qty_on_hand > 0 ORDER BY l.code`, [partId]);
  return rows.filter((r) => can(actor, 'inventory.view', r.facility_id)).map(({ facility_id: _f, ...r }) => r);
}

async function partCard(tx: Tx, actor: Actor, p: any, via: string, qtyPerScan = 1) {
  return { kind: 'part' as const, via, id: p.id, partNumber: p.part_number, description: p.description, uom: p.uom, tracking: p.tracking, qtyPerScan, onHand: await onHand(tx, actor, p.id) };
}

export async function resolveCode(tx: Tx, actor: Actor, raw: string) {
  requirePermission(actor, 'inventory.view');
  const code = raw.trim();
  if (!code) throw invalid('nothing was scanned');
  const refuse = () => new AppError(404, 'unknown_code', `${code.length > 40 ? `${code.slice(0, 40)}…` : code} is not a part, location, lot, purchase order or work order here`);

  if (code.toUpperCase().startsWith(LOC)) {
    const l = await one(tx, 'SELECT id, code, name, facility_id, active FROM stock_location WHERE lower(code) = lower($1)', [code.slice(LOC.length)]);
    if (!l || !can(actor, 'inventory.view', l.facility_id)) throw refuse();
    return { kind: 'location' as const, id: l.id, code: l.code, name: l.name, facilityId: l.facility_id, active: l.active };
  }
  if (code.toUpperCase().startsWith(LOT)) {
    const [, partNumber, ...rest] = code.slice(LOT.length).split(':');
    const lot = rest.join(':');
    const l = partNumber && lot ? await one(tx, `SELECT s.id, s.number, s.status, s.expires_on, s.kind, p.id AS part_id, p.part_number, p.description, p.uom FROM stock_lot s JOIN part p ON p.id = s.part_id
      WHERE lower(p.part_number) = lower($1) AND lower(s.number) = lower($2)`, [code.slice(LOT.length).split(':')[0], lot]) : null;
    if (!l) throw refuse();
    return { kind: 'lot' as const, id: l.id, lot: l.number, status: l.status, expiresOn: l.expires_on, lotKind: l.kind, partId: l.part_id, partNumber: l.part_number, description: l.description, uom: l.uom };
  }
  // Our own numbers first, then codes the suppliers put on their cartons.
  const byNumber = await one(tx, 'SELECT * FROM part WHERE lower(part_number) = lower($1) AND active', [code]);
  if (byNumber) return partCard(tx, actor, byNumber, 'part_number');
  const bc = await one(tx, 'SELECT p.*, b.qty_per_scan::float AS qty_per_scan FROM part_barcode b JOIN part p ON p.id = b.part_id WHERE b.code = $1 AND p.active', [code]);
  if (bc) return partCard(tx, actor, bc, 'barcode', bc.qty_per_scan);
  const po = await one(tx, `SELECT o.id, o.number, o.status, o.facility_id, s.name AS supplier FROM purchase_order o JOIN supplier s ON s.id = o.supplier_id WHERE lower(o.number) = lower($1)`, [code]);
  if (po && can(actor, 'purchasing.receive', po.facility_id)) {
    const lines = await many(tx, `SELECT l.id, l.line_no, l.description, l.qty_ordered::float AS ordered, l.qty_received::float AS received, (l.qty_ordered - l.qty_received)::float AS open, l.location_id, p.id AS part_id, p.part_number, p.tracking, p.uom
      FROM purchase_order_line l LEFT JOIN part p ON p.id = l.part_id WHERE l.order_id = $1 ORDER BY l.line_no`, [po.id]);
    return { kind: 'purchase_order' as const, id: po.id, number: po.number, status: po.status, supplier: po.supplier, facilityId: po.facility_id, lines };
  }
  const wo = await one(tx, 'SELECT id, number, title, status, facility_id FROM work_order WHERE lower(number) = lower($1)', [code]);
  if (wo && can(actor, 'work_orders.view', wo.facility_id)) return { kind: 'work_order' as const, id: wo.id, number: wo.number, title: wo.title, status: wo.status, facilityId: wo.facility_id };
  const loc = await one(tx, 'SELECT id, code, name, facility_id, active FROM stock_location WHERE lower(code) = lower($1)', [code]);
  if (loc && can(actor, 'inventory.view', loc.facility_id)) return { kind: 'location' as const, id: loc.id, code: loc.code, name: loc.name, facilityId: loc.facility_id, active: loc.active };
  throw refuse();
}

// ---------------------------------------------------------------------------
// Barcodes mapped to a part
// ---------------------------------------------------------------------------
export async function listBarcodes(tx: Tx, actor: Actor, partId: string) {
  requirePermission(actor, 'inventory.view');
  return many(tx, 'SELECT id, code, kind, qty_per_scan::float AS qty_per_scan, created_at FROM part_barcode WHERE part_id = $1 ORDER BY created_at', [partId]);
}

export async function addBarcode(tx: Tx, actor: Actor, partId: string, input: { code: string; kind?: 'upc' | 'ean' | 'carton' | 'supplier' | 'internal'; qtyPerScan?: number }) {
  requirePermission(actor, 'inventory.manage');
  const code = input.code.trim();
  if (code.length < 3 || code.length > 60) throw invalid('a barcode is 3 to 60 characters');
  if (/^(L|LOT):/i.test(code)) throw invalid('codes starting L: or LOT: are reserved for our own labels');
  if (!(await one(tx, 'SELECT 1 FROM part WHERE id = $1', [partId]))) throw notFound('part');
  const clash = await one(tx, `SELECT 'barcode on ' || p.part_number AS what FROM part_barcode b JOIN part p ON p.id = b.part_id WHERE b.code = $1
    UNION ALL SELECT 'the part number of ' || p.description FROM part p WHERE lower(p.part_number) = lower($1)
    UNION ALL SELECT 'location ' || l.code FROM stock_location l WHERE lower(l.code) = lower($1)`, [code]);
  if (clash) throw conflict(`${code} is already ${clash.what}`);
  const b = await one(tx, 'INSERT INTO part_barcode (tenant_id, part_id, code, kind, qty_per_scan, created_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, code, kind, qty_per_scan::float AS qty_per_scan',
    [actor.tenantId, partId, code, input.kind ?? 'supplier', input.qtyPerScan ?? 1, actor.userId]);
  await audit(tx, actor, { action: 'part.barcode_added', entityType: 'part', entityId: partId, data: { code, kind: b.kind, qtyPerScan: b.qty_per_scan } });
  return b;
}

export async function removeBarcode(tx: Tx, actor: Actor, partId: string, barcodeId: string) {
  requirePermission(actor, 'inventory.manage');
  const b = await one(tx, 'DELETE FROM part_barcode WHERE id = $1 AND part_id = $2 RETURNING code', [barcodeId, partId]);
  if (!b) throw notFound('barcode');
  await audit(tx, actor, { action: 'part.barcode_removed', entityType: 'part', entityId: partId, data: { code: b.code } });
}

// ---------------------------------------------------------------------------
// Labels (Code 128, Avery 5160 layout: 3 across, 10 down, 2 5/8 x 1 inch)
// ---------------------------------------------------------------------------
export async function labelsPdf(tx: Tx, actor: Actor, input: { kind: 'part' | 'location' | 'lot'; ids: string[] }): Promise<Buffer> {
  requirePermission(actor, 'inventory.view');
  if (!input.ids.length) throw invalid('choose what to label');
  let items: { text: string; title: string; sub: string }[];
  if (input.kind === 'part') {
    items = (await many(tx, 'SELECT part_number, description FROM part WHERE id = ANY ($1) ORDER BY part_number', [input.ids])).map((p) => ({ text: p.part_number, title: p.part_number, sub: p.description }));
  } else if (input.kind === 'location') {
    items = (await many(tx, 'SELECT code, name, facility_id FROM stock_location WHERE id = ANY ($1) ORDER BY code', [input.ids])).filter((l) => can(actor, 'inventory.view', l.facility_id)).map((l) => ({ text: locationLabelText(l.code), title: l.code, sub: l.name }));
  } else {
    items = (await many(tx, `SELECT s.number, s.expires_on, p.part_number, p.description FROM stock_lot s JOIN part p ON p.id = s.part_id WHERE s.id = ANY ($1) ORDER BY p.part_number, s.number`, [input.ids]))
      .map((l) => ({ text: lotLabelText(l.part_number, l.number), title: `${l.part_number}  lot ${l.number}`, sub: `${l.description}${l.expires_on ? ` · expires ${new Date(l.expires_on).toISOString().slice(0, 10)}` : ''}` }));
  }
  return renderLabels(items);
}

/** Lays out Code 128 labels on a letter sheet (also used for chemical container and preparation labels). */
export async function renderLabels(items: { text: string; title: string; sub: string }[]): Promise<Buffer> {
  if (!items.length) throw notFound('nothing to label');
  const bad = items.find((i) => !code128Printable(i.text));
  if (bad) throw invalid(`${bad.text} cannot be printed as a barcode (plain letters, digits and punctuation, up to 48 characters)`);
  const doc = new PDFDocument({ size: 'LETTER', margin: 0, info: { Title: 'Labels' } });
  const chunks: Buffer[] = []; doc.on('data', (b: Buffer) => chunks.push(b));
  const done = new Promise<Buffer>((res) => doc.on('end', () => res(Buffer.concat(chunks))));
  const LW = 189, LH = 72, X0 = 13.5, Y0 = 36, GAP = 9;
  items.forEach((it, i) => {
    const slot = i % 30; if (i && slot === 0) doc.addPage();
    const x = X0 + (slot % 3) * (LW + GAP), y = Y0 + Math.floor(slot / 3) * LH;
    doc.fillColor(TOKENS.ink).font(TOKENS.fontBold).fontSize(9).text(pdfText(it.title), x + 6, y + 5, { width: LW - 12, height: 11, ellipsis: true, lineBreak: false });
    const w = drawCode128(doc, it.text, x + 6, y + 18, 28, Math.min(1.1, (LW - 14) / 160));
    void w;
    doc.fillColor(TOKENS.ink).font(TOKENS.font).fontSize(7).text(pdfText(it.text), x + 6, y + 48, { width: LW - 12, lineBreak: false });
    doc.fillColor(TOKENS.muted).fontSize(6.5).text(pdfText(it.sub), x + 6, y + 58, { width: LW - 12, height: 8, ellipsis: true, lineBreak: false });
  });
  doc.end();
  return done;
}
