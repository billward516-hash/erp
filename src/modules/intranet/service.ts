import type { Actor } from '../../platform/auth/actor.js';
import { can, requirePermission } from '../../platform/auth/actor.js';
import { audit } from '../../platform/audit/audit.js';
import type { Tx } from '../../platform/db/tx.js';
import { many, one } from '../../platform/db/tx.js';
import { conflict, invalid, notFound } from '../../platform/errors.js';
import { notify } from '../../platform/notify/notify.js';

/**
 * Intranet (docs/ARCHITECTURE.md §12v, D-130): announcements and events, quick links, the people directory and search
 * across what the user may see. Announcements reach people at their sites (or everyone); posting needs
 * `announcements.post`.
 */
const appliesTo = (actor: Actor, facilityId: string | null) => facilityId == null || actor.grants.some((g) => g.facilityId === null || g.facilityId === facilityId);
const today = () => new Date().toISOString().slice(0, 10);

export async function listAnnouncements(tx: Tx, actor: Actor, q: { all?: boolean } = {}) {
  const rows = await many(tx, `SELECT a.id, a.facility_id, f.code AS facility_code, a.title, a.body, a.kind, a.event_on, a.pinned, a.expires_on, a.published_at, a.withdrawn_at,
      u.display_name AS author_name
    FROM announcement a JOIN app_user u ON u.id = a.author_id LEFT JOIN facility f ON f.id = a.facility_id
    WHERE ($1 OR (a.withdrawn_at IS NULL AND (a.expires_on IS NULL OR a.expires_on >= current_date)))
    ORDER BY a.pinned DESC, a.published_at DESC LIMIT 100`, [!!q.all && can(actor, 'announcements.post')]);
  return rows.filter((r) => appliesTo(actor, r.facility_id));
}

/** Events and holidays from today on, soonest first. */
export async function upcoming(tx: Tx, actor: Actor) {
  const rows = await many(tx, `SELECT a.id, a.facility_id, f.code AS facility_code, a.title, a.kind, a.event_on FROM announcement a LEFT JOIN facility f ON f.id = a.facility_id
    WHERE a.withdrawn_at IS NULL AND a.event_on >= current_date ORDER BY a.event_on, a.title LIMIT 50`);
  return rows.filter((r) => appliesTo(actor, r.facility_id)).slice(0, 8);
}

export async function postAnnouncement(tx: Tx, actor: Actor, input: { title: string; body: string; kind?: 'news' | 'event' | 'safety' | 'people' | 'it'; facilityId?: string | null;
  eventOn?: string | null; pinned?: boolean; expiresOn?: string | null; notifyEveryone?: boolean }) {
  requirePermission(actor, 'announcements.post', input.facilityId ?? null);
  if (!input.title?.trim() || !input.body?.trim()) throw invalid('an announcement needs a title and a message');
  if (input.kind === 'event' && !input.eventOn) throw invalid('an event needs its date');
  if (input.expiresOn && input.expiresOn < today()) throw invalid('the end date is in the past');
  const a = await one(tx, `INSERT INTO announcement (tenant_id, facility_id, title, body, kind, event_on, pinned, expires_on, author_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
    [actor.tenantId, input.facilityId ?? null, input.title.trim(), input.body.trim(), input.kind ?? 'news', input.eventOn ?? null, input.pinned ?? false, input.expiresOn ?? null, actor.userId]);
  // Important notices (safety, or when asked) also reach the bell; ordinary news waits on the home page.
  if (input.notifyEveryone || input.kind === 'safety') {
    const people = (await many(tx, `SELECT DISTINCT u.id FROM app_user u JOIN user_role_scope s ON s.user_id = u.id
      WHERE u.status = 'active' AND ($1::uuid IS NULL OR s.facility_id IS NULL OR s.facility_id = $1)`, [a.facility_id])).map((r) => r.id);
    await notify(tx, actor.tenantId, people, { kind: 'announcement', title: a.title, body: a.body.slice(0, 300), link: '/', subjectType: 'announcement', subjectId: a.id, dedupeKey: `announcement:${a.id}` }, actor.userId);
  }
  await audit(tx, actor, { action: 'announcement.posted', entityType: 'announcement', entityId: a.id, facilityId: a.facility_id, data: { title: a.title, kind: a.kind } });
  return a;
}

export async function withdrawAnnouncement(tx: Tx, actor: Actor, id: string) {
  const a = await one(tx, 'SELECT * FROM announcement WHERE id = $1 FOR UPDATE', [id]);
  if (!a) throw notFound('announcement');
  requirePermission(actor, 'announcements.post', a.facility_id);
  if (a.withdrawn_at) throw conflict('already withdrawn');
  await tx.query('UPDATE announcement SET withdrawn_at = now(), pinned = false WHERE id = $1', [id]);
  await audit(tx, actor, { action: 'announcement.withdrawn', entityType: 'announcement', entityId: id, facilityId: a.facility_id, data: {} });
}

export async function listQuickLinks(tx: Tx) {
  return many(tx, 'SELECT id, title, url, description, sort_order FROM quick_link ORDER BY sort_order, title');
}

export async function saveQuickLink(tx: Tx, actor: Actor, input: { id?: string; title: string; url: string; description?: string | null; sortOrder?: number }) {
  requirePermission(actor, 'announcements.post');
  const url = input.url.trim();
  if (!/^(https:\/\/[^\s]+|\/[^\s]*)$/.test(url)) throw invalid('a link must start with https:// (another site) or / (a page here)');
  const vals = [input.title.trim(), url, input.description ?? null, input.sortOrder ?? 100];
  const l = input.id ? await one(tx, 'UPDATE quick_link SET title = $2, url = $3, description = $4, sort_order = $5 WHERE id = $1 RETURNING *', [input.id, ...vals])
    : await one(tx, 'INSERT INTO quick_link (tenant_id, title, url, description, sort_order, created_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *', [actor.tenantId, ...vals, actor.userId]);
  if (!l) throw notFound('quick link');
  await audit(tx, actor, { action: 'quick_link.saved', entityType: 'quick_link', entityId: l.id, data: input });
  return l;
}

export async function deleteQuickLink(tx: Tx, actor: Actor, id: string) {
  requirePermission(actor, 'announcements.post');
  const r = await tx.query('DELETE FROM quick_link WHERE id = $1', [id]);
  if (!r.rowCount) throw notFound('quick link');
  await audit(tx, actor, { action: 'quick_link.deleted', entityType: 'quick_link', entityId: id, data: {} });
}

/** People directory: work contact details for everyone in the company, filtered by a search across name, title, team and site. */
export async function directory(tx: Tx, q: { search?: string; site?: string } = {}) {
  const s = q.search?.trim() ? `%${q.search.trim().toLowerCase()}%` : null;
  return many(tx, `SELECT * FROM people_directory() p
    WHERE ($1::text IS NULL OR lower(concat_ws(' ', p.name, p.job_title, p.department, p.site_code, p.site_name, p.email, p.office_location)) LIKE $1)
      AND ($2::text IS NULL OR p.site_code = $2)
    ORDER BY p.name LIMIT 500`, [s, q.site ?? null]);
}

/**
 * Search across the intranet: people, policies and announcements for everyone, and records the user may see (assets,
 * documents, work orders, customers, suppliers). Row-level security limits records to the user's sites.
 */
export async function search(tx: Tx, actor: Actor, text: string) {
  const t = text.trim();
  if (t.length < 2) return { query: t, groups: [] };
  const like = `%${t.toLowerCase()}%`;
  const groups: { kind: string; label: string; items: { title: string; detail: string | null; link: string }[] }[] = [];
  const add = (kind: string, label: string, items: { title: string; detail: string | null; link: string }[]) => { if (items.length) groups.push({ kind, label, items }); };
  // Features hidden from this user (D-149) are left out of search too.
  const off = new Set(actor.hiddenFeatures ?? []);
  if (!off.has('people')) add('people', 'People', (await directory(tx, { search: t })).slice(0, 8).map((p) => ({ title: p.name, detail: [p.job_title, p.department, p.site_code].filter(Boolean).join(' · ') || p.email, link: `/people?q=${encodeURIComponent(p.name)}` })));
  const pols = await many(tx, `SELECT p.id, p.number, p.title, p.facility_id FROM policy p JOIN policy_version v ON v.id = p.current_version_id
    WHERE p.archived_at IS NULL AND (lower(p.title) LIKE $1 OR lower(v.body) LIKE $1) ORDER BY p.title LIMIT 8`, [like]);
  if (!off.has('policies')) add('policies', 'Policies', pols.filter((p) => appliesTo(actor, p.facility_id)).map((p) => ({ title: p.title, detail: p.number, link: `/policies/${p.id}` })));
  const news = off.has('news') ? [] : await listAnnouncements(tx, actor);
  add('news', 'Announcements', news.filter((a) => `${a.title} ${a.body}`.toLowerCase().includes(t.toLowerCase())).slice(0, 5).map((a) => ({ title: a.title, detail: String(a.published_at instanceof Date ? a.published_at.toISOString() : a.published_at).slice(0, 10), link: '/' })));
  if (can(actor, 'assets.view') && !off.has('assets')) add('assets', 'Assets', (await many(tx, `SELECT id, asset_tag, name FROM asset WHERE lower(asset_tag || ' ' || name) LIKE $1 ORDER BY asset_tag LIMIT 8`, [like]))
    .map((a) => ({ title: `${a.asset_tag} ${a.name}`, detail: null, link: `/assets/${a.id}` })));
  if (can(actor, 'documents.view')) add('documents', 'Documents', (await many(tx, `SELECT id, doc_number, title FROM document WHERE current_version_id IS NOT NULL AND lower(doc_number || ' ' || title) LIKE $1 ORDER BY doc_number LIMIT 8`, [like]))
    .map((d) => ({ title: d.title, detail: d.doc_number, link: `/documents/${d.id}` })));
  if (can(actor, 'work_orders.view')) add('work_orders', 'Work orders', (await many(tx, `SELECT id, number, title, status FROM work_order WHERE lower(number || ' ' || title) LIKE $1 ORDER BY created_at DESC LIMIT 8`, [like]))
    .map((w) => ({ title: `${w.number} ${w.title}`, detail: w.status.replace(/_/g, ' '), link: `/work-orders/${w.id}` })));
  const customerPage = !off.has('crm') ? '/crm/customers' : can(actor, 'ar.view') ? '/receivables/customers' : null;
  if (can(actor, 'crm.view') && customerPage) add('customers', 'Customers', (await many(tx, `SELECT id, code, name FROM customer WHERE lower(code || ' ' || name) LIKE $1 ORDER BY name LIMIT 8`, [like]))
    .map((c) => ({ title: c.name, detail: c.code, link: `${customerPage}/${c.id}` })));
  if (can(actor, 'purchasing.view') && !off.has('purchasing')) add('suppliers', 'Suppliers', (await many(tx, `SELECT id, code, name FROM supplier WHERE lower(code || ' ' || name) LIKE $1 ORDER BY name LIMIT 8`, [like]))
    .map((s) => ({ title: s.name, detail: s.code, link: `/purchasing/suppliers/${s.id}` })));
  return { query: t, groups };
}
