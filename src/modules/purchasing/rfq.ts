import PDFDocument from 'pdfkit';
import type { Actor } from '../../platform/auth/actor.js';
import { can, requirePermission } from '../../platform/auth/actor.js';
import { audit } from '../../platform/audit/audit.js';
import type { Tx } from '../../platform/db/tx.js';
import { many, nextSequence, one } from '../../platform/db/tx.js';
import { conflict, invalid, notFound } from '../../platform/errors.js';
import { notify } from '../../platform/notify/notify.js';
import { TOKENS } from '../reporting/render/format.js';
import { pdfText } from '../reporting/render/pdf.js';
import { createPurchaseRequest, submitPurchaseRequest } from './service.js';

/**
 * Request for quote, buyer side (SC-005 A). One request to several suppliers with a response deadline; each reply is recorded per
 * line (price, lead time, minimum, validity); a comparison shows price, landed cost and lead time side by side; awarding creates a
 * purchase request at the awarded prices, which then goes through the usual approval. Losing bids stay as the record, and choosing a
 * supplier that is not the lowest price on a line needs a reason. Nothing is sent by the platform: the request letter is a PDF the
 * buyer attaches to their own email (the sending domain is a separate decision).
 */
const SUBJECT = 'rfq';
export interface RfqLineInput { partId?: string | null; description?: string | null; qty: number; uom?: string | null; targetPrice?: number | null }

async function lock(tx: Tx, id: string) {
  const r = await one(tx, 'SELECT * FROM rfq WHERE id = $1 FOR UPDATE', [id]);
  if (!r) throw notFound('request for quote');
  return r;
}
const manage = (actor: Actor, facilityId: string) => requirePermission(actor, 'purchasing.manage', facilityId);

export async function createRfq(tx: Tx, actor: Actor, input: { facilityId: string; title: string; neededBy?: string | null; respondBy?: string | null; notes?: string | null; lines: RfqLineInput[]; supplierIds?: string[]; sourceRequestId?: string | null }) {
  manage(actor, input.facilityId);
  if (!input.title?.trim()) throw invalid('give the request a title');
  if (!input.lines.length) throw invalid('add at least one line');
  if (input.respondBy && input.neededBy && input.respondBy > input.neededBy) throw invalid('suppliers must reply before the date you need the goods');
  const number = `RFQ-${String(await nextSequence(tx, actor.tenantId, 'rfq')).padStart(6, '0')}`;
  const r = await one(tx, `INSERT INTO rfq (tenant_id, facility_id, number, title, needed_by, respond_by, notes, source_request_id, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
    [actor.tenantId, input.facilityId, number, input.title.trim(), input.neededBy ?? null, input.respondBy ?? null, input.notes ?? null, input.sourceRequestId ?? null, actor.userId]);
  const parts = new Map((await many(tx, 'SELECT id, part_number, description, uom FROM part WHERE id = ANY ($1)', [input.lines.map((l) => l.partId).filter(Boolean)])).map((p) => [p.id as string, p]));
  for (const [i, l] of input.lines.entries()) {
    const p = l.partId ? parts.get(l.partId) : undefined;
    if (l.partId && !p) throw invalid(`line ${i + 1}: part not found`);
    const description = l.description?.trim() || (p ? `${p.part_number} ${p.description}` : '');
    if (!description) throw invalid(`line ${i + 1}: describe the item or choose a part`);
    if (!(l.qty > 0)) throw invalid(`line ${i + 1}: quantity must be positive`);
    await tx.query(`INSERT INTO rfq_line (tenant_id, rfq_id, line_no, part_id, description, qty, uom, target_price) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [actor.tenantId, r.id, i + 1, l.partId ?? null, description, l.qty, l.uom ?? p?.uom ?? null, l.targetPrice ?? null]);
  }
  for (const s of input.supplierIds ?? []) await inviteSupplier(tx, actor, r.id, s, true);
  await audit(tx, actor, { action: 'rfq.created', entityType: SUBJECT, entityId: r.id, facilityId: r.facility_id, data: { number, lines: input.lines.length, suppliers: input.supplierIds?.length ?? 0 } });
  return getRfq(tx, actor, r.id);
}

export async function inviteSupplier(tx: Tx, actor: Actor, rfqId: string, supplierId: string, quiet = false) {
  const r = await lock(tx, rfqId); manage(actor, r.facility_id);
  if (!['draft', 'sent'].includes(r.status)) throw conflict(`the request is ${r.status}`);
  const s = await one(tx, 'SELECT id, name FROM supplier WHERE id = $1', [supplierId]);
  if (!s) throw notFound('supplier');
  const ins = await one(tx, `INSERT INTO rfq_invite (tenant_id, rfq_id, supplier_id) VALUES ($1, $2, $3) ON CONFLICT (rfq_id, supplier_id) DO NOTHING RETURNING id`, [actor.tenantId, rfqId, supplierId]);
  if (!ins) throw conflict(`${s.name} is already invited`);
  if (!quiet) await audit(tx, actor, { action: 'rfq.supplier_invited', entityType: SUBJECT, entityId: rfqId, facilityId: r.facility_id, data: { supplier: s.name } });
}

export async function removeInvite(tx: Tx, actor: Actor, rfqId: string, inviteId: string) {
  const r = await lock(tx, rfqId); manage(actor, r.facility_id);
  const i = await one(tx, 'SELECT * FROM rfq_invite WHERE id = $1 AND rfq_id = $2', [inviteId, rfqId]);
  if (!i) throw notFound('invitation');
  if (i.status === 'responded') throw conflict('this supplier has answered; keep the reply as the record');
  if (r.status === 'awarded') throw conflict('the request is awarded');
  await tx.query('DELETE FROM rfq_invite WHERE id = $1', [inviteId]);
}

/** Marks the request as sent (the buyer sends the letter) and starts the clock. */
export async function sendRfq(tx: Tx, actor: Actor, id: string) {
  const r = await lock(tx, id); manage(actor, r.facility_id);
  if (r.status !== 'draft') throw conflict(`the request is ${r.status}`);
  const n = Number((await one(tx, 'SELECT count(*) AS n FROM rfq_invite WHERE rfq_id = $1', [id]))!.n);
  if (!n) throw invalid('invite at least one supplier first');
  if (!r.respond_by) throw invalid('set the date suppliers must reply by');
  if (r.respond_by < new Date().toISOString().slice(0, 10)) throw invalid('the reply date has already passed');
  await tx.query(`UPDATE rfq SET status = 'sent', sent_at = now() WHERE id = $1`, [id]);
  await tx.query(`UPDATE rfq_invite SET invited_at = now() WHERE rfq_id = $1`, [id]);
  await audit(tx, actor, { action: 'rfq.sent', entityType: SUBJECT, entityId: id, facilityId: r.facility_id, data: { suppliers: n, respondBy: r.respond_by } });
  return getRfq(tx, actor, id);
}

export async function recordResponse(tx: Tx, actor: Actor, rfqId: string, inviteId: string,
  input: { lines?: { rfqLineId: string; unitPrice: number; leadTimeDays?: number | null; minQty?: number | null; validUntil?: string | null; note?: string | null }[]; freight?: number; paymentTerms?: string | null; note?: string | null; declined?: boolean; declineReason?: string | null }) {
  const r = await lock(tx, rfqId); manage(actor, r.facility_id);
  if (r.status !== 'sent') throw conflict(r.status === 'draft' ? 'send the request first' : `the request is ${r.status}`);
  const inv = await one(tx, 'SELECT * FROM rfq_invite WHERE id = $1 AND rfq_id = $2 FOR UPDATE', [inviteId, rfqId]);
  if (!inv) throw notFound('invitation');
  if (input.declined) {
    await tx.query(`UPDATE rfq_invite SET status = 'declined', responded_at = now(), decline_reason = $2, recorded_by = $3 WHERE id = $1`, [inviteId, input.declineReason?.trim() || null, actor.userId]);
    await tx.query('DELETE FROM rfq_response_line WHERE invite_id = $1', [inviteId]);
  } else {
    if (!input.lines?.length) throw invalid('give a price for at least one line');
    const valid = new Set((await many(tx, 'SELECT id FROM rfq_line WHERE rfq_id = $1', [rfqId])).map((l) => l.id as string));
    await tx.query('DELETE FROM rfq_response_line WHERE invite_id = $1', [inviteId]);
    for (const l of input.lines) {
      if (!valid.has(l.rfqLineId)) throw invalid('a price is for a line that is not on this request');
      if (!(l.unitPrice >= 0)) throw invalid('prices cannot be negative');
      await tx.query(`INSERT INTO rfq_response_line (tenant_id, invite_id, rfq_line_id, unit_price, lead_time_days, min_qty, valid_until, note) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [actor.tenantId, inviteId, l.rfqLineId, l.unitPrice, l.leadTimeDays ?? null, l.minQty ?? null, l.validUntil ?? null, l.note ?? null]);
    }
    await tx.query(`UPDATE rfq_invite SET status = 'responded', responded_at = now(), freight = $2, payment_terms = $3, note = $4, decline_reason = NULL, recorded_by = $5 WHERE id = $1`,
      [inviteId, input.freight ?? 0, input.paymentTerms ?? null, input.note ?? null, actor.userId]);
  }
  await audit(tx, actor, { action: input.declined ? 'rfq.declined' : 'rfq.response_recorded', entityType: SUBJECT, entityId: rfqId, facilityId: r.facility_id, data: { inviteId, lines: input.lines?.length ?? 0 } });
  return getRfq(tx, actor, rfqId);
}

/** The request, its lines, each supplier's answer, and the comparison: per line the lowest price, per supplier the landed total. */
export async function getRfq(tx: Tx, actor: Actor, id: string) {
  const r = await one(tx, `SELECT r.*, f.code AS facility_code, u.display_name AS created_by_name, pr.number AS request_number, aw.number AS award_request_number
    FROM rfq r JOIN facility f ON f.id = r.facility_id JOIN app_user u ON u.id = r.created_by LEFT JOIN purchase_request pr ON pr.id = r.source_request_id LEFT JOIN purchase_request aw ON aw.id = r.award_request_id WHERE r.id = $1`, [id]);
  if (!r) throw notFound('request for quote');
  requirePermission(actor, 'purchasing.view', r.facility_id);
  const lines = await many(tx, `SELECT l.*, p.part_number FROM rfq_line l LEFT JOIN part p ON p.id = l.part_id WHERE l.rfq_id = $1 ORDER BY l.line_no`, [id]);
  const invites = await many(tx, `SELECT i.*, s.name AS supplier_name, s.code AS supplier_code, s.email AS supplier_email FROM rfq_invite i JOIN supplier s ON s.id = i.supplier_id WHERE i.rfq_id = $1 ORDER BY s.name`, [id]);
  const resp = await many(tx, `SELECT x.* FROM rfq_response_line x JOIN rfq_invite i ON i.id = x.invite_id WHERE i.rfq_id = $1`, [id]);
  const price = (inviteId: string, lineId: string) => resp.find((x) => x.invite_id === inviteId && x.rfq_line_id === lineId);
  const today = new Date().toISOString().slice(0, 10);
  const cells = lines.map((l) => {
    const offers = invites.map((i) => ({ inviteId: i.id as string, x: price(i.id, l.id) })).filter((o) => o.x);
    const lowest = offers.length ? Math.min(...offers.map((o) => Number(o.x.unit_price))) : null;
    const fastest = offers.filter((o) => o.x.lead_time_days != null).length ? Math.min(...offers.filter((o) => o.x.lead_time_days != null).map((o) => o.x.lead_time_days as number)) : null;
    return { lineId: l.id as string, lowest, fastest, offers: invites.map((i) => { const x = price(i.id, l.id); return { inviteId: i.id as string, unitPrice: x ? Number(x.unit_price) : null, leadTimeDays: x?.lead_time_days ?? null, minQty: x?.min_qty != null ? Number(x.min_qty) : null,
      validUntil: x?.valid_until ?? null, note: x?.note ?? null, isLowest: !!x && Number(x.unit_price) === lowest, isFastest: !!x && fastest != null && x.lead_time_days === fastest, expired: !!x?.valid_until && new Date(x.valid_until).toISOString().slice(0, 10) < today,
      belowMin: !!x && x.min_qty != null && Number(l.qty) < Number(x.min_qty) }; }) };
  });
  const totals = invites.map((i) => {
    const mine = lines.map((l) => ({ l, x: price(i.id, l.id) }));
    const quoted = mine.filter((m) => m.x);
    const goods = quoted.reduce((s, m) => s + Number(m.l.qty) * Number(m.x.unit_price), 0);
    return { inviteId: i.id as string, quotedLines: quoted.length, allLines: quoted.length === lines.length, goods: Math.round(goods * 100) / 100, freight: Number(i.freight), landed: Math.round((goods + Number(i.freight)) * 100) / 100,
      slowest: quoted.length ? Math.max(...quoted.map((m) => m.x.lead_time_days ?? 0)) : null };
  });
  const complete = totals.filter((t) => t.allLines && t.quotedLines > 0);
  const bestLanded = complete.length ? Math.min(...complete.map((t) => t.landed)) : null;
  const overdue = r.status === 'sent' && r.respond_by && new Date(r.respond_by).toISOString().slice(0, 10) < today;
  const waiting = invites.filter((i) => i.status === 'invited');
  const answer = r.status === 'awarded' ? `Awarded${r.award_request_number ? ` on ${r.award_request_number}` : ''}.`
    : r.status === 'cancelled' ? 'Cancelled.' : r.status === 'draft' ? `Draft: ${invites.length} supplier${invites.length === 1 ? '' : 's'} chosen; set a reply date and send it.`
      : `${invites.filter((i) => i.status === 'responded').length} of ${invites.length} suppliers have answered${r.respond_by ? `; replies due ${new Date(r.respond_by).toISOString().slice(0, 10)}${overdue ? ' (past)' : ''}` : ''}${waiting.length ? `; waiting for ${waiting.slice(0, 3).map((i) => i.supplier_name).join(', ')}` : ''}.`;
  return { ...r, lines, invites, cells, totals: totals.map((t) => ({ ...t, best: bestLanded != null && t.allLines && t.landed === bestLanded })), overdue: !!overdue, answer, canManage: can(actor, 'purchasing.manage', r.facility_id) };
}

export async function listRfqs(tx: Tx, actor: Actor, q: { status?: string } = {}) {
  requirePermission(actor, 'purchasing.view');
  const rows = await many(tx, `SELECT r.id, r.number, r.title, r.status, r.respond_by, r.needed_by, r.facility_id, f.code AS facility_code, r.created_at,
      (SELECT count(*)::int FROM rfq_invite i WHERE i.rfq_id = r.id) AS invited, (SELECT count(*)::int FROM rfq_invite i WHERE i.rfq_id = r.id AND i.status <> 'invited') AS answered,
      (r.status = 'sent' AND r.respond_by < current_date) AS overdue, (SELECT count(*)::int FROM rfq_line l WHERE l.rfq_id = r.id) AS lines
    FROM rfq r JOIN facility f ON f.id = r.facility_id WHERE ($1::text IS NULL OR r.status = $1) ORDER BY (r.status = 'sent') DESC, r.respond_by NULLS LAST, r.created_at DESC LIMIT 300`, [q.status ?? null]);
  return rows.filter((r) => can(actor, 'purchasing.view', r.facility_id));
}

export async function cancelRfq(tx: Tx, actor: Actor, id: string, reason: string) {
  const r = await lock(tx, id); manage(actor, r.facility_id);
  if (r.status === 'awarded' || r.status === 'cancelled') throw conflict(`the request is ${r.status}`);
  if (!reason?.trim()) throw invalid('say why it is cancelled');
  await tx.query(`UPDATE rfq SET status = 'cancelled', cancel_reason = $2 WHERE id = $1`, [id, reason.trim()]);
  await audit(tx, actor, { action: 'rfq.cancelled', entityType: SUBJECT, entityId: id, facilityId: r.facility_id, data: { reason } });
}

/**
 * Awards lines to the chosen suppliers and creates one purchase request at those prices (it goes through the usual approval). A line
 * awarded to someone other than the lowest price needs a reason, recorded with the award.
 */
export async function awardRfq(tx: Tx, actor: Actor, id: string, input: { awards: { rfqLineId: string; inviteId: string; reason?: string | null }[]; submit?: boolean }) {
  const r = await lock(tx, id); manage(actor, r.facility_id);
  if (r.status !== 'sent') throw conflict(r.status === 'draft' ? 'send the request first' : `the request is ${r.status}`);
  if (!input.awards.length) throw invalid('choose a supplier for at least one line');
  const g = await getRfq(tx, actor, id);
  const lineOf = new Map(g.lines.map((l: any) => [l.id as string, l]));
  const picked: { line: any; invite: any; price: number }[] = [];
  for (const a of input.awards) {
    const line: any = lineOf.get(a.rfqLineId); if (!line) throw invalid('a chosen line is not on this request');
    if (line.awarded_invite_id) throw conflict(`line ${line.line_no} is already awarded`);
    const cell = g.cells.find((c: any) => c.lineId === a.rfqLineId)!.offers.find((o: any) => o.inviteId === a.inviteId);
    if (!cell || cell.unitPrice == null) throw invalid(`line ${line.line_no}: that supplier gave no price`);
    const invite = g.invites.find((i: any) => i.id === a.inviteId);
    const lowest = g.cells.find((c: any) => c.lineId === a.rfqLineId)!.lowest as number;
    if (cell.unitPrice > lowest + 1e-9 && !a.reason?.trim()) throw invalid(`line ${line.line_no}: ${invite.supplier_name} is not the lowest price; say why (lead time, quality, minimums, a preferred supplier)`);
    picked.push({ line, invite, price: cell.unitPrice });
    await tx.query('UPDATE rfq_line SET awarded_invite_id = $2, award_reason = $3 WHERE id = $1', [a.rfqLineId, a.inviteId, a.reason?.trim() || null]);
  }
  const req = await createPurchaseRequest(tx, actor, { facilityId: r.facility_id, title: `${r.number}: ${r.title}`, justification: `Awarded from ${r.number} after quotes from ${g.invites.filter((i: any) => i.status === 'responded').length} supplier(s).`,
    neededBy: r.needed_by ? new Date(r.needed_by).toISOString().slice(0, 10) : null,
    lines: picked.map((p) => ({ partId: p.line.part_id, description: p.line.description, qty: Number(p.line.qty), uom: p.line.uom, estUnitPrice: p.price, supplierId: p.invite.supplier_id })) });
  const left = Number((await one(tx, 'SELECT count(*) AS n FROM rfq_line WHERE rfq_id = $1 AND awarded_invite_id IS NULL', [id]))!.n);
  await tx.query(`UPDATE rfq SET award_request_id = coalesce(award_request_id, $2), status = CASE WHEN $3 = 0 THEN 'awarded' ELSE status END, awarded_at = CASE WHEN $3 = 0 THEN now() ELSE awarded_at END WHERE id = $1`, [id, req.id, left]);
  if (input.submit) await submitPurchaseRequest(tx, actor, req.id);
  await audit(tx, actor, { action: 'rfq.awarded', entityType: SUBJECT, entityId: id, facilityId: r.facility_id, data: { request: req.number, lines: picked.length, notLowest: input.awards.filter((a) => a.reason?.trim()).length } });
  return { requestId: req.id as string, requestNumber: req.number as string, linesLeft: left, rfq: await getRfq(tx, actor, id) };
}

/** Daily: tells the buyer when replies are due today or late, once a day each. */
export async function remindRfqs(tx: Tx, tenantId: string) {
  const rows = await many(tx, `SELECT r.id, r.number, r.title, r.created_by, r.respond_by, (current_date - r.respond_by) AS late,
      (SELECT string_agg(s.name, ', ') FROM rfq_invite i JOIN supplier s ON s.id = i.supplier_id WHERE i.rfq_id = r.id AND i.status = 'invited') AS waiting
    FROM rfq r WHERE r.status = 'sent' AND r.respond_by <= current_date AND EXISTS (SELECT 1 FROM rfq_invite i WHERE i.rfq_id = r.id AND i.status = 'invited')`);
  for (const r of rows) {
    await notify(tx, tenantId, [r.created_by], { kind: 'reminder.review_due', title: r.late > 0 ? `${r.number} replies are ${r.late} day${r.late === 1 ? '' : 's'} late: still waiting for ${r.waiting}` : `${r.number} replies are due today; waiting for ${r.waiting}`,
      link: `/purchasing/rfq/${r.id}`, subjectType: 'rfq', subjectId: r.id, dedupeKey: `rfq-due:${r.id}:${new Date().toISOString().slice(0, 10)}` });
  }
  return rows.length;
}

/** The request letter as a PDF for the buyer to attach to their own email. */
export async function renderRfqPdf(tx: Tx, actor: Actor, id: string): Promise<Buffer> {
  const g = await getRfq(tx, actor, id);
  const doc = new PDFDocument({ size: 'LETTER', margin: 48, info: { Title: `Request for quote ${g.number}` } });
  const chunks: Buffer[] = []; doc.on('data', (b: Buffer) => chunks.push(b));
  const done = new Promise<Buffer>((res) => doc.on('end', () => res(Buffer.concat(chunks))));
  const m = 48, W = doc.page.width - 2 * m; const t = (s: unknown) => pdfText(String(s ?? ''));
  const co = (await one(tx, 'SELECT name FROM tenant'))?.name ?? '';
  doc.fillColor(TOKENS.accent).font(TOKENS.fontBold).fontSize(9).text('REQUEST FOR QUOTE', m, m, { characterSpacing: 1.2 });
  doc.fillColor(TOKENS.ink).font(TOKENS.fontBold).fontSize(22).text(g.number, m, m + 14);
  doc.font(TOKENS.font).fontSize(10).fillColor(TOKENS.muted).text(t(`${co} · ${g.title}`), m, m + 44);
  doc.fillColor(TOKENS.ink).fontSize(10).text(t(`Please reply with unit price, lead time in days, minimum order quantity and how long the price is valid, for each line below${g.respond_by ? `, by ${new Date(g.respond_by).toISOString().slice(0, 10)}` : ''}.${g.needed_by ? ` We need the goods by ${new Date(g.needed_by).toISOString().slice(0, 10)}.` : ''} Add freight to us and your payment terms.`), m, m + 66, { width: W });
  let y = m + 112;
  doc.font(TOKENS.fontBold).fontSize(8.5).fillColor(TOKENS.muted); doc.text('#', m, y, { width: 24 }); doc.text('Item', m + 28, y, { width: 340 }); doc.text('Qty', m + 372, y, { width: 60, align: 'right' }); doc.text('Unit', m + 436, y, { width: 50 });
  y += 14; doc.moveTo(m, y).lineTo(m + W, y).lineWidth(0.8).strokeColor(TOKENS.ink).stroke(); y += 6;
  doc.font(TOKENS.font).fontSize(9.5).fillColor(TOKENS.ink);
  for (const l of g.lines) {
    const h = doc.heightOfString(t(l.description), { width: 340 });
    if (y + h > doc.page.height - 100) { doc.addPage(); y = m; }
    doc.text(String(l.line_no), m, y, { width: 24 }); doc.text(t(l.description), m + 28, y, { width: 340 }); doc.text(String(Number(l.qty)), m + 372, y, { width: 60, align: 'right' }); doc.text(t(l.uom ?? ''), m + 436, y, { width: 50 });
    y += h + 6;
  }
  if (g.notes) doc.fillColor(TOKENS.muted).fontSize(9).text(t(`Notes: ${g.notes}`), m, y + 8, { width: W });
  doc.fontSize(8).fillColor(TOKENS.muted).text('This is a request for quotation, not an order.', m, doc.page.height - 70, { width: W });
  doc.end();
  return done;
}
