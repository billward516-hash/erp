import PDFDocument from 'pdfkit';
import type { Actor } from '../../platform/auth/actor.js';
import { can, requirePermission } from '../../platform/auth/actor.js';
import { audit } from '../../platform/audit/audit.js';
import type { Tx } from '../../platform/db/tx.js';
import { many, nextSequence, one } from '../../platform/db/tx.js';
import { conflict, forbidden, invalid, notFound } from '../../platform/errors.js';
import { notify } from '../../platform/notify/notify.js';
import { TOKENS } from '../reporting/render/format.js';
import { pdfText } from '../reporting/render/pdf.js';

/**
 * Change notices (SC-006 B): engineering change notices and the notifications that go with a change (product change, supplier change,
 * deviation, waiver, bulletin). A notice says what changed and from when, and lists who must be told: colleagues, customers, suppliers
 * or anyone else. Each recipient is tracked from sent to acknowledged, with how and by whom. Colleagues are notified in the app and
 * acknowledge there; for outside parties the notice is a PDF the sender attaches to their own email, and the acknowledgement is
 * recorded by a colleague ("confirmed by email on 12 Nov"), because there is no portal.
 */
export const NOTICE_KINDS = ['ecn', 'pcn', 'supplier_change', 'deviation', 'waiver', 'bulletin', 'other'] as const;
export const KIND_LABEL: Record<string, string> = { ecn: 'Engineering change notice', pcn: 'Product change notice', supplier_change: 'Supplier change', deviation: 'Deviation', waiver: 'Waiver', bulletin: 'Bulletin', other: 'Notice' };
const SUBJECT = 'change_notice';
const PREFIX: Record<string, string> = { ecn: 'ECN', pcn: 'PCN', supplier_change: 'SCN', deviation: 'DEV', waiver: 'WVR', bulletin: 'BUL', other: 'NTC' };
const today = () => new Date().toISOString().slice(0, 10);
const link = (id: string) => `/changes/notices/${id}`;

export interface RecipientInput { partyType: 'user' | 'customer' | 'supplier' | 'other'; userId?: string | null; customerId?: string | null; supplierId?: string | null; name?: string | null; email?: string | null; requiresAck?: boolean }
export interface NoticeInput {
  facilityId: string; kind: (typeof NOTICE_KINDS)[number]; title: string; summary: string; whatChanged?: string | null; effectiveOn?: string | null; ackDueOn?: string | null;
  changeId?: string | null; documentId?: string | null; partId?: string | null; ownerUserId?: string | null; recipients?: RecipientInput[];
}

async function lock(tx: Tx, id: string) {
  const n = await one(tx, 'SELECT * FROM change_notice WHERE id = $1 FOR UPDATE', [id]);
  if (!n) throw notFound('change notice');
  return n;
}

async function resolveRecipient(tx: Tx, r: RecipientInput) {
  if (r.partyType === 'user') {
    const u = r.userId ? await one(tx, `SELECT id, display_name, email FROM app_user WHERE id = $1 AND status = 'active'`, [r.userId]) : null;
    if (!u) throw invalid('choose an active colleague');
    return { name: u.display_name as string, email: u.email as string | null, userId: u.id as string, customerId: null, supplierId: null };
  }
  if (r.partyType === 'customer') {
    const c = r.customerId ? await one(tx, 'SELECT id, name FROM customer WHERE id = $1', [r.customerId]) : null;
    if (!c) throw invalid('choose a customer');
    return { name: c.name as string, email: r.email ?? null, userId: null, customerId: c.id as string, supplierId: null };
  }
  if (r.partyType === 'supplier') {
    const s = r.supplierId ? await one(tx, 'SELECT id, name FROM supplier WHERE id = $1', [r.supplierId]) : null;
    if (!s) throw invalid('choose a supplier');
    return { name: s.name as string, email: r.email ?? null, userId: null, customerId: null, supplierId: s.id as string };
  }
  if (!r.name?.trim()) throw invalid('name the recipient');
  return { name: r.name.trim(), email: r.email ?? null, userId: null, customerId: null, supplierId: null };
}

export async function addRecipient(tx: Tx, actor: Actor, noticeId: string, r: RecipientInput) {
  const n = await lock(tx, noticeId);
  requirePermission(actor, 'moc.manage', n.facility_id);
  if (['closed', 'cancelled'].includes(n.status)) throw conflict(`the notice is ${n.status}`);
  const who = await resolveRecipient(tx, r);
  if (await one(tx, 'SELECT 1 FROM change_notice_recipient WHERE notice_id = $1 AND lower(name) = lower($2)', [noticeId, who.name])) throw conflict(`${who.name} is already on the list`);
  const row = await one(tx, `INSERT INTO change_notice_recipient (tenant_id, notice_id, party_type, user_id, customer_id, supplier_id, name, email, requires_ack)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`, [actor.tenantId, noticeId, r.partyType, who.userId, who.customerId, who.supplierId, who.name, who.email, r.requiresAck ?? true]);
  // A colleague added to a notice already issued is told at once.
  if (n.status === 'issued' && who.userId) {
    await tx.query('UPDATE change_notice_recipient SET sent_on = current_date, sent_by = $2 WHERE id = $1', [row.id, actor.userId]);
    await notify(tx, actor.tenantId, [who.userId], { kind: 'moc.notice', title: `${n.number}: ${n.title}`, body: n.summary, link: link(noticeId), subjectType: SUBJECT, subjectId: noticeId, dedupeKey: `cn-issued:${noticeId}:${who.userId}` }, actor.userId);
  }
  await audit(tx, actor, { action: 'change_notice.recipient_added', entityType: SUBJECT, entityId: noticeId, facilityId: n.facility_id, data: { name: who.name, partyType: r.partyType } });
  return row;
}

export async function createNotice(tx: Tx, actor: Actor, input: NoticeInput) {
  requirePermission(actor, 'moc.manage', input.facilityId);
  if (!input.title.trim() || !input.summary.trim()) throw invalid('give the notice a title and a summary');
  if (input.ackDueOn && input.effectiveOn && input.ackDueOn > input.effectiveOn) throw invalid('acknowledgements are due before the change takes effect');
  if (input.changeId && !(await one(tx, 'SELECT 1 FROM moc_change WHERE id = $1', [input.changeId]))) throw invalid('change not found');
  const owner = input.ownerUserId ?? actor.userId;
  const number = `${PREFIX[input.kind]}-${String(await nextSequence(tx, actor.tenantId, `notice_${input.kind}`)).padStart(5, '0')}`;
  const n = await one(tx, `INSERT INTO change_notice (tenant_id, facility_id, number, kind, title, summary, what_changed, effective_on, ack_due_on, change_id, document_id, part_id, owner_user_id, created_by)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING *`,
  [actor.tenantId, input.facilityId, number, input.kind, input.title.trim(), input.summary.trim(), input.whatChanged?.trim() || null, input.effectiveOn ?? null, input.ackDueOn ?? null,
    input.changeId ?? null, input.documentId ?? null, input.partId ?? null, owner, actor.userId]);
  for (const r of input.recipients ?? []) await addRecipient(tx, actor, n.id, r);
  await audit(tx, actor, { action: 'change_notice.created', entityType: SUBJECT, entityId: n.id, facilityId: n.facility_id, data: { number, kind: input.kind } });
  return n;
}

export async function updateNotice(tx: Tx, actor: Actor, id: string, patch: Partial<Pick<NoticeInput, 'title' | 'summary' | 'whatChanged' | 'effectiveOn' | 'ackDueOn'>>) {
  const n = await lock(tx, id);
  requirePermission(actor, 'moc.manage', n.facility_id);
  if (n.status !== 'draft') throw conflict('an issued notice is not edited; cancel it and issue a corrected one');
  await tx.query(`UPDATE change_notice SET title = coalesce($2, title), summary = coalesce($3, summary), what_changed = CASE WHEN $4 THEN $5 ELSE what_changed END,
      effective_on = CASE WHEN $6 THEN $7 ELSE effective_on END, ack_due_on = CASE WHEN $8 THEN $9 ELSE ack_due_on END WHERE id = $1`,
  [id, patch.title?.trim() || null, patch.summary?.trim() || null, patch.whatChanged !== undefined, patch.whatChanged ?? null, patch.effectiveOn !== undefined, patch.effectiveOn ?? null, patch.ackDueOn !== undefined, patch.ackDueOn ?? null]);
  return getNotice(tx, actor, id);
}

export async function removeRecipient(tx: Tx, actor: Actor, noticeId: string, recipientId: string) {
  const n = await lock(tx, noticeId);
  requirePermission(actor, 'moc.manage', n.facility_id);
  if (n.status !== 'draft') throw conflict('recipients of an issued notice stay on the record');
  if (!(await one(tx, 'DELETE FROM change_notice_recipient WHERE id = $1 AND notice_id = $2 RETURNING id', [recipientId, noticeId]))) throw notFound('recipient');
}

/** Issues the notice: colleagues are notified now; outside recipients are marked sent when the sender confirms they sent the PDF. */
export async function issueNotice(tx: Tx, actor: Actor, id: string) {
  const n = await lock(tx, id);
  requirePermission(actor, 'moc.manage', n.facility_id);
  if (n.status !== 'draft') throw conflict(`the notice is ${n.status}`);
  const rs = await many(tx, 'SELECT * FROM change_notice_recipient WHERE notice_id = $1', [id]);
  if (!rs.length) throw invalid('add at least one recipient before issuing');
  await tx.query(`UPDATE change_notice SET status = 'issued', issued_at = now() WHERE id = $1`, [id]);
  const users = rs.filter((r) => r.user_id);
  await tx.query(`UPDATE change_notice_recipient SET sent_on = current_date, sent_by = $2 WHERE notice_id = $1 AND user_id IS NOT NULL`, [id, actor.userId]);
  await notify(tx, actor.tenantId, users.map((r) => r.user_id), { kind: 'moc.notice', title: `${n.number}: ${n.title}`, body: `${n.summary}${n.ack_due_on ? ` Please acknowledge by ${n.ack_due_on.toISOString?.().slice(0, 10) ?? n.ack_due_on}.` : ''}`,
    link: link(id), subjectType: SUBJECT, subjectId: id, dedupeKey: `cn-issued:${id}` }, actor.userId);
  await audit(tx, actor, { action: 'change_notice.issued', entityType: SUBJECT, entityId: id, facilityId: n.facility_id, data: { number: n.number, recipients: rs.length } });
  return getNotice(tx, actor, id);
}

/** The sender confirms they sent the notice (PDF by email, post or in person) to an outside recipient. */
export async function markSent(tx: Tx, actor: Actor, noticeId: string, recipientId: string, input: { sentOn?: string | null } = {}) {
  const n = await lock(tx, noticeId);
  requirePermission(actor, 'moc.manage', n.facility_id);
  if (n.status !== 'issued') throw conflict(`the notice is ${n.status}`);
  const sentOn = input.sentOn ?? today();
  if (sentOn > today()) throw invalid('the sent date cannot be in the future');
  if (!(await one(tx, 'UPDATE change_notice_recipient SET sent_on = $3, sent_by = $4 WHERE id = $1 AND notice_id = $2 RETURNING id', [recipientId, noticeId, sentOn, actor.userId]))) throw notFound('recipient');
  await audit(tx, actor, { action: 'change_notice.sent', entityType: SUBJECT, entityId: noticeId, facilityId: n.facility_id, data: { recipientId, sentOn } });
}

/**
 * Acknowledgement. A colleague acknowledges their own line in the app; anyone with change authority records one for another
 * colleague or an outside party, saying who confirmed and how.
 */
export async function acknowledge(tx: Tx, actor: Actor, noticeId: string, recipientId: string, input: { method?: 'in_app' | 'email' | 'phone' | 'signed' | 'other'; byName?: string | null; on?: string | null; note?: string | null } = {}) {
  const n = await lock(tx, noticeId);
  if (n.status !== 'issued') throw conflict(`the notice is ${n.status}`);
  const r = await one(tx, 'SELECT * FROM change_notice_recipient WHERE id = $1 AND notice_id = $2 FOR UPDATE', [recipientId, noticeId]);
  if (!r) throw notFound('recipient');
  const own = r.user_id === actor.userId;
  if (!own) { if (!can(actor, 'moc.manage', n.facility_id)) throw forbidden('moc.manage'); if (r.user_id && !input.method) throw invalid('say how the colleague confirmed'); }
  if (r.ack_on) throw conflict(`${r.name} has already acknowledged`);
  const method = own ? 'in_app' : input.method ?? 'email';
  const on = input.on ?? today();
  if (on > today()) throw invalid('the acknowledgement date cannot be in the future');
  const by = own ? actor.displayName ?? r.name : input.byName?.trim();
  if (!by) throw invalid('say who at the recipient confirmed');
  await tx.query(`UPDATE change_notice_recipient SET ack_on = $2, ack_by_name = $3, ack_method = $4, ack_note = $5, recorded_by = $6, sent_on = coalesce(sent_on, $2) WHERE id = $1`,
    [recipientId, on, by, method, input.note?.trim() || null, actor.userId]);
  await audit(tx, actor, { action: 'change_notice.acknowledged', entityType: SUBJECT, entityId: noticeId, facilityId: n.facility_id, data: { recipient: r.name, method, by, on } });
  // The owner hears when the last required acknowledgement arrives.
  const left = await one(tx, 'SELECT count(*)::int AS n FROM change_notice_recipient WHERE notice_id = $1 AND requires_ack AND ack_on IS NULL', [noticeId]);
  if (left?.n === 0) await notify(tx, actor.tenantId, [n.owner_user_id], { kind: 'moc.notice', title: `${n.number}: everyone has acknowledged`, body: 'You can close the notice.', link: link(noticeId), subjectType: SUBJECT, subjectId: noticeId, dedupeKey: `cn-complete:${noticeId}` });
}

export async function closeNotice(tx: Tx, actor: Actor, id: string, note?: string | null) {
  const n = await lock(tx, id);
  requirePermission(actor, 'moc.manage', n.facility_id);
  if (n.status !== 'issued') throw conflict(`the notice is ${n.status}`);
  const left = await one(tx, 'SELECT count(*)::int AS n FROM change_notice_recipient WHERE notice_id = $1 AND requires_ack AND ack_on IS NULL', [id]);
  if (left!.n > 0 && (note?.trim().length ?? 0) < 3) throw invalid(`${left!.n} recipient(s) have not acknowledged; say why the notice is being closed anyway`);
  await tx.query(`UPDATE change_notice SET status = 'closed', closed_at = now(), close_note = $2 WHERE id = $1`, [id, note?.trim() || null]);
  await audit(tx, actor, { action: 'change_notice.closed', entityType: SUBJECT, entityId: id, facilityId: n.facility_id, data: { outstanding: left!.n, note: note ?? null } });
  return getNotice(tx, actor, id);
}

export async function cancelNotice(tx: Tx, actor: Actor, id: string, reason: string) {
  const n = await lock(tx, id);
  requirePermission(actor, 'moc.manage', n.facility_id);
  if (['closed', 'cancelled'].includes(n.status)) throw conflict(`the notice is ${n.status}`);
  if (reason.trim().length < 3) throw invalid('give a reason');
  await tx.query(`UPDATE change_notice SET status = 'cancelled', closed_at = now(), close_note = $2 WHERE id = $1`, [id, reason.trim()]);
  await audit(tx, actor, { action: 'change_notice.cancelled', entityType: SUBJECT, entityId: id, facilityId: n.facility_id, data: { reason } });
}

const SELECT = `SELECT n.*, f.code AS facility_code, u.display_name AS owner_name, c.number AS change_number, d.doc_number, p.part_number,
    (n.status = 'issued' AND n.ack_due_on < current_date AND EXISTS (SELECT 1 FROM change_notice_recipient r WHERE r.notice_id = n.id AND r.requires_ack AND r.ack_on IS NULL)) AS overdue,
    (SELECT count(*)::int FROM change_notice_recipient r WHERE r.notice_id = n.id) AS recipients,
    (SELECT count(*)::int FROM change_notice_recipient r WHERE r.notice_id = n.id AND r.requires_ack AND r.ack_on IS NULL) AS outstanding,
    (SELECT count(*)::int FROM change_notice_recipient r WHERE r.notice_id = n.id AND r.requires_ack AND r.ack_on IS NOT NULL) AS acknowledged
  FROM change_notice n JOIN facility f ON f.id = n.facility_id JOIN app_user u ON u.id = n.owner_user_id LEFT JOIN moc_change c ON c.id = n.change_id
  LEFT JOIN document d ON d.id = n.document_id LEFT JOIN part p ON p.id = n.part_id`;

export async function listNotices(tx: Tx, actor: Actor, q: { status?: string; kind?: string; outstanding?: boolean; mine?: boolean; changeId?: string } = {}) {
  requirePermission(actor, 'moc.view');
  const rows = await many(tx, `${SELECT} ORDER BY (n.status = 'issued') DESC, n.created_at DESC LIMIT 300`);
  const mine = q.mine ? new Set((await many(tx, 'SELECT notice_id FROM change_notice_recipient WHERE user_id = $1 AND ack_on IS NULL AND requires_ack', [actor.userId])).map((r) => r.notice_id)) : null;
  return rows.filter((r) => can(actor, 'moc.view', r.facility_id) && (!q.status || r.status === q.status) && (!q.kind || r.kind === q.kind) && (!q.changeId || r.change_id === q.changeId) && (!q.outstanding || r.outstanding > 0 && r.status === 'issued') && (!mine || mine.has(r.id)));
}

export async function getNotice(tx: Tx, actor: Actor, id: string) {
  const n = await one(tx, `${SELECT} WHERE n.id = $1`, [id]);
  if (!n) throw notFound('change notice');
  requirePermission(actor, 'moc.view', n.facility_id);
  const recipients = await many(tx, `SELECT r.*, (r.requires_ack AND r.ack_on IS NULL AND $2::date IS NOT NULL AND $2::date < current_date) AS overdue FROM change_notice_recipient r WHERE r.notice_id = $1 ORDER BY r.party_type, r.name`, [id, n.ack_due_on]);
  return { ...n, kindLabel: KIND_LABEL[n.kind], recipientList: recipients, mineToAcknowledge: recipients.find((r) => r.user_id === actor.userId && r.requires_ack && !r.ack_on)?.id ?? null };
}

/** Daily: colleagues two days before and on the due date and every third day after; the owner gets the outstanding outside parties. */
export async function remindNotices(tx: Tx, tenantId: string) {
  const rows = await many(tx, `SELECT r.id, r.user_id, r.name, r.party_type, n.id AS notice_id, n.number, n.title, n.owner_user_id, (n.ack_due_on - current_date) AS left
    FROM change_notice_recipient r JOIN change_notice n ON n.id = r.notice_id WHERE n.status = 'issued' AND r.requires_ack AND r.ack_on IS NULL AND n.ack_due_on IS NOT NULL AND n.ack_due_on <= current_date + 2`);
  const day = today(); let sent = 0;
  const external = new Map<string, { n: any; names: string[] }>();
  for (const r of rows) {
    const late = -r.left;
    const due = r.left === 2 || r.left === 0 || (late > 0 && late % 3 === 0);
    if (!due) continue;
    if (r.user_id) {
      sent += await notify(tx, tenantId, [r.user_id], { kind: 'reminder.review_due', title: late > 0 ? `${r.number} acknowledgement is ${late} days late` : r.left === 0 ? `${r.number} acknowledgement is due today` : `${r.number} acknowledgement is due in 2 days`,
        body: r.title, link: link(r.notice_id), subjectType: SUBJECT, subjectId: r.notice_id, dedupeKey: `cn-ack:${r.id}:${day}` });
    } else { const g = external.get(r.notice_id) ?? { n: r, names: [] }; g.names.push(r.name); external.set(r.notice_id, g); }
  }
  for (const { n, names } of external.values()) {
    sent += await notify(tx, tenantId, [n.owner_user_id], { kind: 'reminder.review_due', title: `${n.number}: still waiting for ${names.join(', ')}`, body: n.left < 0 ? `${-n.left} days past the acknowledgement date.` : 'Acknowledgement is due soon.',
      link: link(n.notice_id), subjectType: SUBJECT, subjectId: n.notice_id, dedupeKey: `cn-ext:${n.notice_id}:${day}` });
  }
  return sent;
}

export async function noticePdf(tx: Tx, actor: Actor, id: string): Promise<Buffer> {
  const n = await getNotice(tx, actor, id);
  const company = (await one(tx, 'SELECT name FROM tenant'))?.name ?? '';
  const doc = new PDFDocument({ size: 'LETTER', margin: 54, bufferPages: true, info: { Title: `${n.kindLabel} ${n.number}` } });
  const chunks: Buffer[] = []; doc.on('data', (b: Buffer) => chunks.push(b));
  const done = new Promise<Buffer>((res) => doc.on('end', () => res(Buffer.concat(chunks))));
  const m = 54, W = doc.page.width - 2 * m; const t = (s: unknown) => pdfText(String(s ?? ''));
  const d = (v: unknown) => (v ? new Date(v as string).toISOString().slice(0, 10) : '—');
  doc.fillColor(TOKENS.ink).font(TOKENS.fontBold).fontSize(14).text(t(company), m, m);
  doc.fillColor(TOKENS.accent).fontSize(9).text(t(n.kindLabel.toUpperCase()), m, m + 20, { characterSpacing: 1.2 });
  doc.fillColor(TOKENS.ink).fontSize(20).text(t(n.number), m, m + 34);
  doc.font(TOKENS.fontBold).fontSize(13).text(t(n.title), m, m + 66, { width: W });
  let y = doc.y + 10;
  doc.font(TOKENS.font).fontSize(9).fillColor(TOKENS.muted).text(t(`Issued ${d(n.issued_at)} by ${n.owner_name}${n.effective_on ? ` · effective ${d(n.effective_on)}` : ''}${n.change_number ? ` · change ${n.change_number}` : ''}${n.doc_number ? ` · document ${n.doc_number}` : ''}${n.part_number ? ` · part ${n.part_number}` : ''}`), m, y, { width: W });
  y = doc.y + 14;
  const section = (title: string, body?: string | null) => { if (!body) return; doc.fillColor(TOKENS.muted).font(TOKENS.fontBold).fontSize(8).text(title.toUpperCase(), m, y, { characterSpacing: 0.9 }); doc.fillColor(TOKENS.ink).font(TOKENS.font).fontSize(10.5).text(t(body), m, y + 12, { width: W }); y = doc.y + 14; };
  section('Summary', n.summary); section('What is changing', n.what_changed);
  if (n.ack_due_on) section('Please confirm receipt', `Reply to the sender to acknowledge this notice by ${d(n.ack_due_on)}. Say who confirmed.`);
  section('Sent to', n.recipientList.map((r: any) => r.name).join(', '));
  doc.end();
  return done;
}
